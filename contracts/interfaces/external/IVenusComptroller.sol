// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IVenusComptroller — Venus (Compound V2 fork) BNB Chain comptroller
/// @notice Used by `VenusStrategy.claimAndCompound` to pull accrued XVS rewards.
/// @dev Mainnet (BSC) Unitroller proxy: 0xfD36E2c2a6789Db23113685031d7F16329158384
interface IVenusComptroller {
    /// @notice Claim all XVS accrued to `holder` from the specified vToken markets.
    ///         Strategy passes only its own market(s) — typically a single vUSDC.
    /// @param holder  Recipient of the XVS transfer (= our strategy contract).
    /// @param vTokens List of vToken markets to settle for the holder.
    function claimVenus(address holder, address[] memory vTokens) external;

    /// @notice View accrued (but not yet claimed) XVS for `holder`.
    function venusAccrued(address holder) external view returns (uint256);
}
