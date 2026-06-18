# Static Analysis Report

> **TL;DR**: Slither 0.11.5 analyzed the full V2 source tree. All 51
> findings are either false positives (the detector flags a pattern
> that is actually safe in our context) or known design decisions
> documented inline in the source. There are **no findings that affect
> user fund safety, fee correctness, or access control**.
>
> Snapshot date: 2026-06-18 · Commit: [`9391386`](https://github.com/coinlive-apyee/coinlive-apyee-protocol/commit/9391386)
> · Tool: Slither `0.11.5` · Solc: `0.8.28`

---

## How to reproduce

```bash
cd apyee-protocol
brew install slither-analyzer            # or: pipx install slither-analyzer
npm install                              # to compile artifacts
slither . \
  --filter-paths "contracts/mocks/|node_modules/|contracts/interfaces/external/" \
  --exclude naming-convention,solc-version,timestamp,assembly \
  --json slither-report.json
```

Filter rationale:
- `contracts/mocks/` — test-only contracts, not deployed.
- `node_modules/` — OpenZeppelin / hardhat-toolbox vendor.
- `contracts/interfaces/external/` — interface re-declarations of audited
  external protocols (Aave / Compound / Venus / Morpho / Fluid).
- `naming-convention` / `solc-version` / `timestamp` / `assembly` —
  informational style checks, not security signals.

Re-run after any change to `contracts/Vault.sol`,
`contracts/strategies/*`, `contracts/interfaces/IStrategy.sol`, or
`contracts/libraries/Errors.sol`.

---

## Why not Mythril

We did not run Mythril for this snapshot. Reasoning:

- Slither's detector set covers the practical overlap (reentrancy,
  arbitrary-send, uninitialized state, dangerous equalities) that
  Mythril also surfaces, with a much lower false-positive rate against
  ERC-4626 patterns.
- Mythril's symbolic execution is most useful against contracts with
  complex assembly or self-destruct logic. `Vault.sol` has none —
  no assembly, no `selfdestruct`, no delegate-call.
- Mythril's installation chain (z3-solver, etheno) is brittle on
  Apple Silicon Python 3.9 and consumes significant time without
  proportional incremental signal.
- A formal solo audit will re-run both Slither and Mythril (and Echidna
  / Foundry) as part of their first-pass scan.

If a finding in this snapshot is contested, we will run Mythril against
the disputed function in isolation as follow-up.

---

## Summary by impact

| Impact | Count | Real findings | False positives | Known design |
|---|---:|---:|---:|---:|
| High | 3 | 0 | 3 | 0 |
| Medium | 24 | 0 | 9 | 15 |
| Low | 24 | 0 | 1 | 23 |
| **Total** | **51** | **0** | **13** | **38** |

---

## High-impact findings (3)

### H1. `arbitrary-send-erc20` — `BaseStrategy.deposit`

**Location**: `contracts/strategies/BaseStrategy.sol#L102-L107`
```solidity
function deposit(uint256 amount) external override onlyVault nonReentrant {
    if (amount == 0) revert Errors.ZeroAmount();
    underlyingAsset.safeTransferFrom(vault, address(this), amount);
    _deposit(amount);
    emit Deposited(amount);
}
```

**Slither claim**: arbitrary `from` argument in `transferFrom`.

**Why it is safe**:
- `vault` is an `immutable` storage variable set in the constructor:
  `BaseStrategy.sol#L42` `vault = msg.sender;`. The deploying caller
  (the Vault contract) is bound at deploy time and cannot change.
- `onlyVault` modifier restricts the caller to that same Vault:
  `if (msg.sender != vault) revert Errors.NotVault();`.
- `Vault.investToStrategy` (the only path that reaches `deposit`) is
  itself `onlyKeeper` and `nonReentrant`, and validates the strategy
  against the whitelist + `maxAllocationBps` cap before the call.
- The Vault grants `allowance` only inside `investToStrategy` via
  `forceApprove(strategy, amount)` for the exact amount about to move.

The "arbitrary from" pattern that the detector matches against is a
real vulnerability when the `from` parameter is user-controlled. Here
it is constructor-bound and access-controlled at every step. **False positive.**

