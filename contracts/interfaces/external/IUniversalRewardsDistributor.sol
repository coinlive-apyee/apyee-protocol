// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IUniversalRewardsDistributor — Morpho cumulative merkle-based distributor
/// @notice Used by `MorphoStrategy.claimAndCompound` to pull accrued MORPHO (or
///         curator-specific) rewards. `claim(account, reward, claimable, proof)` pulls the
///         difference between the current cumulative `claimable` (merkle leaf value) and
///         the amount already claimed for `(account, reward)`.
/// @dev    Multiple URDs can exist per chain (Morpho operates one, each curator may operate
///         its own). The strategy is pinned to a single URD at deploy; if a vault needs to
///         claim from multiple URDs, deploy multiple strategy instances or extend at V3.
///         Ethereum URD: 0x330eefa8a787552DC5cAd3C3cA644844B1E61Ddb
interface IUniversalRewardsDistributor {
    /// @notice Claim `claimable - claimed[account][reward]` of `reward` for `account`.
    ///         The merkle proof must validate `(account, reward, claimable)` against the
    ///         current `merkleRoot()` of the distributor.
    /// @param account    Recipient (= our strategy contract; merkle leaf binds it).
    /// @param reward     ERC-20 reward to pull.
    /// @param claimable  Cumulative claimable from the merkle leaf.
    /// @param proof      Merkle proof (off-chain Keeper-provided).
    /// @return amount    Reward amount actually transferred (= claimable − previously claimed).
    function claim(
        address account,
        address reward,
        uint256 claimable,
        bytes32[] calldata proof
    ) external returns (uint256 amount);

    /// @notice View total amount already claimed by `account` for `reward`. Useful for the
    ///         Keeper's off-chain net-claimable computation.
    function claimed(address account, address reward) external view returns (uint256);
}
