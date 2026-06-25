// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IAaveRewardsController — Aave V3 / Spark / Kinza rewards distributor
/// @notice Used by `AaveV3Strategy.claimAndCompound` to pull accrued reward tokens
///         (SPK on Spark, KINZA on Kinza, stkAAVE/AAVE on Aave V3 when configured).
/// @dev Address is chain-specific and per-protocol (Spark has its own, Aave V3 has its own).
///      Pinned per-strategy via the constructor.
interface IAaveRewardsController {
    /// @notice Claim `amount` of `reward` accrued from supplying / borrowing the assets in
    ///         `assets` (typically `[aToken]` for a single supply position) to `to`.
    ///         Pass `type(uint256).max` to claim the full available amount.
    /// @param assets List of incentivized assets to settle (aTokens / vTokens / sTokens).
    /// @param amount Max amount to claim (use `type(uint256).max` for "everything available").
    /// @param to     Recipient of the reward transfer (= our strategy contract).
    /// @param reward Reward ERC-20 to pull (Aave V3 allows multiple per-asset; we pin one).
    /// @return claimedAmount Actual reward amount transferred.
    function claimRewards(
        address[] calldata assets,
        uint256 amount,
        address to,
        address reward
    ) external returns (uint256 claimedAmount);

    /// @notice View pending reward for `user` across `assets` for the specified `reward`.
    function getUserRewards(address[] calldata assets, address user, address reward)
        external
        view
        returns (uint256);
}
