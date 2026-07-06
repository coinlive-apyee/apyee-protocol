# Soken Audit Remediation — V2.0 → V2.1 → V2.1.2 → V2.1.3

> **Audit Report (round 1)**: Soken APY-2026-06-001 · **Date**: 2026-06-23 · **Audited commit**: V2.0 source at tag [`v2.0.0`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.0.0)
>
> **Audit Report (round 2)**: Soken APY-2026-06-002 · **Date**: 2026-06-30 · **Audited commit**: V2.1.1 source at tag [`v2.1.1`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.1) · **Verdict**: REVIEW 78/100 (25 new findings on F-04 surface, 8 pre-release recommendations)
>
> **Released tags**: [`v2.1.0`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.0) (round-1 initial remediation) · [`v2.1.1`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.1) (round-1 F-04 follow-up — multi-hop swap path) · [`v2.1.2`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.2) (round-2 remediation — this document §11)
>
> **Review target**: `v2.1.2` · **Status (2026-07-06)**: V2.1.2 remediation complete, all 8 pre-release recommendations addressed, awaiting Soken re-review.

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
  SmartRouter) + `_swapAndReinvest(rewardToken, swapPath, amountIn, minOut)` helper
- Each adapter exposes its protocol-specific `claimAndCompound(...)` external function gated
  by `onlyKeeper` + `nonReentrant`. The strategy itself originates the distributor call (Fluid
  requires `msg.sender == recipient`; the same pattern is used everywhere for consistency).
- Reward token swapped to USDC via the DEX router (`recipient = address(this)`), then
  re-deposited into the same external protocol. The resulting `balanceOf()` growth flows into
  `Vault.totalAssets()` and the streaming-fee `_accrue()` captures the operator's 15% share
  automatically on the next user action — no explicit fee plumbing.

Full distributor table + per-chain DEX router map: [`docs/V2_DESIGN.md` §6.2](V2_DESIGN.md).

#### F-04 follow-up — multi-hop swap path (V2.1.1)

After the initial V2.1.0 fix went out, a real-mainnet probe (Compound on Ethereum fork)
revealed that several reward tokens — COMP and MORPHO in particular — have no deep
direct USDC pool on UniswapV3. The single-hop `exactInputSingle(rewardToken, USDC, fee)`
call therefore reverted at the router. Without a routing change a meaningful fraction of
F-04's value would be lost.

V2.1.1 fix (Soken APY-2026-06-001 follow-up):

- `BaseStrategy._swapAndReinvest` argument changed from `uint24 poolFee` to
  `bytes calldata swapPath`. The router call is now `exactInput(path)` (UniV3 multi-hop).
- `_validateSwapPath(rewardToken, path)` enforces:
  - layout `20 + N*23` (so `>= 43` bytes, even number of "address + fee" hops)
  - the first 20 bytes equal the supplied `rewardToken`
  - the last 20 bytes equal `address(underlyingAsset)` (= USDC)
  → an adversarial Keeper cannot route the swap to a different input or output token.
- All five `claimAndCompound` external signatures take `bytes swapPath` instead of `poolFee`.
- New error `Errors.InvalidPath` covers the three failure modes above.
- `hardhat.config.ts` now enables `viaIR: true` to keep `FluidStrategy.claimAndCompound`'s
  local stack within compiler limits (the new path argument added a slot on top of an
  already-crowded 8-input function).

**Tests** (14 cases):

- `test/v2/Strategy.claim.fork.spec.ts` (Ethereum mainnet fork, 3 cases)
  Compound V3 end-to-end multi-hop `COMP → WETH → USDC` against the real UniV3 SwapRouter02
  and live `CometRewards`. Reward distributor is whale-funded inside the test to handle
  the typical "fresh fork → empty distributor" state.
- `test/v2/Strategy.claim.spec.ts` (mock distributor unit, 11 cases)
  Compound (3 — claim, NotKeeper, **InvalidPath**), Venus, Aave, Morpho, Fluid (each: claim
  + NotKeeper). Mocks cover the four distributor shapes the Ethereum fork doesn't
  reproduce on a stable block.
