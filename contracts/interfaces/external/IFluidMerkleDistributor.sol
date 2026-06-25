// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IFluidMerkleDistributor — Fluid (Instadapp) cumulative merkle distributor
/// @notice Used by `FluidStrategy.claimAndCompound` to pull accrued FLUID (formerly INST)
///         rewards. Distinct from Morpho's URD in that Fluid's `claim` enforces
///         `msg.sender == recipient` — only the recipient itself can call. That's why the
///         strategy must own the claim entrypoint (we can't have the Keeper call it
///         directly for the strategy; the Keeper invokes `claimAndCompound`, which then
///         calls `claim` from the strategy's own address).
/// @dev    Ethereum distributor: 0xF398E66B1273a34558AeBbEC550DccaF4AcC7714
///         FLUID reward token   : 0x6f40d4A6237C257fff2dB00FA0510DeEECd303eb (= legacy INST)
///         Source ref: github.com/Instadapp/fluid-contracts-public/
///                     contracts/protocols/lending/merkleDistributor/main.sol
interface IFluidMerkleDistributor {
    /// @notice Claim the cumulative-minus-claimed amount for `(recipient, positionType,
    ///         positionId)` against the current merkle root for the given `cycle`.
    /// @dev    Reverts `MsgSenderNotRecipient` if `msg.sender != recipient_` — this is the
    ///         reason `claimAndCompound` lives inside the strategy.
    /// @param recipient_         Beneficiary of the claim. Must equal `msg.sender` (= strategy).
    /// @param cumulativeAmount_  Cumulative claimable for this (positionType, positionId).
    /// @param positionType_      Distributor position-type discriminator (lending / vault / ...).
    /// @param positionId_        Distributor position-id (typically the fToken address).
    /// @param cycle_             Reward cycle id (off-chain Keeper-supplied).
    /// @param merkleProof_       Merkle proof validating the cumulative claim.
    /// @param metadata_          Distributor-specific extra data (often empty).
    function claim(
        address recipient_,
        uint256 cumulativeAmount_,
        uint8 positionType_,
        bytes32 positionId_,
        uint256 cycle_,
        bytes32[] calldata merkleProof_,
        bytes memory metadata_
    ) external;

    /// @notice View total already-claimed amount for `(recipient, positionType, positionId)`
    ///         under a given `merkleRoot`. Used off-chain by the Keeper to compute net-claim.
    function claimed(address recipient, bytes32 positionRootHash) external view returns (uint256);
}
