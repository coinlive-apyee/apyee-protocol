// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategy} from "./BaseStrategy.sol";
import {IVToken} from "../interfaces/external/IVToken.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title VenusStrategy
/// @notice Adapter that supplies USDC to a Venus market (Compound V2 fork) on BNB Chain.
/// @dev Three things to handle that differ from Aave/Compound V3:
///        1. mint / redeem / redeemUnderlying return uint256 ERROR CODES, no revert on failure.
///           We must explicitly check the return and revert with `Errors.ProtocolCallFailed`.
///        2. `vToken.balanceOf` returns vTokens, not underlying — multiply by exchange rate.
///        3. `supplyRatePerBlock` returns per-BLOCK rate. BSC blocks ~3s →
///           BLOCKS_PER_YEAR = 365 days / 3s = 10_512_000 (constant for BSC mainnet only).
contract VenusStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    /// @notice Venus vToken (vUSDC on BNB Chain).
    IVToken public immutable vToken;

    /// @dev BSC mainnet block time ≈ 3 seconds → ~10.5M blocks per year.
    ///      Adjusts as BSC block time evolves; off-chain consumers can re-derive precisely.
    uint256 private constant BLOCKS_PER_YEAR = 10_512_000;

    /// @dev Compound V2 exchange-rate scaling factor (vToken × rate / 1e18 = underlying).
    uint256 private constant EXCHANGE_RATE_SCALE = 1e18;

    /// @dev Per-block rate × BLOCKS_PER_YEAR / 1e14 → APR in bps.
    uint256 private constant RATE_SCALE_TO_BPS = 1e14;

    constructor(address vault_, address asset_, address vToken_, bytes32 strategyVersionHash_)
        BaseStrategy(vault_, asset_, strategyVersionHash_)
    {
        if (vToken_ == address(0)) revert Errors.ZeroAddress();
        vToken = IVToken(vToken_);

        // Sanity-check at deploy: vToken's underlying must equal what the Vault expects.
        address vUnderlying = IVToken(vToken_).underlying();
        if (vUnderlying != asset_) revert Errors.AssetMismatch(asset_, vUnderlying);

        // Infinite approval. Venus vTokens are immutable + audited; race-condition-free.
        underlyingAsset.forceApprove(vToken_, type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────
    // BaseStrategy hooks
    // ─────────────────────────────────────────────────────────────

    function _deposit(uint256 amount) internal override {
        uint256 errCode = vToken.mint(amount);
        if (errCode != 0) revert Errors.ProtocolCallFailed(errCode);
    }

    function _withdraw(uint256 amount) internal override returns (uint256 withdrawn) {
        // redeemUnderlying takes the underlying amount directly. Returns 0 on success.
        uint256 balBefore = underlyingAsset.balanceOf(address(this));
        uint256 errCode = vToken.redeemUnderlying(amount);
        if (errCode != 0) revert Errors.ProtocolCallFailed(errCode);
        uint256 balAfter = underlyingAsset.balanceOf(address(this));
        withdrawn = balAfter - balBefore;
    }

    function _emergencyWithdraw() internal override returns (uint256 withdrawn) {
        // Venus has no `type(uint256).max` shortcut — burn the full vToken balance instead.
        uint256 vBal = vToken.balanceOf(address(this));
        if (vBal == 0) return 0;

        uint256 balBefore = underlyingAsset.balanceOf(address(this));
        uint256 errCode = vToken.redeem(vBal);
        if (errCode != 0) revert Errors.ProtocolCallFailed(errCode);
        uint256 balAfter = underlyingAsset.balanceOf(address(this));
        withdrawn = balAfter - balBefore;
    }

    // ─────────────────────────────────────────────────────────────
    // IStrategy view methods
    // ─────────────────────────────────────────────────────────────

    /// @notice Underlying balance — vToken × exchangeRateStored / 1e18.
    /// @dev Uses the stored (snapshot) rate rather than the live rate, which is fine for
    ///      our purposes (Vault tracks unrealized P&L via `lastRecordedBalance`, not via
    ///      hyper-accurate per-call accrual). Off by ≤ 1 block of interest in worst case.
    function balanceOf() external view override returns (uint256) {
        uint256 vBal = vToken.balanceOf(address(this));
        if (vBal == 0) return 0;
        return (vBal * vToken.exchangeRateStored()) / EXCHANGE_RATE_SCALE;
    }

    function currentAPY() external view override returns (uint256) {
        uint256 perBlockRate = vToken.supplyRatePerBlock();
        return (perBlockRate * BLOCKS_PER_YEAR) / RATE_SCALE_TO_BPS;
    }

    /// @notice Venus auto-accrues into vToken via exchange rate growth — no on-strategy
    ///         harvest action. Vault tracks profit via `lastRecordedBalance`.
    function harvestable() external pure override returns (uint256) {
        return 0;
    }
}