- Earlier `Vault.v21.spec.ts` `test_f04_baseStrategy_keeper_isReadDynamicallyFromVault`
  still covers the `onlyKeeper` dynamic-read invariant in isolation.

Coverage rationale: the e2e e2e (distributor + multi-hop swap + reinvest + `_accrue` fee
mint) is exercised on Compound, which shares the identical `BaseStrategy._swapAndReinvest`
path used by the other four adapters. The four adapter-specific tests verify each adapter's
distributor invocation shape (cumulative + proof + cycle for Fluid, merkle for Morpho,
multi-aToken for Aave, single-vToken for Venus). Symmetry across strategies + shared base
contract makes the Compound fork a representative end-to-end witness.

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
| _tag_ `v2.1.0` | 2026-06-25 — initial remediation released |
| `1efafbb` | V2.1.1 contracts — multi-hop swap path (F-04 follow-up) |
| _tests_  | V2.1.1 — Compound real fork (3) + 5 strategy mock unit (11) |
| `21736a7` | V2.1.1 docs — `SOKEN_AUDIT.md` F-04 follow-up subsection |
| _tag_ `v2.1.1` | 2026-06-25 — F-04 follow-up released |

Both tags are public on GitHub. Soken's remediation review is requested against `v2.1.1`.

---

## Acceptance criteria for the remediation review

All criteria below are evaluated against tag **`v2.1.1`** (the V2.1.1 release supersedes the
initial `v2.1.0`; see §F-04 follow-up for the rationale).

1. **Critical (F-17)**: re-run Soken's `VaultV2_Brick_StaleSharePrice.t.sol` against
   `v2.1.1`. All 7 cases including `test_permanent_noRecovery` should now PASS
   the post-fix expectation (vault recovers; no `FeeTooHigh` revert).
2. **Medium (F-01, F-02)**: re-run Soken's `VaultV2_F01_DepositPreviewStaleAccrue.t.sol`
   and `VaultV2_F02_DuplicateStrategy.t.sol`. Both should now demonstrate the fixed
   behavior (no shortfall, no double-count).
3. **Low (F-03, F-04, F-06, F-07)**: confirm formula, claim entrypoints, Ownable2Step,
   and bounded `strategyList` per the file references above.
4. **F-04 follow-up (V2.1.1)**: review multi-hop `_swapAndReinvest` + `_validateSwapPath`
   endpoint binding. Coverage: Compound real Ethereum fork (3) + 5 strategy mock unit (11).
5. **Informational code-change (F-05, F-15, F-16)**: confirm quarantine semantics, error
   library cleanup, and trust-model phrasing.
6. **Informational acknowledged**: no action — Soken to confirm the acknowledgements are
   appropriately documented.

---

## 11. V2.1.2 remediation — Soken APY-2026-06-002 response

> **Round-2 audit target**: tag `v2.1.1`. Soken re-examined the F-04 (multi-hop
> reward claim) attack surface introduced in V2.1.1 and returned verdict **REVIEW
> 78/100** with 25 new findings and 8 pre-release recommendations. V2.1.2 addresses
> all 8. Original 16 round-1 findings remain fully mitigated — nothing regresses.

### 11.1 Summary by severity

| Severity | Count | Status |
|---|---:|---|
| Medium | 4 | All fixed |
| Low | 6 | All fixed / accepted |
| Informational (code-change) | 5 | All addressed |
| Informational (acknowledged) | 10 | Documented |
| **Total new findings** | **25** | **15 fixed + 10 acknowledged** |
| **Pre-release recommendations** | **8** | **All 8 implemented** |
| **Post-submission additions (informational)** | **1** | **Fix #9 — see §11.3.9** |

### 11.2 Finding → mitigation matrix

Ordered by severity, then finding ID.

