// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IVToken
/// @notice Subset of Venus / Compound V2 vToken ABI used by VenusStrategy.
/// @dev Compound V2 fork conventions:
///        - mint / redeem / redeemUnderlying return uint256 error codes (0 = success).
///          Non-zero return means failure WITHOUT revert — adapter must check + revert manually.
///        - balanceOf returns vToken count, NOT underlying. To get underlying:
///            underlying = vBalance × exchangeRateStored() / 1e18
///        - supplyRatePerBlock is per-block (not per-second), so APR conversion needs
///          a chain-specific blocks-per-year constant.
interface IVToken {
    /// @notice Supply `mintAmount` of underlying. Returns 0 on success, error code otherwise.
    function mint(uint256 mintAmount) external returns (uint256);

    /// @notice Burn `redeemTokens` vTokens for underlying. Used for "withdraw all" flows.
    function redeem(uint256 redeemTokens) external returns (uint256);

    /// @notice Withdraw exactly `redeemAmount` of underlying. Used for partial withdraws.
    function redeemUnderlying(uint256 redeemAmount) external returns (uint256);

    /// @notice vToken balance of `owner` (NOT underlying — multiply by exchange rate).
    function balanceOf(address owner) external view returns (uint256);

    /// @notice vToken ↔ underlying exchange rate, scaled 1e18. Snapshot value (not refreshed).
    function exchangeRateStored() external view returns (uint256);

    /// @notice Per-block supply rate, scaled 1e18. APR_bps ≈ rate × BLOCKS_PER_YEAR / 1e14.
    function supplyRatePerBlock() external view returns (uint256);

    /// @notice Underlying ERC-20 address that backs this vToken.
    function underlying() external view returns (address);
}
