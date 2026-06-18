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
    uint256 ta = totalAssets();
    uint256 feeAssets = ta.mulDiv(
        (sp - lastSharePrice) * feeRate,
        lastSharePrice * 10_000,
        Math.Rounding.Floor
    );

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

Example:
```
Day 1:  sp = 1.000        TA $100,  TS 100 shares
Day 2:  loss 0.5%   sp = 0.995,  fee 0,  lastSp updated to 0.995
Day 3:  gain 1.0%   sp = 1.005,  profit = (1.005-0.995)/0.995 = 1.005%
                    feeAssets   = TA × 1.005% × 15% = $0.151
                    feeShares minted, lastSp = 1.005
```
Under HWM, Day 3's first 0.5% (the recovery portion) would be tax-free; we
tax it as well by design.

#### Fix [[2]] — Direct asset-unit math (no `profitBps` truncation)

A naive intermediate "profit in bps" rounds away small daily yields:

```
Stable 5% APY → 1.37 bps/day
profitBps = (sp - lastSp) × 1e4 / lastSp = 1.37 → int(1.37) = 1
            → loses 0.37 bps/day (~27% of the actual yield)
```

Correct direct calculation with 1e18 precision via `Math.mulDiv`:

```
feeAssets = TA × (sp - lastSp) × feeRate / (lastSp × 1e4)
          = $100 × (1.000137e18 - 1.0e18) × 1500 / (1.0e18 × 10000)
          = $100 × 1.37e14 × 1500 / 1.0e22
          = $0.0002055
```

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

## 6. References

- [`contracts/Vault.sol`](../contracts/Vault.sol) — V2 Vault source
- [`contracts/strategies/`](../contracts/strategies/) — adapter contracts
- [`test/v2/`](../test/v2/) — unit, invariant, adversarial, fork test suites
- [`deployments/v2-prod/`](../deployments/v2-prod/) — machine-readable
  deployed-address records
- ERC-4626 specification: https://eips.ethereum.org/EIPS/eip-4626
- OpenZeppelin Contracts 5.x: https://docs.openzeppelin.com/contracts/5.x/