| Finding | Severity | Mitigation type | Location |
|---|---|---|---|
| **F-04-MEV.1** (Keeper `minOut` no oracle floor) | Medium | On-chain enforcement | `BaseStrategy._computeMinOutFloor` + `_swapAndReinvest` floor check |
| **F-04-MEV.2** (Middle-hop unrestricted) | Medium | On-chain whitelist | `BaseStrategy._validateSwapPath` + `allowedHopToken` |
| **F-04-MEV.4** (TRUST_MODEL doc requirement) | Medium | Documentation | `docs/TRUST_MODEL.md` §9 (this release) |
| **M-BUILD-1** (`via_ir = false`) | Medium | Build config | `foundry.toml` — `via_ir = true` (this release). `hardhat.config.ts` already `viaIR: true` since V2.1.1. |
| **N-01 / N-SP-01** (Path middle-hop restriction) | Low | On-chain whitelist | Same as F-04-MEV.2 |
| **N-02** (`Vault.paused()` bypass on strategy) | Low | Modifier propagation | `BaseStrategy.whenVaultNotPaused` on all 5 `claimAndCompound` |
| **N-03** (`minOut = 0` defense) | Low | On-chain enforcement | Automatic revert via `_computeMinOutFloor` (0 < floor for `amountIn > 0`) |
| **R-01 / R-02** (Router pin) | Low | Constructor guard + event | `BaseStrategy` constructor `extcodesize` check + `DexRouterConfigured` event |
| **F-04-MEV.4 residual** (TRUST_MODEL sections) | Low | Documentation | `docs/TRUST_MODEL.md` §9.7 |
| **L-BUILD-1 / L-BUILD-2** (Build hardening) | Low | Build config + comment | `foundry.toml` `via_ir = true` + `hardhat.config.ts` audit-response comment |

