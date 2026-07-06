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

    // V2.1.1 (multi-hop swap): malformed swapPath, wrong endpoint binding, or under-length.
    error InvalidPath();

    // V2.1.2 (Soken F-04-MEV.1): Keeper-supplied `minOut` fell below the on-chain fair-price
    // floor derived from Chainlink or an Owner-set fallback. Prevents sandwich extraction.
    error MinOutBelowFloor(uint256 minOut, uint256 floor);

    // V2.1.2: Chainlink `updatedAt` older than PRICE_STALENESS threshold.
    error PriceFeedStale(uint256 updatedAt, uint256 blockTs);

    // V2.1.2: Chainlink `answer` <= 0 or fallback price 0.
    error InvalidPrice();

    // V2.1.2: neither Chainlink feed nor Owner-set fallback price configured for the
    // reward token — Keeper cannot claim until Owner configures at least one.
    error MinOutFloorUnconfigured(address rewardToken);

    // V2.1.2: msg.sender is not the current Vault owner (dynamic read; supports Owner rotation).
    error NotOwner();

    // V2.1.2 (Soken N-01 / N-SP-01 / F-04-MEV.2): an intermediate hop token in the UniV3
    // multi-hop swap path is not on the Owner-managed whitelist. Prevents Keeper from
    // routing rewards through a rug / griefing / low-liquidity token that the Owner did
    // not vet. Endpoint tokens (rewardToken, underlyingAsset) are still bound by
    // `_validateSwapPath` — this error targets the middle tokens only.
    error HopTokenNotWhitelisted(address hopToken);

    // V2.1.2 (Soken N-02): the Vault is paused. `claimAndCompound` is a fund-moving
    // Keeper action and must be halted while Guardian has the Vault paused. User
    // withdraw is unaffected (Vault.sol re-declares it whenNotPaused-free).
    error VaultPaused();

    // V2.1.2 (Soken constructor guard): dexRouter address supplied at deploy time was
    // an EOA / self-destructed contract / uninitialized address. Guarded at construction
    // via `.code.length > 0`. Distinguishes "opt out of compounding" (address(0)) from
    // "misconfigured deploy" (a real address with no code).
    error DexRouterNotContract(address dexRouter);

    // V2.1.2 (Soken constructor guard): the current `block.chainid` does not match the
    // chain id captured at strategy deployment. Blocks replay of state-changing calls
    // on a forked or wrong chain.
    error WrongChain(uint256 expected, uint256 actual);

    // --- Allocation ---
    error AllocationExceeded(uint256 requested, uint256 max);
}
