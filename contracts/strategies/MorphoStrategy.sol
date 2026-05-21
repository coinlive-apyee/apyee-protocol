// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategy} from "./BaseStrategy.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title MorphoStrategy
/// @notice Adapter that supplies USDC into a MetaMorpho vault (ERC-4626 above Morpho Blue).
/// @dev MetaMorpho is itself an ERC-4626 vault, so this adapter is essentially a Vault-of-Vaults
///      shim. We deliberately target MetaMorpho rather than Morpho Blue directly because:
///        - MetaMorpho exposes ERC-4626 (no Morpho Blue MarketId arithmetic)
///        - Curators (Steakhouse, Gauntlet, Re7, ...) handle market allocation/risk
///        - Single integration covers many underlying Blue markets at once
///      `currentAPY()` returns 0 because MetaMorpho's APR is a weighted aggregate of underlying
///      Blue markets that's not easy to compute on-chain. The Keeper queries APY off-chain
///      (DeFiLlama / Morpho subgraph) for rebalancing decisions.
contract MorphoStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    /// @notice MetaMorpho vault contract for the (chain, asset) pairing (e.g. Steakhouse USDC).
    IERC4626 public immutable morphoVault;

    constructor(address vault_, address asset_, address morphoVault_, bytes32 strategyVersionHash_)
        BaseStrategy(vault_, asset_, strategyVersionHash_)
    {
        if (morphoVault_ == address(0)) revert Errors.ZeroAddress();
        morphoVault = IERC4626(morphoVault_);

        // The MetaMorpho vault's underlying must equal what our Vault expects.
        address vAsset = IERC4626(morphoVault_).asset();
        if (vAsset != asset_) revert Errors.AssetMismatch(asset_, vAsset);

        underlyingAsset.forceApprove(morphoVault_, type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────
    // BaseStrategy hooks
    // ─────────────────────────────────────────────────────────────

    function _deposit(uint256 amount) internal override {
        morphoVault.deposit(amount, address(this));
    }

    function _withdraw(uint256 amount) internal override returns (uint256 withdrawn) {
        // ERC-4626 withdraw transfers exactly `amount` of the underlying or reverts.
        // We diff our own underlying balance to capture the actual amount (handles edge cases
        // where the curator can't fully serve due to liquidity constraints in Blue markets).
        uint256 balBefore = underlyingAsset.balanceOf(address(this));
        morphoVault.withdraw(amount, address(this), address(this));
        uint256 balAfter = underlyingAsset.balanceOf(address(this));
        withdrawn = balAfter - balBefore;
    }

    function _emergencyWithdraw() internal override returns (uint256 withdrawn) {
        uint256 shares = morphoVault.balanceOf(address(this));
        if (shares == 0) return 0;

        // redeem(shares) burns all our shares and sends back whatever underlying that converts to
        // — the natural "drain everything" call for ERC-4626.
        uint256 balBefore = underlyingAsset.balanceOf(address(this));
        morphoVault.redeem(shares, address(this), address(this));
        uint256 balAfter = underlyingAsset.balanceOf(address(this));
        withdrawn = balAfter - balBefore;
    }

    // ─────────────────────────────────────────────────────────────
    // IStrategy view methods
    // ─────────────────────────────────────────────────────────────

    /// @notice Underlying balance = our shares converted via the MetaMorpho's exchange rate.
    function balanceOf() external view override returns (uint256) {
        uint256 shares = morphoVault.balanceOf(address(this));
        if (shares == 0) return 0;
        return morphoVault.convertToAssets(shares);
    }

    /// @notice Returns 0. MetaMorpho APY is a weighted aggregate of underlying Blue markets;
    ///         compute off-chain (DeFiLlama / Morpho subgraph) and feed the Keeper there.
    function currentAPY() external pure override returns (uint256) {
        return 0;
    }

    /// @notice MetaMorpho auto-accrues into the vault token's exchange rate. Vault tracks
    ///         unrealized P&L itself via `lastRecordedBalance`.
    function harvestable() external pure override returns (uint256) {
        return 0;
    }
}
