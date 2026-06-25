# Soken Audit Remediation — V2.0 → V2.1

> **Audit Report**: Soken APY-2026-06-001 · **Date**: 2026-06-23 · **Audited commit**: V2.0 source at tag [`v2.0.0`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.0.0)
>
> **Remediation branch**: `feat/v2.1` · **Status (2026-06-25)**: code + tests landed, awaiting Soken remediation review.

This document maps every Soken finding to the V2.1 fix commit + the new test that
catches a regression on the same root cause. For each fix the inverse pre-fix
behavior is also documented so the audit firm can verify both directions.

---

## Summary by severity

| Severity | Count | Status |
|---|---:|---|
| Critical | 1 | All fixed |
| High | 0 | — |
| Medium | 2 | All fixed |
| Low | 4 | All fixed |
| Informational (code-change) | 5 | All fixed |
| Informational (acknowledged) | 4 | Documented, no code change |
| **Total** | **16** | **12 fixed + 4 acknowledged** |

---

## Critical

### F-17 — Permanent vault brick via stale `lastSharePrice` after `totalSupply()` returns to zero

**Pre-fix behavior** (V2.0): When the last holder exits and `totalSupply()` becomes 0, the
`lastSharePrice` baseline was never reset. A re-seeding deposit landed on OpenZeppelin's
`totalSupply()==0` path, minting `assets · 1e6` shares against a tiny `totalAssets()`
(rounding dust + any direct USDC donation ≥ 10 wei). The implied share price jumped ~924×
the stale baseline, the next `_accrue()` computed `feeAssets ≥ ta`, and the `FeeTooHigh`
defensive guard reverted permanently — freezing every `deposit / mint / withdraw / redeem /
accrue / setFeeRate / setTreasury`. No in-contract recovery because the immutable vault
cannot be patched.

