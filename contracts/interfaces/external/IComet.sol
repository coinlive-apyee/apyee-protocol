// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IComet
/// @notice Subset of Compound V3 Comet ABI used by CompoundV3Strategy.
/// @dev In Compound V3, each market is a single contract (cUSDCv3, cWETHv3, ...) that holds
///      both base and collateral. `balanceOf(account)` returns the account's base-asset balance
///      (auto-accruing supply position). Withdraw does not return the amount, so callers must
///      diff their own token balance to know the actual transfer size.
interface IComet {
    function baseToken() external view returns (address);

    function supply(address asset, uint256 amount) external;

    /// @notice Withdraw `amount` of `asset` to caller. Use `type(uint256).max` to drain.
    /// @dev Returns no value. Caller must diff its underlying balance to measure actual amount.
    function withdraw(address asset, uint256 amount) external;

    /// @notice Account's base-asset balance (principal + accrued interest).
    function balanceOf(address account) external view returns (uint256);

    /// @notice Current pool utilization, scaled to 1e18.
    function getUtilization() external view returns (uint256);

    /// @notice Per-second supply rate at the given utilization, scaled to 1e18.
    /// @dev Annual rate (bps) = perSecond * SECONDS_PER_YEAR / 1e14.
    function getSupplyRate(uint256 utilization) external view returns (uint64);
}
