// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategy} from "./BaseStrategy.sol";
import {IAaveV3Pool, AaveDataTypes} from "../interfaces/external/IAaveV3Pool.sol";
import {IAaveRewardsController} from "../interfaces/external/IAaveRewardsController.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title AaveV3Strategy
/// @notice Adapter that supplies `underlyingAsset` (USDC) to Aave V3 and earns yield via aToken
///         balance accrual. Fully reusable across chains: deploy once per (vault, asset, pool, aToken).
/// @dev Aave V3 auto-accrues interest into the aToken — no `harvest()` action required at the
///      strategy level. The Vault's `lastRecordedBalance` snapshot handles fee accounting.
contract AaveV3Strategy is BaseStrategy {
    using SafeERC20 for IERC20;

    /// @notice Aave V3 Pool contract (per-chain).
    IAaveV3Pool public immutable aavePool;

    /// @notice aToken counterpart of the underlying (e.g. aEthUSDC). Balance grows with interest.
    IERC20 public immutable aToken;

    /// @notice V2.1 (Soken F-04): Aave-family rewards distributor. Pinned per-instance:
    ///         Aave V3 RewardsController for Aave pools, Spark's distributor for Spark,
    ///         Kinza's controller for Kinza. `address(0)` opts out of claims.
    IAaveRewardsController public immutable rewardsController;

    /// @notice V2.1 (Soken F-04): single reward token to harvest (e.g. SPK for Spark pools,
    ///         KINZA for Kinza). Aave V3 can in principle stream multiple per-asset rewards
    ///         (e.g. stkAAVE + an ecosystem token); we pin one and accept that secondary
    ///         tokens are left on the table — claim them via a future strategy redeploy.
    IERC20 public immutable rewardToken;

    /// @dev RAY (1e27) → bps (1e4) conversion factor used in `currentAPY`.
    uint256 private constant RAY_TO_BPS_DIVISOR = 1e23;

    /// @param vault_     Apyee Vault address (must equal Vault.asset() == asset_).
    /// @param asset_     Underlying token (USDC).
    /// @param aavePool_  Aave V3 Pool contract for the chain.
    /// @param aToken_    aToken matching `asset_` on `aavePool_`. Must be passed in (saves a lookup).
    constructor(
        address vault_,
        address asset_,
        address aavePool_,
        address aToken_,
        address rewardsController_,
        address rewardToken_,
        address dexRouter_,
        bytes32 strategyVersionHash_
    ) BaseStrategy(vault_, asset_, dexRouter_, strategyVersionHash_) {
        if (aavePool_ == address(0) || aToken_ == address(0)) revert Errors.ZeroAddress();
        aavePool = IAaveV3Pool(aavePool_);
        aToken = IERC20(aToken_);
        // V2.1 — both reward params may be address(0) for chains/pools where the Aave-family
        // protocol is not incentivized (e.g. Aave V3 USDC on most chains today). `claimAndCompound`
        // no-ops in that case.
        rewardsController = IAaveRewardsController(rewardsController_);
        rewardToken = IERC20(rewardToken_);

        // One-shot infinite approval so each `_deposit` skips the per-call approve.
        // Safe for trusted protocol contracts; Aave V3 Pool is immutable and audited.
        underlyingAsset.forceApprove(aavePool_, type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────
    // BaseStrategy hooks
    // ─────────────────────────────────────────────────────────────

    /// @inheritdoc BaseStrategy
    /// @dev Pre-condition: BaseStrategy already pulled `amount` USDC from the Vault into this contract.
    function _deposit(uint256 amount) internal override {
        aavePool.supply(address(underlyingAsset), amount, address(this), 0);
    }

    /// @inheritdoc BaseStrategy
    function _withdraw(uint256 amount) internal override returns (uint256 withdrawn) {
        // Aave returns the actual amount withdrawn — may be less if the pool's available
        // liquidity (cash) is below `amount`. BaseStrategy forwards `withdrawn` to the Vault.
        withdrawn = aavePool.withdraw(address(underlyingAsset), amount, address(this));
    }

    /// @inheritdoc BaseStrategy
    function _emergencyWithdraw() internal override returns (uint256 withdrawn) {
        // `type(uint256).max` is the Aave convention for "withdraw entire aToken balance".
        // If the pool is partially illiquid, this returns whatever could be withdrawn rather
        // than reverting — exactly the behavior emergencyWithdraw needs (best-effort exit).
        uint256 bal = aToken.balanceOf(address(this));
        if (bal == 0) return 0;
        withdrawn = aavePool.withdraw(address(underlyingAsset), type(uint256).max, address(this));
    }

    // ─────────────────────────────────────────────────────────────
    // IStrategy view methods
    // ─────────────────────────────────────────────────────────────

    /// @notice Current underlying balance held in Aave (principal + accrued interest).
    function balanceOf() external view override returns (uint256) {
        return aToken.balanceOf(address(this));
    }

    /// @notice Current supply APR in basis points (linear, not compounded).
    /// @dev Aave's `currentLiquidityRate` is APR in RAY (1e27). We strip 1e23 to land in bps (1e4).
    ///      APY ≈ APR for small rates (5% APR → 5.13% APY); a one-line approximation is enough
    ///      for ranking strategies. Off-chain consumers can compound if they need precision.
    function currentAPY() external view override returns (uint256) {
        AaveDataTypes.ReserveData memory data = aavePool.getReserveData(address(underlyingAsset));
        return uint256(data.currentLiquidityRate) / RAY_TO_BPS_DIVISOR;
    }

    /// @notice Aave aTokens auto-accrue, so per-strategy `harvestable` accounting is moot —
    ///         the Vault tracks unrealized P&L via `lastRecordedBalance` instead. Returns 0 to
    ///         signal "no on-strategy harvest action needed".
    function harvestable() external pure override returns (uint256) {
        return 0;
    }

    // ─────────────────────────────────────────────────────────────
    // V2.1 (Soken F-04) — Aave-family reward claim + auto-compound
    // ─────────────────────────────────────────────────────────────

    /// @notice Keeper-only: claim accrued `rewardToken` from the Aave RewardsController
    ///         (Spark / Kinza variants share the same interface), swap to USDC, and
    ///         re-supply into Aave (auto-compound).
    /// @dev    No-ops when `rewardsController` or `rewardToken` was set to address(0)
    ///         (intentional opt-out for non-incentivized chains).
    /// @param poolFee  UniV3 pool fee tier for rewardToken/USDC.
    /// @param minOut   Minimum USDC out (slippage protection, Keeper-computed).
    /// @return claimed Reward amount transferred from the controller.
    /// @return swapped USDC received (= re-supplied into Aave).
    function claimAndCompound(uint24 poolFee, uint256 minOut)
        external
        onlyKeeper
        nonReentrant
        returns (uint256 claimed, uint256 swapped)
    {
        if (address(rewardsController) == address(0) || address(rewardToken) == address(0)) {
            return (0, 0);
        }

        address[] memory assets = new address[](1);
        assets[0] = address(aToken);
        claimed = rewardsController.claimRewards(
            assets,
            type(uint256).max,
            address(this),
            address(rewardToken)
        );

        if (claimed == 0) return (0, 0);
        swapped = _swapAndReinvest(address(rewardToken), poolFee, claimed, minOut);
    }
}
