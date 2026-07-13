# Apyee Protocol

> Non-custodial, AI-powered stablecoin yield aggregator — ERC-4626 Vault.

**Website**: [apyee.com](https://apyee.com) &nbsp;·&nbsp; **Source (HEAD)**: [`v2.1.3`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.3) &nbsp;·&nbsp; **Prod deployed**: `v2.1.3` (2026-07-13) &nbsp;·&nbsp; **License**: BUSL-1.1 &nbsp;·&nbsp; **Security**: [`support@apyee.com`](mailto:support@apyee.com)

Apyee allocates user-deposited USDC across whitelisted DeFi lending strategies
on Ethereum, Base, Arbitrum, and BNB Chain. The Vault is **immutable** (no
upgradeable proxy), and the operator **cannot move user funds** — those code
paths do not exist.

---

## Status — Soft Launch (v2.0.0, 2026-06) · Audit remediation (v2.1 → v2.1.3)

V2 introduces a **streaming performance fee** and a **tier-based allocation
cap** so a single Solidity source can produce multiple deployment configs
(Conservative / Balanced / Aggressive). Phase 1 launches Balanced on all 4
chains plus Aggressive on Base.

**Post-Soft-Launch audit cycle** (2026-06 → 2026-07):

- [`v2.1.0`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.0) — Soken **APY-2026-06-001** round-1 remediation (16 findings, all mitigated). See [`docs/SOKEN_AUDIT.md`](docs/SOKEN_AUDIT.md) §1–§10.
- [`v2.1.1`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.1) — F-04 follow-up (multi-hop reward-token swap path).
- [`v2.1.2`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.2) — Soken **APY-2026-06-002** round-2 remediation. **Verdict PASS 88/100** — 8 pre-release recommendations + 1 self-identified accrue-aware view fix (#9) closed; the round-2 report flagged 2 Low + 5 Informational residuals, none affecting principal. See `SOKEN_AUDIT.md` §11 and `TRUST_MODEL.md` §9.
- [`v2.1.3`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.3) — round-2 residual response. Applies the two actionable one-line changes Soken recommended (F-902 fix-#9 invariant restore, F-901 pre-existing pause-gap hardening) plus comment/doc tightenings for F-i01 / F-i02 / F-i04 / F-903 / F-i03. See `SOKEN_AUDIT.md` §12. **Soken addendum APY-2026-06-002-B received 2026-07-09 — verdict PASS 91/100, 0 new findings, extends APY-2026-06-002 to cover v2.1.3 bytecode.**

Prod migrated to `v2.1.3` on 2026-07-13 across all 4 chains (see addresses below).
Owner transferred to Gnosis Safe multi-sig (Ownable2Step Step A + Step B completed);
v2.0.0 vaults are now retired.

### What's verified

| Layer | Status | Evidence |
|---|---|---|
| Strategy adapters (Aave / Compound / Morpho / Venus / Fluid) | **Battle-tested** | Identical source as V1 (`v1.0.0`). 2 months in production on 4 chains, zero security incidents. See [`v1.0.0` release](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v1.0.0) and on-chain history of V1 vaults. |
| Vault permissions / 3-role separation / asset-movement paths | **Line-by-line documented** | [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md) — every `onlyOwner` / `onlyKeeper` / `onlyGuardian` function enumerated with line references against `Vault.sol`. |
| Streaming-fee math (`_accrue()`) — **new in V2** | Internal review + unit / invariant / adversarial test suite (78 passing) | [docs/V2_DESIGN.md](docs/V2_DESIGN.md) §3 documents the four audit-critical fixes and the invariant proofs. Coverage table in this README. |
| Tier-parameterized allocation cap (immutable) | Verified across 3 tiers | `test/v2/Vault.spec.ts` includes per-tier deploy + invariant tests. |
| Static analysis (Slither 0.11.5) | **Complete — no real findings** | [docs/STATIC_ANALYSIS.md](docs/STATIC_ANALYSIS.md): 51 patterns surfaced, all classified as false positives or known design (acknowledged inline). Reproducible via `slither .` |
| Streaming-fee fuzz harness (Foundry 1.7.1) | **Complete — 100K iterations, zero failures** | [docs/FUZZ_REPORT.md](docs/FUZZ_REPORT.md): 10 properties × 10,000 randomized runs covering the four `_accrue()` fixes plus seven adjacent invariants (`MAX_FEE` bound, pause-does-not-block-withdraw, etc.). Reproducible via `forge test --fuzz-runs 10000` |
| External solo audit (Soken) — round 1 (V2.0 → V2.1) | **Complete — 16 findings, all mitigated at `v2.1.0` / `v2.1.1`** | [docs/SOKEN_AUDIT.md](docs/SOKEN_AUDIT.md) §1–§10 — finding-to-fix mapping, per-severity acceptance criteria. Reproducible via `git checkout v2.1.1 && npx hardhat test`. |
| External solo audit (Soken) — round 2 (V2.1.1 F-04 surface) | **Verdict PASS 88/100 at `v2.1.2`; residual-review addendum APY-2026-06-002-B PASS 91/100 at `v2.1.3` (2026-07-09, 0 new findings)** | [docs/SOKEN_AUDIT.md](docs/SOKEN_AUDIT.md) §11 (round-2 remediation) + §12 (v2.1.3 residual response). 149 passing / 0 regression + Foundry fuzz 10 × 10k green. Reproducible via `git checkout v2.1.3 && npx hardhat test && forge test --fuzz-runs 10000`. |

### What's pending

| Item | Status |
|---|---|
| Blockaid verify-project (v2.1.3-prod addresses) | Submitted 2026-07-13 — awaiting confirmation |
| Bug bounty (Immunefi) | In preparation |
| Contest audit (Code4rena / Sherlock / Cantina) | Planned |

### Operating limits during Soft Launch

- Per-chain deposit cap: **$500K USDC** (Conservative tier: $250K)
- Per-user deposit cap: **$25K USDC** default (Owner-configurable per address)
- Performance fee: **1500 bps (15%)**, streaming model — accrued continuously
  on share-price growth, hooked into `_deposit` / `_withdraw` / `setFeeRate`
- Emergency pause: available (Guardian); **`withdraw()` remains open even while paused**
- Cap raises are Owner-only via `setDepositCap` / `setDefaultUserCap` Multi-sig calls — see [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md) for the full power list

### Per-tier `MAX_ALLOCATION_BPS_ABSOLUTE`

| Tier | Cap | Rationale |
|---|---|---|
| Conservative | 2500 bps (25%) | Blue-chip pools only, max diversification |
| Balanced | 4000 bps (40%) | V1-equivalent risk policy |
| Aggressive | 6000 bps (60%) | Higher per-pool concentration for curated MetaMorpho vaults |

The cap is an `immutable` constructor parameter — embedded in runtime
bytecode at deploy time. Cannot be changed post-deploy.

### `VERSION_HASH` matrix

| Tier | `keccak256(version)` |
|---|---|
| Balanced (prod) | `0xfdb55585a303e75f7a4789857f4098cb223dc75837bbb8578ac57d0410e2d833` |
| Aggressive (prod) | `0x08cea3a61fa9df526030aa93f19280a5e701e966a04a5b02c34a589d7721a72b` |

Each tier is a distinct on-chain generation. Call `Vault.VERSION_HASH()` to
verify which tier you're interacting with — a different hash indicates a
non-production deployment (e.g. internal `v2-dev` testbench).

---

## Deployed Contracts (V2.1.3-prod)

Machine-readable: [`deployments/v2.1.3-prod/`](deployments/v2.1.3-prod/)

### Vaults

| Chain | Tier | Vault | Explorer |
|---|---|---|---|
| Ethereum | Balanced | `0xE46aac58214B963125a3A88541e1DBE56c4eD5f7` | [etherscan](https://etherscan.io/address/0xE46aac58214B963125a3A88541e1DBE56c4eD5f7#code) |
| Base | Balanced | `0xeA8FB89F44A1fa47E52354D44E7e6D4682C8529a` | [basescan](https://basescan.org/address/0xeA8FB89F44A1fa47E52354D44E7e6D4682C8529a#code) |
| Base | Aggressive | `0x87922c630A980e431fb045A178e53F58d3f07F85` | [basescan](https://basescan.org/address/0x87922c630A980e431fb045A178e53F58d3f07F85#code) |
| Arbitrum | Balanced | `0x94f89d1E2825d40627CD2aE24Eba8590F675049C` | [arbiscan](https://arbiscan.io/address/0x94f89d1E2825d40627CD2aE24Eba8590F675049C#code) |
| BNB Chain | Balanced | `0x27DB5a2B203D6bd3C9490E8EA4488B968675f5Bf` | [bscscan](https://bscscan.com/address/0x27DB5a2B203D6bd3C9490E8EA4488B968675f5Bf#code) |

All Vaults are **verified** on the respective explorer. Source identical to
this repo at tag [`v2.1.3`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.3) (commit `e737779`), covering the Soken addendum
APY-2026-06-002-B PASS 91/100. Prior `v2.0.0` vaults have been retired.

### Strategy adapters

Full per-chain breakdown lives in
[`deployments/v2.1.3-prod/balanced/<chain>.json`](deployments/v2.1.3-prod/balanced/)
and [`deployments/v2.1.3-prod/aggressive/base.json`](deployments/v2.1.3-prod/aggressive/base.json).
Strategy display / slug naming is the canonical source for downstream services.

Summary:

| Chain | Tier | Strategies |
|---|---|---|
| Ethereum | Balanced | Aave V3 · Compound V3 · Smokehouse USDC (Morpho) · Spark · Fluid |
| Base | Balanced | Aave V3 · Compound V3 · Moonwell Flagship USDC (Morpho) · Fluid |
| Base | Aggressive | Aave V3 · Compound V3 · Moonwell Flagship USDC · Fluid · Gauntlet USDC Prime · Steakhouse USDC · Steakhouse Prime USDC · Pangolins USDC |
| Arbitrum | Balanced | Aave V3 · Compound V3 · Gauntlet USDC Prime (Morpho) · Fluid |
| BNB Chain | Balanced | Aave V3 · Fluid · Kinza · Venus |

`Spark` and `Kinza` reuse `AaveV3Strategy.sol` (interface-compatible fork
pools). All `Morpho`-labelled rows reuse `MorphoStrategy.sol` against the
named MetaMorpho ERC-4626 vault — only the `metaMorpho` constructor address
differs.

### Operational roles

| Role | Address | Notes |
|---|---|---|
| Owner / Treasury | [`0xEC4d3B6a39D61B85dF61cCb35CE693517992A98e`](https://etherscan.io/address/0xEC4d3B6a39D61B85dF61cCb35CE693517992A98e) | Gnosis Safe Multi-sig (2/3 threshold, same address on all 4 chains). Receives streaming-fee shares. |
| Keeper | [`0x84c00eEdBb07C0782dE9758A75114Ee7194FA12c`](https://etherscan.io/address/0x84c00eEdBb07C0782dE9758A75114Ee7194FA12c) | Single EOA. Authorised to call `investToStrategy` / `divestFromStrategy` / `emergencyWithdraw` only. |
| Guardian | [`0xD943214ECF438388ece5035855598010766Aaac1`](https://etherscan.io/address/0xD943214ECF438388ece5035855598010766Aaac1) | Single EOA. Authorised to call `pause()` only. |

---

## Audit Scope

**In-scope** for solo audit (unchanged across all Soken rounds):

```
contracts/Vault.sol
contracts/interfaces/IStrategy.sol
contracts/strategies/BaseStrategy.sol
contracts/strategies/AaveV3Strategy.sol
contracts/strategies/CompoundV3Strategy.sol
contracts/strategies/MorphoStrategy.sol
contracts/strategies/VenusStrategy.sol
contracts/strategies/FluidStrategy.sol
contracts/libraries/Errors.sol
```

`v2.1.2` additions to the in-scope set: `contracts/interfaces/external/IChainlinkAggregator.sol` (2 view functions used by `BaseStrategy._computeMinOutFloor`). `v2.1.3` does not add any file to the in-scope set.

**Audit history**:
- Round 1 — Soken **APY-2026-06-001** (audited commit `v2.0.0`, remediated at `v2.1.0` / `v2.1.1`). See `docs/SOKEN_AUDIT.md` §1–§10 and the [`v2.1.0`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.0) / [`v2.1.1`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.1) release notes.
- Round 2 — Soken **APY-2026-06-002** (audited commit `v2.1.1`, remediated at `v2.1.2`, verdict **PASS 88/100**). See `docs/SOKEN_AUDIT.md` §11 for the 8 recommendations + 1 self-identified fix (accrue-aware view math). Residuals (2 Low + 5 Info, none affecting principal) are addressed at [`v2.1.3`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.3); see `docs/SOKEN_AUDIT.md` §12.
- Round 2 addendum — Soken **APY-2026-06-002-B** (residual-review of v2.1.3 diff, 2026-07-09). **Verdict PASS 91/100, 0 new findings.** Extends APY-2026-06-002 to cover v2.1.3 bytecode — the report matches the deployed prod addresses (see Deployed Contracts above). PDF attached to the [v2.1.3 release](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.1.3).

**Out-of-scope**: `contracts/mocks/`, `test/`, `scripts/`, `deployments/`,
`contracts/interfaces/external/*` **except** `IChainlinkAggregator.sol` (external protocol interfaces re-declared
locally — assumed to match the source protocol).

External dependencies (audited separately):
- OpenZeppelin Contracts 5.x (`ERC4626`, `Ownable`, `Pausable`,
  `ReentrancyGuard`, `SafeERC20`, `Math`)
- Aave V3 Pool · Compound V3 Comet · MetaMorpho ERC-4626 · Venus VToken ·
  Fluid Lending — Vault interacts via the local interfaces under
  `contracts/interfaces/external/`.

---

## Core Design

- **Vault = Immutable** — no upgradeable proxy. Critical bugs require V3
  redeploy + manual user migration (Yearn / Uniswap pattern).
- **Strategy = Modular adapters** — only whitelisted Strategy contracts are
  callable from the Vault.
- **Streaming Share-Price fee model** — performance fee is **accrued
  continuously** as the share price grows. On every `_deposit` / `_withdraw`
  (and on `setFeeRate`), `_accrue()` mints fee shares to the Treasury based
  on the elapsed share-price growth since the last accrue point. No USDC
  ever leaves the Vault as fee.
- **`MAX_FEE = 2000 bps (20%)` hardcoded** — cannot be exceeded.
- **`MAX_ALLOCATION_BPS_ABSOLUTE`** — `immutable` constructor parameter.
  See per-tier table above.
- **3-Role separation**: Owner (Multi-sig) / Keeper (single EOA bot) /
  Guardian (single EOA, pause-only).
- **`pause()` does not block user `withdraw()`** — invariant-tested.

### V1 → V2 diff (summary)

| Area | V1 (`v1.0.0`) | V2 (`v2.0.0`) |
|---|---|---|
| Fee accrual | `harvest()` callable by Keeper | `_accrue()` hooks into deposit/withdraw, action-time |
| Allocation cap | `constant 4000` | `immutable`, per-tier override (2500 / 4000 / 6000) |
| Fee derivation | Strategy P&L (`lastRecordedBalance`) | Share-price growth (`lastSharePrice`) |
| Surface area | Single Vault per chain | Per-tier × per-generation matrix from one source |
| Removed | `harvest()`, `Harvested` event, `lastRecordedBalance` mapping, baseline bumping in `_invest` / `_divest` | — |

---

## Roles & Permissions

| Role | Allowed | Disallowed |
|---|---|---|
| **Owner** (Multi-sig) | `addStrategy` / `removeStrategy` / `setFeeRate` / `setDepositCap` / `setDefaultUserCap` / `setUserCap` / `setKeeper` / `setGuardian` / `setTreasury` / `setStrategyMaxAllocation` | Funds movement — function does not exist |
| **Keeper** (EOA bot) | `investToStrategy` / `divestFromStrategy` / `emergencyWithdraw` | Anything else |
| **Guardian** (EOA) | `pause` | Anything else |

`pause()` is reversible by the Owner. User `withdraw()` works while paused.

---

## Safety Limits

| Constraint | Value | Where |
|---|---|---|
| Max performance fee | 2000 bps (20%) | `MAX_FEE` (constant) |
| Single-strategy absolute cap | per-tier (immutable) | `MAX_ALLOCATION_BPS_ABSOLUTE` |
| Soft Launch per-chain deposit cap | $500K USDC (Conservative: $250K) | Per-deploy, Owner-configurable |
| Default per-user deposit cap | $10K USDC | Owner-configurable per address |

---

## Build & Test

```bash
npm install
cp .env.example .env   # fill in RPC keys for fork tests

npm run compile
npm run test               # full suite (78 passing, 4 fork specs require FORK=true)
npm run test:v2:fork       # mainnet fork integration (Aave / Compound / Morpho / Fluid)
npm run test:coverage      # solidity-coverage report
```

### Coverage (local, `npm run test:coverage`)

| File | Stmts | Branches | Funcs | Lines |
|---|---:|---:|---:|---:|
| `contracts/Vault.sol` | 98.16% | 74.44% | 100% | 95.26% |
| `contracts/interfaces/IStrategy.sol` | 100% | 100% | 100% | 100% |
| `contracts/libraries/Errors.sol` | 100% | 100% | 100% | 100% |
| `contracts/strategies/BaseStrategy.sol` | 94.12% | 50% | 85.71% | 95.65% |

Strategy adapters (`AaveV3Strategy` / `CompoundV3Strategy` / `MorphoStrategy`
/ `VenusStrategy` / `FluidStrategy`) appear at 0% in the local report
because their coverage is provided by the fork-test suite. Run
`FORK=true npm run test:v2:fork` against a mainnet fork (Alchemy / NodeReal
keys in `.env`) to exercise the adapter call paths against the real
protocols.

The Vault branches that read "uncovered" are defensive `require` /
`if (...) revert` paths gated by combinations of state that the
test setup cannot reach simultaneously (e.g. `_accrue()` with
`block.timestamp == lastAccruedAt` AND `totalSupply() == 0` together).
Each of those branches has a dedicated unit test that hits the predicate
individually.

### Mainnet fork dry-run

```bash
FORK=true FORK_CHAIN=ethereum npx hardhat node             # in one terminal
APYEE_GENERATION=v2-prod APYEE_TIER=balanced \
  FORK_CHAIN=ethereum npx hardhat run scripts/deploy/v2/01-deploy-vault.ts --network localhost
# 02 → 03 → 04 same pattern; FORK_CHAIN=base|arbitrum|bsc to switch chains
# APYEE_TIER=aggressive for the Base aggressive tier
```

---

## Project Structure

```
contracts/
├── Vault.sol                       # ERC-4626 VaultV2 (immutable, streaming fee)
├── interfaces/
│   ├── IStrategy.sol
│   └── external/                   # external protocol interfaces (out-of-scope)
├── strategies/
│   ├── BaseStrategy.sol            # shared permissions + reentrancy
│   ├── AaveV3Strategy.sol          # Aave V3 Pool + aToken (Spark / Kinza fork-compatible)
│   ├── CompoundV3Strategy.sol      # Comet single-market
│   ├── MorphoStrategy.sol          # MetaMorpho ERC-4626 wrapper
│   ├── VenusStrategy.sol           # Compound V2 fork (BSC)
│   └── FluidStrategy.sol           # Fluid Lending
├── libraries/Errors.sol            # custom errors
└── mocks/                          # test-only mocks (out-of-scope)
test/
├── v2/                             # V2 unit, invariant, adversarial, migration, completeness
└── fixtures/deployVaultV2.ts
scripts/
├── deploy/
│   ├── 00-config.ts                # per-chain USDC + protocol addresses
│   └── v2/
│       ├── 00-tier-config.ts       # tier matrix + version hashes
│       ├── 01-deploy-vault.ts
│       ├── 02-deploy-strategies.ts
│       ├── 03-register-strategies.ts
│       └── 04-transfer-ownership.ts
├── utils/                          # env / deployment record / source-tag helpers
└── ops/verify.ts                   # post-deploy explorer verification
```

---

## Security Properties (test-enforced)

- Owner cannot withdraw user funds to an arbitrary address (no such function exists — see [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md) for the line-by-line audit).
- `setFeeRate` reverts on values > `MAX_FEE`.
- `pause()` does not block `withdraw()` or `redeem()`.
- Reentrancy guards on every state-changing external-call path.
- `SafeERC20` for all token transfers.
- ERC-4626 inflation-attack mitigation via decimals offset (OpenZeppelin v5).
- `totalAssets()` == sum of strategy balances + idle (invariant).
- Share price is monotonic non-decreasing between accrue points (invariant).
- `_accrue()` mints fee shares to Treasury proportional to share-price growth,
  bounded by `MAX_FEE`.

---

## Links

- **Product**: <https://apyee.com>
- **GitHub**: <https://github.com/coinlive-apyee/apyee-protocol>
- **Release notes**: [CHANGELOG.md](CHANGELOG.md)
- **Security policy**: [SECURITY.md](SECURITY.md)
- **Code of conduct**: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- **Contributing**: [CONTRIBUTING.md](CONTRIBUTING.md)
- **Machine-readable addresses**: [deployments/v2-prod/](deployments/v2-prod/)
- **Design rationale (for audit)**: [docs/V2_DESIGN.md](docs/V2_DESIGN.md)
- **Trust model — what the Owner can and cannot do**: [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md)

---

## License

Business Source License 1.1 (BUSL-1.1). See [LICENSE](LICENSE).

Converts to GPL-2.0-or-later on the Change Date. Until then, production use of
derivative works is restricted per BUSL terms.

---

## Security Contact

`support@apyee.com`

For responsible disclosure of vulnerabilities. Please do not open public issues
for security bugs.
