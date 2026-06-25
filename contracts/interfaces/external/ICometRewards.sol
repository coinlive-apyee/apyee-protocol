// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ICometRewards — Compound V3 reward distributor
/// @notice Used by `CompoundV3Strategy.claimAndCompound` to pull accrued COMP into the
///         strategy. `claim(comet, src, accrue)` transfers all accrued reward (rewardToken
///         is configured on the distributor per Comet market) to `src`.
/// @dev    Per-chain Compound V3 deployment addresses live in `scripts/deploy/00-config.ts`.
interface ICometRewards {
    /// @notice Pull pending rewards for `src` to `src` itself. When `shouldAccrue` is true,
    ///         the distributor first calls `Comet.accrueAccount(src)` so that the latest
    ///         reward is included in the claim.
    /// @param comet         Comet market address (e.g. cUSDCv3 on each chain).
    /// @param src           Account whose rewards are claimed (= our strategy contract).
    /// @param shouldAccrue  True → call `accrueAccount` first (recommended).
    function claim(address comet, address src, bool shouldAccrue) external;

    /// @notice View the reward token configured for a given Comet market on this distributor.
    function rewardConfig(address comet)
        external
        view
        returns (address token, uint64 rescaleFactor, bool shouldUpscale);
}