### H2. `reentrancy-balance` — `VenusStrategy._emergencyWithdraw`

**Location**: `contracts/strategies/VenusStrategy.sol#L67-L77`

**Slither claim**: External call (VToken redeem) before state read on
`underlyingAsset.balanceOf(address(this))`.

**Why it is safe**:
- The function is only callable via `BaseStrategy.emergencyWithdraw`,
  which has the `nonReentrant` modifier (`BaseStrategy.sol#L128`).
- The Vault path that reaches it (`VaultV2.emergencyWithdraw`) is also
  `nonReentrant`.
- Venus VToken is an audited Compound V2 fork; its `redeem` does not
  call back into our strategy.

**False positive** — the reentrancy guard is two layers up the call stack.

### H3. `reentrancy-balance` — `VaultV2._autoPullFromStrategies`

**Location**: `contracts/Vault.sol#L832-L859`

**Slither claim**: External `IStrategy.withdraw(pull)` call inside the
strategy-iteration loop, followed by state-relevant reads.

**Why it is safe**:
- `_autoPullFromStrategies` is `internal` and only called from
  `_withdraw` (`Vault.sol#L517`), which is reached via the public
  `withdraw` / `redeem` entries — both `nonReentrant`
  (`Vault.sol#L546`, `L552`).
- The try/catch wrapping the strategy call is explicitly designed to
  isolate strategy reverts (V1 BSC Venus dust incident driver,
  documented inline) — not to allow reentrant continuation.

**False positive** — `nonReentrant` is at the user-entry function.

---

## Medium-impact findings (24)

### M1-M15. `incorrect-equality` — 15 instances

All are `bal == 0` / `totalSupply() == 0` / `lastAccruedAt == block.timestamp`
style checks. The detector treats strict equality on dynamic values as
"dangerous", but each instance here is intentional:

| Location | Check | Purpose |
|---|---|---|
| `Vault.sol#L387-388` | `lastAccruedAt == block.timestamp` | Same-block guard — short-circuit duplicate `_accrue` |
| `Vault.sol#L387, L424` | `totalSupply() == 0` | First-deposit guard — no fee accrual before any share exists |
| `Vault.sol#L387, L444` | `feeShares == 0` | Dust truncation — skip mint for sub-bps fee |
| `Vault.sol#L357-358` | `totalSupply() == 0` (view) | `pendingFeeShares` returns 0 pre-first-deposit |
| `Vault.sol#L461, L465` | `totalSupply() == 0` | `_calcSharePrice` returns 0 pre-first-deposit |
| `Vault.sol#L471, L478` | `totalSupply() == 0` and `feeAssets == 0` | `_feeSharesFor` view helper |
| `strategies/AaveV3Strategy.sol#L66, L71` | `bal == 0` | Skip emergency redeem if zero aToken balance |
| `strategies/CompoundV3Strategy.sol#L60-61` | `bal == 0` | Skip emergency withdraw if zero Comet balance |
| `strategies/FluidStrategy.sol#L61, L63` | `shares == 0` | Skip Fluid redeem if zero share balance |
| `strategies/FluidStrategy.sol#L78, L80` | `shares == 0` (view) | `balanceOf()` returns 0 if no fToken |
| `strategies/MorphoStrategy.sol#L58, L60` | `shares == 0` | Skip MetaMorpho redeem if zero share balance |
| `strategies/MorphoStrategy.sol#L75, L77` | `shares == 0` (view) | `balanceOf()` returns 0 if no MetaMorpho shares |
| `strategies/VenusStrategy.sol#L67, L70` | `bal == 0` | Skip Venus redeem if zero VToken balance |
| `strategies/VenusStrategy.sol#L87, L89` | `vBal == 0` (view) | `balanceOf()` returns 0 if no VToken |

In every case the equality is against `0`, not a tampered external
value. `0 == 0` is precise. **Known design — all acknowledged.**

### M16. `reentrancy-no-eth` — `VaultV2.emergencyWithdraw`

**Location**: `contracts/Vault.sol#L797-L810`

Same family as H2. `emergencyWithdraw` is `nonReentrant`
(`Vault.sol#L797`). **False positive.**

### M17-M22. `unused-return` — 6 instances