Pre-release recommendations (numbered per Soken's list, all addressed):

1. On-chain oracle floor for reward-token swaps → §11.3.1
2. Intermediate hop whitelist → §11.3.2
3. Pause-gate strategy claim path → §11.3.3
4. Skip-swap branch for reward==underlying → §11.3.4
5. Owner-only idle-asset rescue helper → §11.3.5
6. `via_ir = true` build setting → §11.3.6
7. TRUST_MODEL documentation refresh → §11.3.7
8. Constructor guards (router code check + chain pinning) → §11.3.8

Post-submission addition (informational, self-identified — not part of Soken's original 8):

9. Accrue-aware view math for `_convertToAssets` / `_convertToShares` → §11.3.9

### 11.3 Fix map (all 8)

Each subsection: **finding link → code location → test coverage → trust-model
reference**. The V2.1.2 test suite on this repository (`apyee-protocol`, the
audit target) runs at **143 passing / 9 pending / 0 regression** against the
V2.1.1 baseline (103 pre-existing V2 tests unchanged; 40 new mitigation-specific
tests added — 36 for the 8 Soken pre-release recommendations plus 4 for fix #9).
Reproduce with `npx hardhat test` at tag `v2.1.2`.

#### 11.3.1 On-chain Chainlink oracle floor (Recs #1 / F-04-MEV.1 / N-03)

- **Code**: `BaseStrategy.sol` — `rewardPriceFeed` / `rewardFallbackPriceE8` /
  `rewardMaxSlippageBps` mappings (Owner-set via `onlyVaultOwner`); constants
  `DEFAULT_MAX_SLIPPAGE_BPS = 500`, `MAX_SLIPPAGE_BPS_CAP = 1000`,
  `PRICE_STALENESS = 1 days`; `_computeMinOutFloor(rewardToken, amountIn)` helper;
  floor check inside `_swapAndReinvest`.
- **New errors**: `MinOutBelowFloor(minOut, floor)`, `PriceFeedStale(updatedAt,
  blockTs)`, `InvalidPrice`, `MinOutFloorUnconfigured(rewardToken)`, `NotOwner`.
- **New interface**: `contracts/interfaces/external/IChainlinkAggregator.sol` (2 view
  functions — `decimals()`, `latestRoundData()`).
- **Tests**: `Strategy.mitigations.spec.ts` — 11 specs covering fallback price path,
  Chainlink feed path (fresh / stale / negative), unconfigured revert, custom slippage
  override, slippage cap enforcement, and 3 setter access-control tests.
- **Trust model reference**: `TRUST_MODEL.md` §9.2.C, §9.7.2, §9.7.4.

#### 11.3.2 Intermediate-hop whitelist (Recs #2 / F-04-MEV.2 / N-01 / N-SP-01)

- **Code**: `BaseStrategy.sol` — `allowedHopToken` mapping + `setAllowedHopToken`
  (Owner-only) + `_validateSwapPath` middle-hop iteration.
- **New error**: `HopTokenNotWhitelisted(hopToken)`.
- **Tests**: 8 specs — single-hop bypass, multi-hop whitelisted OK, first-hop revert,
  second-middle-hop revert, de-whitelist takes effect immediately, event emit,
  onlyOwner, zero-address rejection.
- **Trust model reference**: `TRUST_MODEL.md` §9.2.B.

#### 11.3.3 Pause propagation to strategies (Recs #3 / N-02)

- **Code**: `BaseStrategy.sol` — `IVaultPausedView` interface + `whenVaultNotPaused`
  modifier. Applied to `claimAndCompound` on all 5 concrete strategies
  (`CompoundV3Strategy`, `AaveV3Strategy`, `VenusStrategy`, `MorphoStrategy`,
  `FluidStrategy`).
- **New error**: `VaultPaused`.
- **Tests**: 3 specs — paused vault blocks `claimAndCompound`, unpaused resumes it,
  paused vault still allows user `withdraw` (invariant sanity check).
- **Trust model reference**: `TRUST_MODEL.md` §9.3.

#### 11.3.4 Reward-token == underlying skip-swap (Rec #4)

- **Code**: `BaseStrategy._swapAndReinvest` — replaced `AssetMismatch` revert with a
  branch: when `rewardToken == underlyingAsset`, skip DEX interaction / path
  validation / floor check and route straight to `_deposit`. Event still emits with
  `amountIn == amountOut`.
- **Tests**: 4 specs — skip-swap re-deposits correctly, strategy balance grows by
  reward amount, garbage swap path silently ignored, minOut floor bypassed on this
  branch.
- **Trust model reference**: `TRUST_MODEL.md` §9.4.

#### 11.3.5 Owner rescue helper `sweepIdleAssetToVault()` (Rec #5)

- **Code**: `BaseStrategy.sweepIdleAssetToVault()` — Owner-only, `onlyVaultOwner` +
  `nonReentrant` + `onlyDeployChain`. Destination is hardcoded to `vault` (not
  parameterised). Only moves `underlyingAsset`; reward tokens and protocol receipt
  tokens remain untouchable.
- **New event**: `IdleAssetSwept(amount)`.
- **Tests**: 5 specs — forwards stray USDC to vault, zero-balance no-op idempotent,
  does not touch reward token, onlyOwner, signature invariant (zero args → destination
  cannot be spoofed).
- **Trust model reference**: `TRUST_MODEL.md` §9.5.

#### 11.3.6 `via_ir = true` build setting (Rec #6 / M-BUILD-1 / L-BUILD-1)

- **Code**: `foundry.toml` line 11 — `via_ir = true` (was `false`). `hardhat.config.ts`
  already had `viaIR: true` since V2.1.1 (needed for FluidStrategy stack depth); this
  release adds an audit-response comment linking the setting to M-BUILD-1.
- **Tests**: whole-suite compile + regression pass (`hardhat compile` succeeds under
  Yul IR; 139 test passing on this repo — see §11.3 preamble for the count breakdown).

#### 11.3.7 TRUST_MODEL documentation refresh (Rec #7 / F-04-MEV.4)

- **Doc**: `docs/TRUST_MODEL.md` — appended §9 (V2.1.2 additions). §9.1 extends the
  Owner-power enumeration; §9.2 documents the 3-layer MEV defense; §9.3–9.6 cover
  each new invariant; §9.7 enumerates 4 residual risks with on-chain limit + off-chain
  requirement structure; §9.8 extends the Yes/No signal table.
- **Sections §1–§8 unchanged** from V2.1 (F-16 response) — nothing removed or
  relaxed.

#### 11.3.8 Constructor guards (Rec #8 / R-01 / R-02)

- **Code**: `BaseStrategy` constructor — `extcodesize` check on `dexRouter_` (rejects
  EOA / self-destructed contracts); `DEPLOY_CHAIN_ID = block.chainid` captured as
  immutable; `DexRouterConfigured(dexRouter, chainId, dexRouterCodeSize)` event
  emitted at construction. `onlyDeployChain` modifier applied to all 5 fund-moving
  externals + `sweepIdleAssetToVault` + all 5 `claimAndCompound`.
- **New errors**: `DexRouterNotContract(dexRouter)`, `WrongChain(expected, actual)`.
- **Tests**: 5 specs — EOA dexRouter rejected, `address(0)` accepted as opt-out,
  event emitted with correct args, `DEPLOY_CHAIN_ID` matches current chain, fund-moving
  surface passes on the deploy chain.
- **Trust model reference**: `TRUST_MODEL.md` §9.6.

#### 11.3.9 Accrue-aware view math (self-identified post-submission addition)

> **Not one of Soken's original 8 pre-release recommendations**. Included in
> `v2.1.2` under Apyee's post-submission fix policy: view-function-only changes
> that are natural extensions of an already-audited invariant (Soken F-01 —
> accrue-BEFORE-preview) can be folded into the same tag without a formal
> re-review round. Reported here for transparency and Soken's optional confirmation.

- **Symptom (found in dev live-vault on Arbitrum, V2.1.1-dev, 2026-07-06)**: The
  frontend queries `maxWithdraw(user)` and issues `withdraw(that amount, ..., ...)`.
  The transaction reverts `ERC4626ExceededMaxWithdraw(user, requested, max)` by
  a small residual (`requested − max ≈ 31 wei` in the observed case) — enough to
  fail every "MAX button" flow after any yield has accrued.
- **Root cause**: `Vault.withdraw` (V2.1 F-01 pattern) calls `_accrue()` before
  `super.withdraw()`. `_accrue()` mints treasury shares against pending fee,
  reducing the effective per-share value. The view helpers `maxWithdraw` /
  `previewWithdraw` / `previewRedeem` / `convertToAssets` inherit OZ's base
  `_convertToAssets` / `_convertToShares` which use `totalSupply()` directly —
  they do NOT simulate the pending accrue, so the returned max is always slightly
  larger than the transactional path will honor.
- **Code**: `Vault.sol` — override `_convertToAssets` and `_convertToShares` to
  include `_pendingFeeShares()` in the divisor. Internal helper
  `_pendingFeeShares()` refactored out of the existing public `pendingFeeShares()`
  view so the overrides can reuse the same math without an external self-call.
- **Correctness on transactional path preserved**: `_deposit` / `_withdraw` /
  `mint` / `redeem` all call `_accrue()` before their internal `super` invocation.
  At the moment `_convertToAssets` runs inside those paths, `_pendingFeeShares()`
  returns 0 (accrue just happened) → the override is a **no-op on the tx path**.
  Correction applies only to external view queries.
- **Relation to Soken F-01**: F-01 patched the accrue-timing on the transactional
  path. This fix extends the same principle to view-side helpers so off-chain
  callers see the same accounting model the on-chain path enforces.
- **Tests**: 4 specs in `test/v2/Vault.maxWithdraw.spec.ts` — max reflects
  pending accrue, max withdraw after yield succeeds (primary regression), preview
  matches actual burn, zero-yield case matches base OZ behaviour (no-op invariant).
- **Live-vault impact**: v2.1.1-dev vaults are immutable and retain the pre-fix
  view; users work around via `redeem(shares)` (bypasses the assets-side max
  check) or by requesting an amount marginally below `maxWithdraw`. v2.1.2 new
  deployments carry the fix natively.

### 11.4 Acceptance criteria for the V2.1.2 review

All criteria below are evaluated against tag **`v2.1.2`**.

1. **F-04-MEV.1 (Rec #1)**: run `Strategy.mitigations.spec.ts` — 11 specs under
   *"minOut floor"*. All must pass. Manually verify `_computeMinOutFloor` uses
   Chainlink preferentially, falls back to Owner-set price, and rejects negative /
   stale / zero.
2. **F-04-MEV.2 (Rec #2)**: 8 specs under *"intermediate-hop whitelist"*. Verify
   endpoint tokens (rewardToken, USDC) remain bound by `_validateSwapPath` and are
   NOT subject to the whitelist (only middle hops).
3. **N-02 (Rec #3)**: 3 specs under *"pause-gate claimAndCompound"*. Confirm all 5
   concrete strategies apply `whenVaultNotPaused` and that user `withdraw` still
   works under pause.
4. **Rec #4**: 4 specs under *"rewardToken == underlying skip-swap"*. Verify the
   branch never touches `dexRouter` and re-deposits `amountIn` directly.
5. **Rec #5**: 5 specs under *"sweepIdleAssetToVault"*. Verify the destination is
   hardcoded (function signature has 0 args) and reward tokens are untouchable.
6. **M-BUILD-1 (Rec #6)**: `foundry.toml` shows `via_ir = true`; `hardhat compile`
   succeeds; whole suite passes.
7. **F-04-MEV.4 (Rec #7)**: `TRUST_MODEL.md` §9 documents all 8 mitigations and 4
   residual risks with the finding matrix in §9 preamble.
8. **Rec #8 / R-01 / R-02**: 5 specs under *"constructor guards"*. Verify EOA is
   rejected at deploy, `address(0)` is still accepted as opt-out, and
   `onlyDeployChain` reverts `WrongChain` off the deploy chain.
9. **Fix #9 (informational, self-identified)**: 4 specs under
   *"accrue-aware maxWithdraw / previewWithdraw"*. Verify view helpers reflect
   the pending accrue (`maxWithdraw` uses `totalSupply + pendingFeeShares`), a
   full-`maxWithdraw` `withdraw` succeeds after yield growth (primary regression),
   preview matches actual burn, and zero-yield case is a no-op vs the base OZ
   implementation.

Regression check: run the full V2.1.1 test suite against V2.1.2 on this repo — 103
pre-existing V2 tests must still pass (V2.1.2 adds 40 new specs — 36 for the 8 Soken
recommendations plus 4 for fix #9 — total 143 passing / 9 pending on
`npx hardhat test`).

---

## 12. V2.1.3 — Soken remediation-review residuals

> **Round-2 audit outcome**: Soken **APY-2026-06-002** — [`v2.1.2`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.2) reviewed 2026-07-06, verdict **PASS**, security score **88 / 100** (from 78 / 100). All 8 pre-release recommendations closed; the report flags 2 Low + 5 Informational residuals, none affecting principal. This section documents the follow-up code and doc changes that address the two actionable residuals (F-902 code fix, F-901 pre-existing hardening) plus the four comment/doc tightenings requested (F-i01 / F-i02 / F-i04 in-source, F-903 / F-i03 in the ops runbook).
>
> **Blockaid verify-project posture**: v2.1.3 is submitted to Soken for a diff confirmation (one-line addendum extending APY-2026-06-002 to cover the v2.1.3 tag). Prod deployment is gated on that confirmation so the verify-project submission package cites a report that matches the deployed bytecode.

### 12.1 Summary

| Item | Severity in APY-2026-06-002 | Fix location |
|---|---|---|
| **F-902** — fix #9 override not bit-identical under same-block accrue-latch | Low | `Vault.sol` — two `_convertToAssets` / `_convertToShares` overrides gated on `lastAccruedAt == block.timestamp` |
| **F-901** — `investToStrategy` not pause-gated | Info (pre-existing, Low under compromised-Keeper) | `Vault.sol` — `whenNotPaused` added to `investToStrategy` |
| **F-i04** — inflate/deflate trust direction backwards in `BaseStrategy.setRewardFallbackPrice` doc | Info | `BaseStrategy.sol` comment corrected |
| **F-i02** — `_computeMinOutFloor` dust truncation + USDC=$1 assumption not documented | Info | `BaseStrategy.sol` comment expanded |
| **F-i01** — TRUST_MODEL frames the floor as uniformly "on-chain" | Info | `docs/TRUST_MODEL.md` §9.2 tightened (Chainlink-strong vs. Owner-trust split) |
| **F-903** — Owner-trust for feed-less tokens + staleness DoS on URD expiry | Low | apyee-docs `SERVER_KEEPER_CLAIM.md` §11.2 runbook + `TRUST_MODEL.md` §9.2 note |
| **F-i03** — Owner config setters not chain-gated | Info | apyee-docs `SERVER_KEEPER_CLAIM.md` §11.2 runbook (deploy chain call reminder) |

### 12.2 F-902 fix — one-line gate exactly as Soken recommended

Per Soken §5.2 recommendation:

```solidity
uint256 pf = (lastAccruedAt == block.timestamp) ? 0 : _pendingFeeShares();
```

Applied to both `_convertToAssets` and `_convertToShares`. Uses `pf` in each divisor. The gate mirrors the same latch that governs `_accrue()` itself, so the override tracks exactly what a fresh accrue would (not) mint this block: nothing extra. Restores the "no-op on the transactional path" invariant stated in §11.3.9.

- **Same-block window** (`lastAccruedAt == block.timestamp`): pending term forced to 0 → override yields bit-identical result to base OZ. Closes the deposit-side leak Soken PoC measured at +2.56% over-mint under a self-funded donation.
- **Later blocks** (view queries outside the latch): pending term evaluated normally → external `maxWithdraw` / `previewWithdraw` etc. remain accrue-aware. Fix #9's original purpose (frontend MAX button no longer reverts `ERC4626ExceededMaxWithdraw`) is unchanged.

### 12.3 F-901 fix — `whenNotPaused` on `investToStrategy`

Per Soken §5.1 recommendation, single-chokepoint at the Vault level:

```solidity
function investToStrategy(address strategy, uint256 amount)
    external onlyKeeper whenNotPaused nonReentrant { ... }
```

Recovery-direction paths (`divestFromStrategy`, `emergencyWithdraw`) intentionally remain pause-free — user `withdraw` also remains pause-free (§6 core invariant unchanged). Guardian pause now closes the last principal-in path, matching the doc-comment on `whenVaultNotPaused`.

### 12.4 Test coverage

- `test/v2/Vault.v213.spec.ts` — 6 new specs:
  - **F-902**: `test_f902_sameBlockAccrueLatch_pendingIsZeroInsidePreview` (reproduces Soken's PoC scenario via `evm_setAutomine` — accrue + donate in one block, asserts `convertToShares == baseOZ`), `test_f902_multiBlock_pendingContinuesToBeReflectedInViews` (regression guard so fix does not over-correct).
  - **F-901**: `test_f901_investToStrategy_whenPaused_reverts`, `test_f901_investToStrategy_whenUnpaused_succeeds`, `test_f901_divestFromStrategy_whenPaused_stillSucceeds`, `test_f901_userWithdraw_whenPaused_stillSucceeds`.
- Full suite: **338 passing / 56 pending / 0 failing** on `apyee-contracts` main after V2.1.3 (was 332 → +6). apyee-protocol subset (V2 + mitigation + V2.1.3 specs) mirrors 143 → 149 passing.

### 12.5 Acceptance criteria for the v2.1.3 diff confirmation

Soken should confirm, in an addendum to APY-2026-06-002, that:

1. The one-line pending gate exactly matches §5.2's recommendation (source: `Vault.sol` — search "F-902 gate").
2. `investToStrategy` now carries `whenNotPaused` while `divestFromStrategy` / `emergencyWithdraw` / user `withdraw` remain pause-free (source: `Vault.sol`).
3. `BaseStrategy.setRewardFallbackPrice` comment now states **deflation** disables the floor (source: `BaseStrategy.sol`).
4. `BaseStrategy._computeMinOutFloor` comment now documents (i) dust truncation and (ii) implicit USDC = $1 (source: `BaseStrategy.sol`).
5. `TRUST_MODEL.md` §9.2 now frames the floor as Chainlink-strong vs. Owner-trust rather than uniformly on-chain (source: `docs/TRUST_MODEL.md`).
6. Full suite reproduces at **338 passing / 0 failing** on `apyee-contracts`, **149 passing / 0 failing** on `apyee-protocol`, PoC re-run inside `test/v2/Vault.v213.spec.ts` (auditor may cross-reference against their `Fix9_SameBlockAccrueLatch.t.sol`).

No change of audit scope; no new external interface; no state layout change; no allocation-cap change. Round-1 (16) and round-2 (25) findings remain fully mitigated. Zero regressions.
