// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategy} from "./BaseStrategy.sol";
import {IComet} from "../interfaces/external/IComet.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title CompoundV3Strategy
/// @notice Adapter that supplies the base asset (USDC) into a Compound V3 Comet market.
/// @dev Compound V3 differs from Aave V3 in two ways the adapter has to handle:
///        1. `comet.withdraw` does NOT return the actual amount — we diff our own underlying
///           balance before/after the call.
///        2. Each Comet is a single market (one base asset). We assert `comet.baseToken() == asset`
///           in the constructor to fail-fast on misconfiguration.
contract CompoundV3Strategy is BaseStrategy {
    using SafeERC20 for IERC20;

    /// @notice Compound V3 Comet contract for the (chain, base-asset) market.
    IComet public immutable comet;

    /// @dev Compound V3 normalises rates to per-second × 1e18. Annualising and scaling to bps:
    ///        APR_bps = perSecondRate * SECONDS_PER_YEAR / 1e14
    uint256 private constant SECONDS_PER_YEAR = 365 days;
    uint256 private constant RATE_SCALE_TO_BPS = 1e14;

    constructor(address vault_, address asset_, address comet_, bytes32 strategyVersionHash_)
        BaseStrategy(vault_, asset_, strategyVersionHash_)
    {
        if (comet_ == address(0)) revert Errors.ZeroAddress();
        comet = IComet(comet_);

        // Comet's base asset must match what the Vault expects — otherwise supply would revert
        // late at runtime. Catch it at deploy.
        address cometBase = IComet(comet_).baseToken();
        if (cometBase != asset_) revert Errors.AssetMismatch(asset_, cometBase);

        // One-shot infinite approval. Comet is immutable + audited.
        underlyingAsset.forceApprove(comet_, type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────
    // BaseStrategy hooks
    // ─────────────────────────────────────────────────────────────

    function _deposit(uint256 amount) internal override {
        comet.supply(address(underlyingAsset), amount);
    }

    function _withdraw(uint256 amount) internal override returns (uint256 withdrawn) {
        // Comet.withdraw is void → measure actual transfer via balance delta.
        uint256 balBefore = underlyingAsset.balanceOf(address(this));
        comet.withdraw(address(underlyingAsset), amount);
        uint256 balAfter = underlyingAsset.balanceOf(address(this));
        withdrawn = balAfter - balBefore;
    }

    function _emergencyWithdraw() internal override returns (uint256 withdrawn) {
        if (comet.balanceOf(address(this)) == 0) return 0;

        uint256 balBefore = underlyingAsset.balanceOf(address(this));
        // Compound V3 convention: type(uint256).max → entire base balance.
        comet.withdraw(address(underlyingAsset), type(uint256).max);
        uint256 balAfter = underlyingAsset.balanceOf(address(this));
        withdrawn = balAfter - balBefore;
    }

    // ─────────────────────────────────────────────────────────────
    // IStrategy view methods
    // ─────────────────────────────────────────────────────────────

    function balanceOf() external view override returns (uint256) {
        return comet.balanceOf(address(this));
    }

    function currentAPY() external view override returns (uint256) {
        uint256 utilization = comet.getUtilization();
        uint256 perSecondRate = comet.getSupplyRate(utilization);
        return (perSecondRate * SECONDS_PER_YEAR) / RATE_SCALE_TO_BPS;
    }

    /// @notice Compound V3 auto-accrues into `balanceOf`. Vault tracks unrealized P&L itself,
    ///         so the strategy reports 0 ("no on-strategy harvest action needed").
    function harvestable() external pure override returns (uint256) {
        return 0;
    }
}
