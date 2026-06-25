# V2 Design Document — Apyee Vault V2

> Streaming performance fee + tier-parameterized allocation cap.
> Companion to the audit scope at [`contracts/Vault.sol`](../contracts/Vault.sol).

This document captures the design decisions and the mathematical reasoning
behind V2. It is excerpted from the internal design doc (`V2_VAULT.md`) and
intended for the audit firm.

---

## 0. Why V2

V1 (deployed 2026-05-28, in production on 4 chains) hit two limits that
required a new immutable deployment:

1. **`MAX_ALLOCATION_BPS_ABSOLUTE` was a `constant 4000`**, so an Aggressive
   tier (single strategy ≤ 60%) could not be expressed. A new contract was
   required to ship that tier.
2. **`harvest()` gas was disproportionate to TVL** — V1's share-price fee
   model required an explicit `harvest()` call by the Keeper. At small TVL
   the Keeper's harvest cycle alone consumed ~$4.5/day on Ethereum, well
   above the fees being accrued. Reducing call frequency made Treasury
   accounting irregular.

V2 addresses both by:
- Making `MAX_ALLOCATION_BPS_ABSOLUTE` an `immutable` constructor argument
  (Conservative 2500 / Balanced 4000 / Aggressive 6000 bps).
- Replacing `harvest()` with an action-time `_accrue()` that hooks into
  `_deposit` / `_withdraw` / `setFeeRate`. No Keeper gas, no manual call.

A single Solidity source can therefore produce N tier deployments — one
audit covers the entire matrix.

---

## 1. Decision Matrix (confirmed 2026-06-01)

| Decision | Choice | Rationale |
|---|---|---|
| Fee model | Yield-based streaming | Preserves principal during depeg, consistent with V1 marketing ("15% of yield") |
| HWM (High-Water-Mark) | **None** | Accounting simplicity + minimal audit surface; stablecoin loss-recovery is rare |
| Cap parametrization | `immutable` constructor argument | Single source → audit-once covers all tiers and chains |
| `_accrue()` trigger | Action-time only (`_deposit` / `_withdraw` / `setFeeRate`) | `totalAssets()` snapshot remains stable for DeFiLlama / Zapper (no view-time deduction) |
| Treasury accrual | Continuous share mint | Natural evolution of V1's accounting; gas-efficient (ERC-4626 native) |
| `harvest()` external | **Removed** | Keeper gas cost zero; fees accrue through time alone |

---

## 2. V1 → V2 Diff Matrix

| Item | V1 (v1-prod) | V2 (v2-prod) |
|---|---|---|
| `MAX_ALLOCATION_BPS_ABSOLUTE` | `constant 4000` | `immutable` (per-tier: 2500 / 4000 / 6000) |
| Fee trigger | `harvest()` (Keeper-called) | `_accrue()` (action hook) |
| Fee basis | Strategy `balanceOf` delta (`lastRecordedBalance`) | Share-price delta (`lastSharePrice`) |
| HWM | n/a (realized per-harvest) | None (intentional) |
| `harvest()` external | Present | **Removed** |
| `lastRecordedBalance` mapping | Present (per-strategy baseline) | **Removed** |
| `Harvested` event | Present | **Removed** |
| Baseline bump inside `_invest` | `lastRecordedBalance[s] += amount` | **Removed** (fee no longer derives from strategy P&L) |
| Baseline reduction inside `_divest` | `lastRecordedBalance[s] -= withdrawn` | **Removed** |
| Treasury fee accrual | Lump-sum share mint on `harvest` | Per-action incremental share mint |
| `FeesAccrued` event | n/a (used `Harvested`) | **New** |
| `pendingFeeShares()` view | n/a | **New** (off-chain UX helper) |
| Audit surface | ~630 LOC | ~470 LOC (− harvest / + accrue) |

---

## 3. `_accrue()` — Streaming Fee Algorithm

### 3.1 Pseudocode