**Fix** ([`Vault.sol` L#387-401](../contracts/Vault.sol#L387-L401) + [L#525-535](../contracts/Vault.sol#L525-L535)):
reset `lastSharePrice = 0` in two places:

1. `_accrue()`'s `totalSupply()==0` branch
2. `_withdraw()` immediately after `super._withdraw()` when the post-burn supply is 0

The next deposit then re-takes the lazy-init path (`if (lastSharePrice == 0)` in `_deposit`)
and re-snaps the baseline to the fresh share price.

**Test** ([`test/v2/Vault.v21.spec.ts`](../test/v2/Vault.v21.spec.ts) — F-17 block):

- `test_f17_lastSharePriceResetsToZero_whenTotalSupplyReturnsToZero`
- `test_f17_freshDepositAfterEmptyVault_doesNotBrick` — reproduces the Soken §F-17 PoC end-to-end (donation + redeposit), asserts `accrue / deposit / redeem` all stay live post-fix.

---

## Medium

### F-01 — Accrual hook-ordering mis-prices deposits and withdrawals

**Pre-fix behavior**: OpenZeppelin ERC-4626's `super.deposit / mint / withdraw / redeem` resolve
`previewXxx` *before* the `_deposit / _withdraw` hook runs. V2.0's `_accrue()` lived inside the
hook, so the fee-share mint diluted the pool *after* pricing — depositors received fewer shares
than their assets were worth post-accrue, and withdrawers extracted more than their fair share.
Soken-reproduced 0.91% shortfall on a $100k deposit (20% fee × 5% un-accrued gap).

**Fix** ([`Vault.sol` L#560-595](../contracts/Vault.sol#L560-L595)): override the four public
entrypoints `deposit / mint / withdraw / redeem` to call `_accrue()` before delegating to
`super`. Hook-internal `_accrue()` calls retained as defense-in-depth (the `lastAccruedAt ==
block.timestamp` same-block guard makes the second call a free no-op).

**Test**: `test_f01_depositAfterQuietYield_returnsImmediatelyRedeemableValue` — Bob deposits
after a 7-day yield gap and immediately redeems. Post-fix recovers ≈ deposit (within 2 wei).

---

### F-02 — Re-adding a removed strategy duplicates it in `strategyList` (double-count `totalAssets`)

**Pre-fix behavior**: `removeStrategy` only cleared the `isActive` flag; the address stayed in
the iterable `strategyList`. A subsequent `addStrategy` pushed a second entry. Because
`totalAssets()` iterated `strategyList` and summed `IStrategy(s).balanceOf()` for every entry
where `isActive || isBlacklisted`, the re-added strategy's balance was counted twice
(`strategyInfo` is a per-address map, so both list entries resolved to the same record).
Soken-reproduced 40% NAV inflation in the PoC.

**Fix** ([`Vault.sol` L#735-760](../contracts/Vault.sol#L735-L760)): swap-and-pop the address
out of `strategyList` inside `removeStrategy`. Each strategy address appears at most once;
bounded growth resolves F-07 as a side effect.

**Test**: `test_f02_removeThenReAdd_doesNotDuplicateInList` — `strategyCount` stays at 1 across
add → remove → re-add.

---

## Low

### F-03 — Streaming fee over-charged by factor (1+g): fee base was post-yield `totalAssets()`

**Pre-fix behavior**: `feeAssets = TA × (sp - lastSp) × feeRate / (lastSp × 1e4)` used the
post-yield `TA = totalAssets()` as the fee base. Since `TA_now = TA_old × (1 + g)` where
`g = (sp - lastSp) / lastSp`, the formula collapsed to `feeAssets = profit × feeRate × (1 + g)`
— a multiplicative `(1+g)` over-charge vs the marketed "X% of yield" headline.

**Fix** ([`Vault.sol` L#420-431](../contracts/Vault.sol#L420-L431) + `_feeSharesFor`):
`feeAssets = TS × (sp - lastSp) / ACCRUE_PRECISION × feeRate / 10_000` — exactly
`feeRate × realized profit`. Same change applied to `_feeSharesFor` so `pendingFeeShares()`
stays consistent.

[`docs/V2_DESIGN.md` §3.1](V2_DESIGN.md) updated with the new formula + Fix [[1]] / [[2]]
worked examples re-priced ($0.151 → $0.150 at 10% gap × 15% fee).

**Test**: `test_f03_feeShareValue_matchesExactly_feeRateTimesProfit` — treasury share value
== feeRate × profit (= $150 on $1000 yield at 15%, not the pre-fix $165).

---

### F-04 — Protocol reward tokens (COMP / XVS / MORPHO / FLUID) accrue to adapters and are never claimed

**Pre-fix behavior**: All five adapter `harvestable()` hardcoded `return 0` and `BaseStrategy`
exposed no claim path. Compound V3 (COMP via `CometRewards.claim`), Venus (XVS via
`Comptroller.claimVenus`), Aave-family (SPK/KINZA/stkAAVE via `RewardsController.claimRewards`),
Morpho/MetaMorpho (MORPHO + curator tokens via the Universal Rewards Distributor), and Fluid
(FLUID via the Merkle Distributor — which enforces `msg.sender == recipient`) all pay
incentives as separate ERC-20 streams not reflected in supply `balanceOf`. Adapter state is
`immutable`; any reward ERC-20 that lands on an adapter is permanently immobile.

**Fix** (multiple files):

- `BaseStrategy` gains `dexRouter` (constructor-pinned UniV3 SwapRouter02 / PancakeV3
  SmartRouter) + `_swapAndReinvest(rewardToken, poolFee, amountIn, minOut)` helper
- Each adapter exposes its protocol-specific `claimAndCompound(...)` external function gated
  by `onlyKeeper` + `nonReentrant`. The strategy itself originates the distributor call (Fluid
  requires `msg.sender == recipient`; the same pattern is used everywhere for consistency).
- Reward token swapped to USDC via the DEX router (`recipient = address(this)`), then
  re-deposited into the same external protocol. The resulting `balanceOf()` growth flows into
  `Vault.totalAssets()` and the streaming-fee `_accrue()` captures the operator's 15% share
  automatically on the next user action — no explicit fee plumbing.

Full distributor table + per-chain DEX router map: [`docs/V2_DESIGN.md` §6.2](V2_DESIGN.md).

**Test**: `test_f04_baseStrategy_keeper_isReadDynamicallyFromVault` covers the `onlyKeeper`
dynamic read invariant (fork specs for the full claim flow per distributor will land in a
follow-up commit).

---

### F-05 — Unguarded strategy `balanceOf()` in `totalAssets()` can freeze deposits/withdrawals (future adapter)

**Pre-fix behavior**: `totalAssets()` iterated `strategyList` and called
`IStrategy(s).balanceOf()` with no try/catch. Reachability against the five shipped adapters
was nil, but a future adapter whose `balanceOf` reverts (paused / exploited / migrated
underlying protocol) would freeze every deposit / mint / withdraw / redeem with no on-chain
recovery (the eviction paths `removeStrategy` / `emergencyWithdraw` also read the same
reverting view).

**Fix** ([`Vault.sol` L#162-176, L#214-228, L#615-635, L#810-830, L#893-910](../contracts/Vault.sol)):
add `isQuarantined` flag to `StrategyInfo` + Owner-only `setQuarantine(address, bool)`.
Quarantined strategies are skipped in `totalAssets()` and `_autoPullFromStrategies`, and
rejected by `investToStrategy`. Naive try-catch return-0 was rejected per Soken §F-05
guidance (it silently understates NAV and mis-prices shares).

⚠ Quarantine moves the strategy's value out of the share price; Owner must reconcile
off-chain before flipping the flag.

**Test** (4 cases):

- `test_f05_setQuarantine_excludesStrategyFromTotalAssets`
- `test_f05_quarantinedStrategy_rejectsInvest`
- `test_f05_setQuarantine_isOnlyOwner`
- `test_f05_setQuarantine_restoresAccountingWhenCleared`

---

### F-06 — Single-step Ownable

**Pre-fix behavior**: `Ownable.transferOwnership(newOwner)` reverted only on the zero address;
any non-zero-but-wrong destination (typo of the Safe address, an address with a lost key, a
non-Safe contract) took effect immediately. `renounceOwnership()` was also reachable. Either
would permanently freeze every `onlyOwner` setter, including `unpause()` — an immutable yield
vault should never be ownerless.

**Fix**: `VaultV2 is ... Ownable2Step ...` so transfer requires `acceptOwnership` from the
new owner. `renounceOwnership()` overridden to revert with an explicit string.

**Test** (2 cases):

- `test_f06_renounceOwnership_reverts`
- `test_f06_transferOwnership_requiresAcceptance` — owner stays the same until candidate
  accepts; `pendingOwner` exposes the queued transfer.

---

### F-07 — `strategyList` grows unbounded across the strategy lifecycle

Same root cause as F-02. Fixed by the swap-and-pop in `removeStrategy`. No separate test
because F-02's `test_f02_removeThenReAdd_doesNotDuplicateInList` already asserts bounded
list length across the add → remove → re-add cycle.

---

## Informational (code-change)

### F-15 — Unused custom errors

`NotOwner`, `InvalidAllocation`, `WithdrawalExceedsBalance`, `StrategyBlacklisted` (the error)
were declared but never thrown. Removed in V2.1. The same-named `StrategyBlacklisted` event in
`Vault.sol` is in active use and stays.

### F-16 — `TRUST_MODEL.md` phrasing correction

Soken §F-16 noted that the previous "no privileged role can move user principal to an
arbitrary address" claim was true only for non-owner roles (Keeper, Guardian, unprivileged
callers). The Owner (Multi-sig) can, by `addStrategy(maliciousStrategy)` + `setKeeper(self)`
+ `investToStrategy`, route principal through a self-supplied strategy — an accepted
centralization risk inherent to every DeFi multi-sig.

[`docs/TRUST_MODEL.md`](TRUST_MODEL.md) updated:

- TL;DR rewritten to distinguish non-owner guarantee from owner trust.
- Owner CAN table extended with `setQuarantine` (F-05) and `transferOwnership` (F-06 two-step).

### F-05, F-06 — covered above (cross-listed)

---

## Informational (acknowledged, no code change)

| Finding | Acknowledgement |
|---|---|
| F-08 — No HWM, depositors re-taxed across share-price round-trips | Intentional design (V2_DESIGN.md §3.2 Fix [[1]]). Stablecoin loss-recovery is rare; HWM mapping would significantly grow audit surface. |
| F-09 — Venus `exchangeRateStored()` is stale | Documented in-code (`VenusStrategy.sol`). Sub-bps NAV lag against the live rate; `_withdraw` realizes the correct value via balance-delta accounting. |
| F-10 — Direct USDC donation can grief `depositCap` | Self-defeating attack (donated capital becomes withdrawable yield for existing LPs). `_decimalsOffset()=6` mitigates the classic ERC-4626 inflation attack. |
| F-11 — `removeStrategy` zero-balance check uses rounding-down `balanceOf()` | Sub-cent dust can be uncounted; recoverable by re-adding the strategy. |
| F-12 — USDC sent directly to an adapter is invisible | Donation-neutral accounting (pre/post `balanceOf` delta), no theft vector. |
| F-13 — Guardian-only pause vs Owner-only unpause | Documented asymmetry (Vault.sol comment) — prevents single-key un-pause after a compromise. `withdraw` always open. |
| F-14 — Owner can `setDepositCap(0)` for soft-freeze | Intended (V1 → V2 / V2.0 → V2.1 migration halt mechanism). |

---

## Commit log

| Commit | Scope |
|---|---|
| `c068433` | Batch 1 — F-17 (Critical) · F-02/F-07 · F-03 · F-06 · F-15 |
| `4057b8c` | Batch 2 — F-05 (quarantine) · F-01 (accrue-first ordering) |
| `e3ca5e1` | Batch 3 — F-04 reward claim+compound for all 5 strategy adapters |
| `42ab80a` | Batch 4 — F-04g chain × strategy reward matrix + `constructorArgsFor` plumbing |
| `209e379` | Batch 5 — V2.1 test spec, 14 cases (matches every finding) |

Tag `v2.1.0` will be created once Soken's remediation review confirms the fix set.

---

## Acceptance criteria for the remediation review

1. **Critical (F-17)**: re-run Soken's `VaultV2_Brick_StaleSharePrice.t.sol` against
   `feat/v2.1` HEAD. All 7 cases including `test_permanent_noRecovery` should now PASS
   the post-fix expectation (vault recovers; no `FeeTooHigh` revert).
2. **Medium (F-01, F-02)**: re-run Soken's `VaultV2_F01_DepositPreviewStaleAccrue.t.sol`
   and `VaultV2_F02_DuplicateStrategy.t.sol`. Both should now demonstrate the fixed
   behavior (no shortfall, no double-count).
3. **Low (F-03, F-04, F-06, F-07)**: confirm formula, claim entrypoints, Ownable2Step,
   and bounded `strategyList` per the file references above.
4. **Informational code-change (F-05, F-15, F-16)**: confirm quarantine semantics, error
   library cleanup, and trust-model phrasing.
5. **Informational acknowledged**: no action — Soken to confirm the acknowledgements are
   appropriately documented.

A follow-up commit will add the per-distributor fork specs once chain-specific RPC stability
is confirmed for the new claim flows.
