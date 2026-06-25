// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategy} from "./BaseStrategy.sol";
import {IFluidMerkleDistributor} from "../interfaces/external/IFluidMerkleDistributor.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title FluidStrategy
/// @notice Adapter that supplies USDC into a Fluid Lending fToken (ERC-4626 above Fluid's
///         Liquidity Layer).
/// @dev Fluid's lending subprotocol exposes a "pure supply-and-earn" ERC-4626 fToken (fUSDC)
///      backed by Instadapp's unified Liquidity Layer. From the Vault's perspective it's
///      identical to any other ERC-4626 yield vault — deposit gets fToken shares, withdraw
///      burns shares for the underlying. Different .sol file from MorphoStrategy purely for
///      clearer on-chain naming + auditability; the logic mirrors any standard ERC-4626
///      wrapper.
///
///      `currentAPY()` returns 0 because Fluid's supply rate is determined dynamically by
///      the Liquidity Layer's utilization curve. The Keeper queries APY off-chain (Fluid
///      resolver / DeFiLlama) for rebalancing decisions.
contract FluidStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    /// @notice Fluid Lending fToken for the (chain, asset) pairing (e.g. mainnet fUSDC).
    IERC4626 public immutable fluidVault;

    /// @notice V2.1 (Soken F-04): Fluid MerkleDistributor for FLUID rewards.
    ///         Ethereum: 0xF398E66B1273a34558AeBbEC550DccaF4AcC7714.
    ///         The distributor's `claim` enforces `msg.sender == recipient`, which is why
    ///         the strategy itself owns the claim entrypoint. `address(0)` opts out.
    IFluidMerkleDistributor public immutable fluidDistributor;

    /// @notice V2.1 (Soken F-04): FLUID reward token (Ethereum mainnet
    ///         0x6f40d4A6237C257fff2dB00FA0510DeEECd303eb, formerly INST).
    IERC20 public immutable rewardToken;

    constructor(
        address vault_,
        address asset_,
        address fluidVault_,
        address fluidDistributor_,
        address rewardToken_,
        address dexRouter_,
        bytes32 strategyVersionHash_
    )
        BaseStrategy(vault_, asset_, dexRouter_, strategyVersionHash_)
    {
        if (fluidVault_ == address(0)) revert Errors.ZeroAddress();
        fluidVault = IERC4626(fluidVault_);
        // Both reward params may be address(0) — opt-out for tests / chains where the
        // FLUID program is inactive (e.g. after the 2026-06-30 USDC/USDT rewards end date).
        fluidDistributor = IFluidMerkleDistributor(fluidDistributor_);
        rewardToken = IERC20(rewardToken_);

        // The fToken's underlying must equal what our Vault expects.
        address vAsset = IERC4626(fluidVault_).asset();
        if (vAsset != asset_) revert Errors.AssetMismatch(asset_, vAsset);

        underlyingAsset.forceApprove(fluidVault_, type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────
    // BaseStrategy hooks
    // ─────────────────────────────────────────────────────────────

    function _deposit(uint256 amount) internal override {
        fluidVault.deposit(amount, address(this));
    }

    function _withdraw(uint256 amount) internal override returns (uint256 withdrawn) {
        // ERC-4626 withdraw transfers exactly `amount` of the underlying or reverts.
        // Diff our own underlying balance to capture the actual amount (covers edge cases
        // where utilization spikes leave Liquidity Layer temporarily unable to fully serve).
        uint256 balBefore = underlyingAsset.balanceOf(address(this));
        fluidVault.withdraw(amount, address(this), address(this));
        uint256 balAfter = underlyingAsset.balanceOf(address(this));
        withdrawn = balAfter - balBefore;
    }

    function _emergencyWithdraw() internal override returns (uint256 withdrawn) {
        uint256 shares = fluidVault.balanceOf(address(this));
        if (shares == 0) return 0;

        // redeem(shares) burns all our shares and sends back whatever underlying that converts
        // to — the natural "drain everything" call for ERC-4626.
        uint256 balBefore = underlyingAsset.balanceOf(address(this));
        fluidVault.redeem(shares, address(this), address(this));
        uint256 balAfter = underlyingAsset.balanceOf(address(this));
        withdrawn = balAfter - balBefore;
    }

    // ─────────────────────────────────────────────────────────────
    // IStrategy view methods
    // ─────────────────────────────────────────────────────────────

    /// @notice Underlying balance = our shares converted via the fToken exchange rate.
    function balanceOf() external view override returns (uint256) {
        uint256 shares = fluidVault.balanceOf(address(this));
        if (shares == 0) return 0;
        return fluidVault.convertToAssets(shares);
    }

    /// @notice Returns 0. Fluid supply rate depends on the Liquidity Layer's utilization curve
    ///         and per-fToken rewards; query off-chain (Fluid resolver / DeFiLlama) for Keeper
    ///         rebalancing decisions.
    function currentAPY() external pure override returns (uint256) {
        return 0;
    }

    /// @notice fToken auto-accrues into the exchange rate. Vault tracks unrealized P&L itself
    ///         via `lastRecordedBalance`.
    function harvestable() external pure override returns (uint256) {
        return 0;
    }

    // ─────────────────────────────────────────────────────────────
    // V2.1 (Soken F-04) — Fluid FLUID merkle claim + auto-compound
    // ─────────────────────────────────────────────────────────────

    /// @notice Keeper-only: claim FLUID rewards from the Fluid MerkleDistributor for our
    ///         fToken position, swap FLUID → USDC, and re-supply into Fluid.
    /// @dev    The distributor enforces `msg.sender == recipient` — that's why this lives
    ///         inside the strategy (rather than letting the Keeper call the distributor
    ///         directly). `recipient` is hardcoded to `address(this)` so a malicious
    ///         off-chain Keeper cannot redirect rewards elsewhere.
    ///         No-ops gracefully if either reward address was set to 0 at deploy.
    /// @param cumulativeAmount  Cumulative claimable for this position (Keeper-supplied).
    /// @param positionType      Distributor position-type discriminator.
    /// @param positionId        Distributor position-id (typically the fToken address).
    /// @param cycle             Reward cycle id.
    /// @param merkleProof       Merkle proof validating the cumulative claim.
    /// @param metadata          Distributor-specific extra data.
    /// @param poolFee           UniV3 / PancakeV3 pool fee tier for FLUID/USDC.
    /// @param minOut            Minimum USDC out (slippage protection).
    /// @return claimed          FLUID amount transferred from the distributor.
    /// @return swapped          USDC received from the swap (= re-supplied into Fluid).
    function claimAndCompound(
        uint256 cumulativeAmount,
        uint8 positionType,
        bytes32 positionId,
        uint256 cycle,
        bytes32[] calldata merkleProof,
        bytes calldata metadata,
        uint24 poolFee,
        uint256 minOut
    ) external onlyKeeper nonReentrant returns (uint256 claimed, uint256 swapped) {
        if (address(fluidDistributor) == address(0) || address(rewardToken) == address(0)) {
            return (0, 0);
        }

        uint256 balBefore = rewardToken.balanceOf(address(this));
        // `recipient` MUST equal address(this) — distributor checks `msg.sender == recipient_`.
        fluidDistributor.claim(
            address(this),
            cumulativeAmount,
            positionType,
            positionId,
            cycle,
            merkleProof,
            metadata
        );
        claimed = rewardToken.balanceOf(address(this)) - balBefore;

        if (claimed == 0) return (0, 0);
        swapped = _swapAndReinvest(address(rewardToken), poolFee, claimed, minOut);
    }
}