```solidity
function _accrue() internal {
    if (lastAccruedAt == block.timestamp) return;
    if (totalSupply() == 0) { lastAccruedAt = block.timestamp; return; }

    uint256 sp = _calcSharePrice();   // TA × 1e18 / TS

    // [[1]] Loss tolerance — no fee, baseline tracks downward
    if (sp <= lastSharePrice) {
        lastAccruedAt = block.timestamp;
        lastSharePrice = sp;
        return;
    }

    // [[2]] Direct asset-unit math (no profitBps intermediate)
    //       V2.1 (Soken F-03): fee base is realized profit, not post-yield TA.
    //         feeAssets = TS × (sp - lastSp) / ACCRUE_PRECISION × feeRate / 10_000
    //       V2.0 used `TA × g × feeRate / 1e4` which over-charged by factor (1+g)
    //       (Soken §F-03). The supply-at-baseline base exactly matches the marketed
    //       "X% of yield" semantics.
    uint256 ts = totalSupply();
    uint256 feeAssets = ts.mulDiv(
        (sp - lastSharePrice) * feeRate,
        ACCRUE_PRECISION * 10_000,
        Math.Rounding.Floor
    );
    uint256 ta = totalAssets();

    if (feeAssets == 0) {
        lastAccruedAt = block.timestamp;
        lastSharePrice = sp;
        return;
    }

    // [[3]] Correct dilutive share-mint
    uint256 ts = totalSupply();
    uint256 feeShares = feeAssets.mulDiv(ts, ta - feeAssets, Math.Rounding.Floor);

    if (feeShares > 0) _mint(treasury, feeShares);

    // [[4]] Baseline = pre-mint sp (already taxed; do NOT re-read after mint)
    lastAccruedAt = block.timestamp;
    lastSharePrice = sp;

    emit FeesAccrued(feeAssets, feeShares, sp);
}
```

