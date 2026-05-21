// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Errors
/// @notice Centralized custom errors for Apyee contracts (gas-efficient over require strings).
/// @dev Pause-related errors come from OpenZeppelin Pausable (EnforcedPause / ExpectedPause).
library Errors {
    // --- Access ---
    error NotOwner();
    error NotKeeper();
    error NotGuardian();
    error NotVault();

    // --- Config ---
    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh(uint256 requested, uint256 max);
    error InvalidAllocation(uint256 totalBps);

    // --- Vault ---
    error DepositCapReached(uint256 requested, uint256 cap);
    error UserCapExceeded(uint256 cap, uint256 attempted);
    error WithdrawalExceedsBalance(uint256 requested, uint256 available);
    error IdleInsufficient(uint256 requested, uint256 available);

    // --- Strategy ---
    error StrategyNotWhitelisted(address strategy);
    error StrategyAlreadyAdded(address strategy);
    error StrategyHasBalance(address strategy, uint256 balance);
    error StrategyBlacklisted(address strategy);
    error BlacklistCooldownActive(uint256 remaining);
    error AssetMismatch(address expected, address actual);
    error ProtocolCallFailed(uint256 errorCode);

    // --- Allocation ---
    error AllocationExceeded(uint256 requested, uint256 max);
}
