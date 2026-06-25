// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Errors
/// @notice Centralized custom errors for Apyee contracts (gas-efficient over require strings).
/// @dev Pause-related errors come from OpenZeppelin Pausable (EnforcedPause / ExpectedPause).
library Errors {
    // --- Access ---
    // NotOwner removed in V2.1: OZ Ownable supplies OwnableUnauthorizedAccount (Soken F-15).
    error NotKeeper();
    error NotGuardian();
    error NotVault();

    // --- Config ---
    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh(uint256 requested, uint256 max);
    // InvalidAllocation removed in V2.1: allocation paths use AllocationExceeded (Soken F-15).

    // --- Vault ---
    error DepositCapReached(uint256 requested, uint256 cap);
    error UserCapExceeded(uint256 cap, uint256 attempted);
    // WithdrawalExceedsBalance removed in V2.1: handled by IdleInsufficient / ERC4626 internals (Soken F-15).
    error IdleInsufficient(uint256 requested, uint256 available);

    // --- Strategy ---
    error StrategyNotWhitelisted(address strategy);
    error StrategyAlreadyAdded(address strategy);
    error StrategyHasBalance(address strategy, uint256 balance);
    // StrategyBlacklisted error removed in V2.1: invariant `isBlacklisted ⇒ !isActive` makes
    // the isActive gate sufficient — invest is blocked via StrategyNotWhitelisted (Soken F-15).
    // The same-named StrategyBlacklisted *event* lives in Vault.sol and is in active use.
    error BlacklistCooldownActive(uint256 remaining);
    error AssetMismatch(address expected, address actual);
    error ProtocolCallFailed(uint256 errorCode);

    // --- Allocation ---
    error AllocationExceeded(uint256 requested, uint256 max);
}