Full implementation: [`contracts/Vault.sol#L195-L260`](../contracts/Vault.sol#L195-L260)

### 3.2 Four audit-critical fixes

#### Fix [[1]] — Loss tolerance (no HWM)

When `sp ≤ lastSharePrice`:
- Fee is zero (principal protection).
- `lastSharePrice` is updated to the new (lower) `sp` (downward tracking).

This is **not** a high-water-mark model. After a loss, the next yield
recovery is taxed immediately — we accept that in exchange for accounting
simplicity. Stablecoin loss-recovery scenarios are rare; the alternative
(HWM mapping per user) significantly grows audit surface.

Example (V2.1 — see Fix [[2]] for the formula correction vs the V2.0 example):
```
Day 1:  sp = 1.000        TA $100,  TS 100 shares
Day 2:  loss 0.5%   sp = 0.995,  fee 0,  lastSp updated to 0.995
Day 3:  gain 1.0%   sp = 1.005,  profit = TS × (sp - lastSp) / 1e18 = $1.00 realized
                    feeAssets   = profit × 15% = $0.150
                    feeShares minted, lastSp = 1.005
```
Under HWM, Day 3's first 0.5% (the recovery portion) would be tax-free; we
tax it as well by design.

> V2.0 example printed $0.151 by computing `TA × g × feeRate`, which over-charged by
> a factor of (1+g). V2.1 charges `feeRate × realized profit` for exactly $0.150 —
> matches the "15% of yield" semantic the protocol markets.

#### Fix [[2]] — Direct asset-unit math (no `profitBps` truncation)

A naive intermediate "profit in bps" rounds away small daily yields:

```
Stable 5% APY → 1.37 bps/day
profitBps = (sp - lastSp) × 1e4 / lastSp = 1.37 → int(1.37) = 1
            → loses 0.37 bps/day (~27% of the actual yield)
```

Correct direct calculation with 1e18 precision via `Math.mulDiv` — V2.1 (Soken F-03):

```
feeAssets = TS × (sp - lastSp) × feeRate / (ACCRUE_PRECISION × 1e4)
          = (TS = 100 shares × 10^_decimalsOffset = 1e8)
          × (1.000137e18 - 1.0e18 = 1.37e14)
          × 1500 / (1e18 × 10000)
          = 1e8 × 1.37e14 × 1500 / 1.0e22
          = $0.0002055
```

V2.0 used `TA × (sp - lastSp) × feeRate / (lastSp × 1e4)`, which over-charged by
factor (1+g) where g is the share-price growth since the last accrue. V2.1's
supply-at-baseline form gives `feeRate × realized profit` exactly — matches the
marketed "15% of yield" headline.

`OZ Math.mulDiv` is overflow-safe and preserves precision.

#### Fix [[3]] — Correct dilutive share-mint formula

Using the OZ standard `convertToShares(feeAssets) = feeAssets × TS / TA`
introduces a self-reference error: after minting, the resulting `sp` is
slightly lower than intended (small undercharge of the fee).

Correct derivation — solving for `feeShares` such that the value of the
minted shares **at the diluted share price** equals `feeAssets`:

```
feeShares × (TA / (TS + feeShares)) = feeAssets
feeShares × TA = feeAssets × (TS + feeShares)
feeShares × (TA - feeAssets) = feeAssets × TS
feeShares = feeAssets × TS / (TA - feeAssets)
```

This ensures the post-mint share price is exactly `sp_pre × (TS / (TS + feeShares))`,
so `pendingFeeShares()` projections match the actual `_mint` result to the wei.

#### Fix [[4]] — Post-mint baseline is pre-mint `sp`; do not re-read

Calling `_calcSharePrice()` after the mint would record the diluted
post-mint `sp` as the new baseline. On the next accrue cycle:
- The "recovery" from the dilution would be measured as profit.
- The actual new yield would also be measured as profit.
- Both would be taxed — **double taxation**.

Correct baseline: the `sp` we just taxed (the pre-mint variable `sp`):
- Next cycle measures only "new yield above the level we already taxed".
- Dilution recovery is automatically excluded (the post-mint sp climbs
  back to `sp` with no fee charged).

### 3.3 Same-block guard

`if (lastAccruedAt == block.timestamp) return;` short-circuits all
subsequent calls in the same block. This is critical for the
`deposit + invest + harvest` flow that backends and external integrators
may bundle: only the first call accrues; later calls in the same block
no-op without re-reading state or re-emitting events.

`_accrue()` is also exposed as `accrue()` external (idempotent), so
off-chain services and integrators can pre-settle pending fees before a
view-heavy interaction. Calling it multiple times within a block is safe.

### 3.4 `pendingFeeShares()` — off-chain projection

A `view` helper that mirrors the `_accrue()` math without writing state.
External services use it to display "fees owed since last accrue" without
issuing a transaction. Invariant test
[`test/v2/Vault.invariant.spec.ts`](../test/v2/Vault.invariant.spec.ts)
asserts `pendingFeeShares() == actual feeShares minted` across yield /
loss / fee-rate-change scenarios, including sub-bps yield truncation.

---

## 4. Tier Deployment Matrix

### 4.1 Tier definitions

| Tier | `MAX_ALLOCATION_BPS_ABSOLUTE` | `feeRate` | Policy | Strategy whitelist |
|---|---|---|---|---|
| Conservative | 2500 (25%) | 1500 (15%) | Max diversification — ≤ 1/4 per strategy | Blue-chip only: aave / compound / morpho |
| Balanced | 4000 (40%) | 1500 (15%) | V1-equivalent policy | aave / compound / morpho / fluid / spark (/ kinza, venus per chain) |
| Aggressive | 6000 (60%) | 1500 (15%) | Single-strategy concentration up to 3/5, curated MetaMorpho vaults | A4 (Aave / Compound / Moonwell Flagship USDC MetaMorpho / Fluid) + B4 (Gauntlet USDC Prime / Steakhouse USDC / Steakhouse Prime USDC / Pangolins USDC) — Base only |

All tiers share `feeRate = 1500 bps`. Per-tier differentiated fees were
considered and rejected (marketing complexity without proportional value).

### 4.2 Phase 1 deployment topology

| Chain | Conservative | Balanced | Aggressive |
|---|---|---|---|
| Ethereum | — | ✓ | — |
| Base | — | ✓ | ✓ |
| Arbitrum | — | ✓ | — |
| BNB Chain | — | ✓ | — |

Five vaults total. Conservative is intentionally not deployed in Phase 1 —
adding it later is a redeploy with no audit implication (same source, same
runtime bytecode except for the immutable cap and `VERSION_HASH`).

### 4.3 `VERSION_HASH` matrix

Each (generation × tier) gets a distinct `VERSION_HASH`. Backends and the
Keeper bot assert against this to fail-fast on environment mismatch.

| Generation | Tier | Version string | `VERSION_HASH` |
|---|---|---|---|
| v2-dev | conservative | `2.0.0-dev-conservative` | `keccak256("2.0.0-dev-conservative")` |
| v2-dev | balanced | `2.0.0-dev-balanced` | `keccak256("2.0.0-dev-balanced")` |
| v2-dev | aggressive | `2.0.0-dev-aggressive` | `keccak256("2.0.0-dev-aggressive")` |
| v2-prod | conservative | `2.0.0-prod-conservative` | `keccak256("2.0.0-prod-conservative")` |
| v2-prod | balanced | `2.0.0-prod-balanced` | `0xfdb55585a303e75f7a4789857f4098cb223dc75837bbb8578ac57d0410e2d833` |
| v2-prod | aggressive | `2.0.0-prod-aggressive` | `0x08cea3a61fa9df526030aa93f19280a5e701e966a04a5b02c34a589d7721a72b` |

Same source, different `MAX_ALLOCATION_BPS_ABSOLUTE` immutable, different
`VERSION_HASH` constructor argument → six distinct runtime bytecodes from
one audited source.

---

## 5. Migration (v1-prod → v2-prod)

V1 contracts are immutable; there is no automatic migration. The intended
flow is voluntary user migration (Yearn / Uniswap pattern):

1. V2 is deployed and stabilized in production.
2. The V1 Owner calls `setDepositCap(0)` to halt new V1 deposits
   (Multi-sig).
3. UI prompts existing V1 users to withdraw and redeposit into V2 (tier
   selection).
4. After ~6 months and near-zero residual TVL, V1 may be paused (optional).
   V1 contracts remain on-chain forever so any residual users can still
   withdraw.

This document and `Vault.sol` are scoped to V2. V1 migration tooling
(parking-wallet sweep) is out of audit scope — it interacts only via the
public ERC-4626 `withdraw` / `deposit` surface.

---

## 6. V2.1 — Soken Audit Remediation (2026-06-25)

Soken security audit (APY-2026-06-001, 2026-06-23) found 16 findings in V2.0;
9 required code changes, landed on `feat/v2.1`. Full mapping in
[`docs/SOKEN_AUDIT.md`](SOKEN_AUDIT.md).

### 6.1 Behavioral fixes

**F-17 (Critical) — Vault brick via stale `lastSharePrice`**
After `totalSupply()` returns to zero (all holders exit), the never-reset
baseline detonates the `FeeTooHigh` guard on the next deposit, freezing every
entrypoint. Soken Foundry PoC confirmed. Fix: reset `lastSharePrice = 0` in
both `_accrue()`'s `totalSupply()==0` branch and `_withdraw()` after the post-
burn check. Next deposit re-takes the lazy-init path.

**F-01 (Medium) — Accrue-first ordering keeps deposit/redeem fair**
OpenZeppelin ERC4626 prices `previewDeposit`/`previewWithdraw` before the
`_deposit`/`_withdraw` hook runs. V2.0's `_accrue()` inside those hooks fired
after the share count was fixed, so the fee-share mint diluted the pool
post-pricing. Fix: override the four public entrypoints to call `_accrue()`
before delegating to `super`. Hook-internal `_accrue()` calls retained as
defense-in-depth (same-block guard makes the second call a no-op).

**F-02 + F-07 (Medium / Low) — `strategyList` swap-and-pop**
`removeStrategy` left the address in `strategyList`, so re-adding the same
strategy created a duplicate that `totalAssets()` double-counted. Fix: swap-
and-pop on remove. Each strategy address appears at most once.

**F-03 (Low) — Fee = realized profit, not post-yield TA**
Documented in §3 above. V2.0's `TA × g × feeRate` charged `feeRate × profit ×
(1+g)`. V2.1's `TS × Δsp / 1e18 × feeRate` charges exactly `feeRate × profit`.

**F-05 (Informational) — Owner quarantine escape hatch**
`StrategyInfo` gains an `isQuarantined` flag + an `setQuarantine(address, bool)`
Owner function. Quarantined strategies are skipped in `totalAssets()` and
`_autoPullFromStrategies` and rejected by `investToStrategy`. Naive try-catch
return-0 (silently understates NAV) was rejected per Soken §F-05 guidance.

**F-06 (Low) — `Ownable2Step` + `renounceOwnership()` disabled**
`Ownable` → `Ownable2Step` so transfer requires `acceptOwnership` from the
candidate (typos rejected). `renounceOwnership` reverts — an immutable yield
vault must never be ownerless.

**F-15 (Informational) — Removed 4 unused custom errors**
`NotOwner`, `InvalidAllocation`, `WithdrawalExceedsBalance`,
`StrategyBlacklisted` (the error; the same-named event in `Vault.sol` stays in
active use).

### 6.2 V2.1 reward claim mechanism (F-04)

Yearn V2 / Beefy pattern — each strategy exposes `claimAndCompound(...)`,
gated by `onlyKeeper`. The strategy calls its protocol's distributor → swaps
the reward to USDC via UniswapV3 SwapRouter02 (PancakeV3 SmartRouter on BSC)
→ re-deposits into the same external protocol. The resulting `balanceOf()`
growth flows into `Vault.totalAssets()` and the streaming-fee `_accrue()`
captures the operator's 15% share automatically on the next user action — no
explicit fee plumbing needed.

| Strategy | Distributor entrypoint | Reward token source |
|---|---|---|
| `CompoundV3Strategy` | `cometRewards.claim(comet, this, true)` | dynamic via `rewardConfig` (COMP) |
| `VenusStrategy` | `comptroller.claimVenus(this, [vToken])` | constructor-pinned (XVS) |
| `AaveV3Strategy` (+ Spark/Kinza) | `rewardsController.claimRewards([aToken], max, this, reward)` | constructor-pinned (per fork: SPK / KINZA / stkAAVE) |
| `MorphoStrategy` | `urd.claim(this, reward, claimable, proof)` | per-call (Keeper supplies reward + cumulative + merkle proof) |
| `FluidStrategy` | `fluidDistributor.claim(this, cum, posType, posId, cycle, proof, metadata)` | constructor-pinned (FLUID, formerly INST) |

Fluid's distributor enforces `msg.sender == recipient` — that's why the call
must originate from the strategy itself. A Keeper invoking the distributor
directly would revert `MsgSenderNotRecipient`.

Per-chain DEX router (constructor-bound, immutable):
- Ethereum / Arbitrum — UniV3 SwapRouter02 `0x68b34658...8665Fc45`
- Base — UniV3 SwapRouter02 `0x2626664c...741e481`
- BSC — PancakeV3 SmartRouter `0x13f4EA83...74568Dd4`

The Keeper bot evaluates `rewardUsd ≥ gasUsd × 5` before invoking the call.
Per-chain break-even (at typical gas):
- Ethereum: ~$150-250 reward minimum
- Base / Arbitrum: ~$0.25-0.50
- BSC: ~$5-10

The strategy `claimAndCompound` is a no-op (returns `(0, 0)`) when the
distributor / reward token was set to `address(0)` at deploy — supports
chains where the reward program is dormant.

### 6.3 F-04g — chain × strategy reward matrix

`scripts/deploy/00-config.ts` adds:
- `ChainConfig.dexRouter` (per chain)
- Per-strategy optional `rewardsController`, `rewardToken`, `cometRewards`,
  `urd`, `comptroller`, `fluidDistributor` fields

Known addresses are pinned (ETH/Base/Arb Compound CometRewards, Ethereum
Morpho URD, Ethereum Fluid distributor, BSC Venus Comptroller + XVS).
Addresses still under verification (Spark / Kinza RewardsController, Base/Arb
Morpho URD, Base/Arb/BSC Fluid distributor) are `ethers.ZeroAddress` opt-out
until confirmed via a follow-up redeploy.

### 6.4 Test coverage

[`test/v2/Vault.v21.spec.ts`](../test/v2/Vault.v21.spec.ts) — 14 specs that
exercise every behavioral V2.1 fix, with inverse pre-fix behavior documented
inline so regressions on the same root cause are caught by the same test.
Full hardhat suite: 92 passing on the public repo (281 on the private dev
repo which carries V1 specs as well). Foundry forge fuzz: 10 properties ×
10 000 randomized iterations each, zero failures.

### 6.5 V2.0 → V2.1 deployment migration

V2.0 vaults are immutable; V2.1 fixes need a fresh deploy:

1. Add `v2.1-prod` / `v2.1-dev` to the version-hash matrix
   ([`scripts/deploy/v2/00-tier-config.ts`](../scripts/deploy/v2/00-tier-config.ts)).
2. Deploy V2.1 vaults across all 4 chains × tiers.
3. V2.0 Owner calls `setDepositCap(0)` to halt new V2.0 deposits.
4. UI prompts existing V2.0 holders to redeem and redeposit into V2.1.
5. Treasury redeems any residual V2.0 fee shares (see `safe-batches/v2-prod/`).
6. V2.0 contracts remain on-chain forever for residual exits (V1 → V2
   migration pattern in §5).

---

## 7. References

- [`contracts/Vault.sol`](../contracts/Vault.sol) — V2 Vault source
- [`contracts/strategies/`](../contracts/strategies/) — adapter contracts
- [`test/v2/`](../test/v2/) — unit, invariant, adversarial, fork test suites
- [`docs/SOKEN_AUDIT.md`](SOKEN_AUDIT.md) — Soken finding → V2.1 fix mapping
- [`deployments/v2-prod/`](../deployments/v2-prod/) — machine-readable
  deployed-address records
- ERC-4626 specification: https://eips.ethereum.org/EIPS/eip-4626
- OpenZeppelin Contracts 5.x: https://docs.openzeppelin.com/contracts/5.x/