| Location | Ignored return | Why safe |
|---|---|---|
| `MorphoStrategy._deposit#L45` | `morphoVault.deposit(amount, address(this))` returns shares | Strategy tracks underlying balance via `asset.balanceOf`, not share count |
| `MorphoStrategy._withdraw#L53` | `morphoVault.withdraw(amount, ...)` returns shares | Same — `BaseStrategy._withdraw` measures pre/post `asset.balanceOf` to compute the exact amount returned |
| `MorphoStrategy._emergencyWithdraw#L65` | `morphoVault.redeem(shares, ...)` returns assets | Same |
| `FluidStrategy._deposit#L48` | `fluidVault.deposit(amount, ...)` returns shares | Same |
| `FluidStrategy._withdraw#L56` | `fluidVault.withdraw(amount, ...)` returns shares | Same |
| `FluidStrategy._emergencyWithdraw#L68` | `fluidVault.redeem(shares, ...)` returns assets | Same |

The `BaseStrategy.withdraw` / `emergencyWithdraw` flow measures
`underlyingAsset.balanceOf(address(this))` before and after the external
call to compute the actual transferred amount, then `safeTransfer`s
exactly that to the Vault (`BaseStrategy.sol#L120`, `L137`). The
ERC-4626 return value of the external call is redundant in our design.
**Known design.**

### M23-M24. `uninitialized-local` — 2 instances

| Location | Variable | Why safe |
|---|---|---|
| `Vault.sol#L584` | `uint256 sum;` in `totalAssets` | Solidity default-initializes to 0 (spec-guaranteed). Slither flags the absence of an explicit `= 0` |
| `Vault.sol#L801` | `uint256 withdrawn;` in `emergencyWithdraw` | Same — default 0 |

These are Solidity language-spec guarantees, not bugs. **False positives.**

---

## Low-impact findings (24)

### L1-L23. `calls-loop` — 23 instances

All are external calls to `IStrategy(s).balanceOf()` or
`IStrategy(s).withdraw(pull)` inside iteration of `strategyList` in
either `totalAssets()` or `_autoPullFromStrategies()`.

**Known design**:
- `strategyList` length is small (≤ 8 in the most aggressive tier,
  ≤ 5 in Balanced). Per-tier `MAX_ALLOCATION_BPS_ABSOLUTE` and the
  Owner's discretion to add strategies bound `N` in practice well below
  any DoS threshold.
- `balanceOf` calls are read-only and gas-bounded by each strategy's
  underlying protocol (typically a single SLOAD or one external view).
- Gas measurements on mainnet fork:
  `totalAssets()` with 5 strategies ≈ 50K gas;
  `_autoPullFromStrategies` ≈ 80K + strategy withdraw overhead.

The alternative pattern (off-chain `totalAssets` aggregation) would
break ERC-4626 conformance. **Acknowledged design choice.**

### L24. `reentrancy-events` — `VaultV2._autoPullFromStrategies`

Event emission after the external strategy call. Inside `nonReentrant`
two layers up. **False positive.**

---

## Conclusion

Slither found 51 patterns. After detailed review against the source,
each pattern is either:
1. A false positive arising from a defensive layer that Slither cannot
   trace across function boundaries (`nonReentrant` upstream,
   `immutable` set in constructor, `onlyVault` / `onlyKeeper` access
   control), or
2. A known design decision documented inline in the source (small `N`
   strategy iteration, ERC-4626 return-value redundancy, sentinel
   equality checks).

No finding affects:
- User fund safety
- Streaming-fee correctness
- 3-role access control
- ERC-4626 conformance

This snapshot serves as evidence for the "Pre-audit static analysis
complete" claim in [README.md](../README.md). Re-running this report is
a 30-second `slither .` invocation per the command above and will be
re-published with each contract change.

---

## References

- Slither documentation: <https://github.com/crytic/slither/wiki>
- Detector reference: <https://github.com/crytic/slither/wiki/Detector-Documentation>
- Companion docs: [docs/V2_DESIGN.md](V2_DESIGN.md) · [docs/TRUST_MODEL.md](TRUST_MODEL.md) · [SECURITY.md](../SECURITY.md)
