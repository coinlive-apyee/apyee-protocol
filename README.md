# Apyee Protocol

> Non-custodial, AI-powered stablecoin yield aggregator — ERC-4626 Vault.

**Website**: [apyee.com](https://apyee.com) &nbsp;·&nbsp; **Release**: `v2.0.0` &nbsp;·&nbsp; **License**: BUSL-1.1 &nbsp;·&nbsp; **Security**: [`support@apyee.com`](mailto:support@apyee.com)

Apyee allocates user-deposited USDC across whitelisted DeFi lending strategies
on Ethereum, Base, Arbitrum, and BNB Chain. The Vault is **immutable** (no
upgradeable proxy), and the operator **cannot move user funds** — those code
paths do not exist.

---

## Status — V2 Soft Launch (v2.0.0, 2026-06)

V2 introduces a **streaming performance fee** and a **tier-based allocation
cap** so a single audited Solidity source can produce multiple deployment
configs (Conservative / Balanced / Aggressive). Phase 1 launches Balanced on
all 4 chains plus Aggressive on Base.

- Per-chain deposit cap: **$500K USDC** (Conservative tier: $250K)
- Per-user deposit cap: $10K USDC default (Owner-configurable per address)
- Performance fee: **1500 bps (15%)**, streaming model — accrued continuously
  on share price growth, hooked into `_deposit` / `_withdraw` / `setFeeRate`
- Emergency pause: available (Guardian)
- Withdrawals always enabled, even while paused

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

## Deployed Contracts (V2)

Machine-readable: [`deployments/v2-prod/`](deployments/v2-prod/)

### Vaults

| Chain | Tier | Vault | Explorer |
|---|---|---|---|
| Ethereum | Balanced | `0xE15e1095925aE629450c29b5E4F1dd5b68f6eD07` | [etherscan](https://etherscan.io/address/0xE15e1095925aE629450c29b5E4F1dd5b68f6eD07#code) |
| Base | Balanced | `0x25e8527be8D7e090C4D0111Fa6b5061868F65de4` | [basescan](https://basescan.org/address/0x25e8527be8D7e090C4D0111Fa6b5061868F65de4#code) |
| Base | Aggressive | `0x3757801E4E605aa0794e3c249bDDD849C98E0ff2` | [basescan](https://basescan.org/address/0x3757801E4E605aa0794e3c249bDDD849C98E0ff2#code) |
| Arbitrum | Balanced | `0xAf9B06C3Ac9991366cE4bBeC6Ba3170EB2aa0Cb3` | [arbiscan](https://arbiscan.io/address/0xAf9B06C3Ac9991366cE4bBeC6Ba3170EB2aa0Cb3#code) |
| BNB Chain | Balanced | `0x0e5102ecd1cb960eC62659DFA8Fa9a8349a777fD` | [bscscan](https://bscscan.com/address/0x0e5102ecd1cb960eC62659DFA8Fa9a8349a777fD#code) |

All Vaults are **verified** on the respective explorer. Source identical to
this repo at tag `v2.0.0`.

### Strategy adapters

Full per-chain breakdown lives in
[`deployments/v2-prod/balanced/<chain>.json`](deployments/v2-prod/balanced/)
and [`deployments/v2-prod/aggressive/base.json`](deployments/v2-prod/aggressive/base.json).
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
| Owner / Treasury | [`0xEC4d3B6a39D61B85dF61cCb35CE693517992A98e`](https://etherscan.io/address/0xEC4d3B6a39D61B85dF61cCb35CE693517992A98e) | Gnosis Safe Multi-sig (same address on all 4 chains). Receives streaming-fee shares. |
| Keeper | [`0x84c00eEdBb07C0782dE9758A75114Ee7194FA12c`](https://etherscan.io/address/0x84c00eEdBb07C0782dE9758A75114Ee7194FA12c) | Single EOA. Authorised to call `investToStrategy` / `divestFromStrategy` / `emergencyWithdraw` only. |
| Guardian | [`0xD943214ECF438388ece5035855598010766Aaac1`](https://etherscan.io/address/0xD943214ECF438388ece5035855598010766Aaac1) | Single EOA. Authorised to call `pause()` only. |

---

## Audit Scope

**In-scope** for solo audit:

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

**Out-of-scope**: `contracts/mocks/`, `test/`, `scripts/`, `deployments/`,
`contracts/interfaces/external/*` (external protocol interfaces re-declared
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
npm run test:v2            # unit / invariant / adversarial / migration / completeness
npm run test:v2:fork       # mainnet fork integration (Aave / Compound / Morpho / Fluid)
npm run test:coverage
```

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

- Owner cannot withdraw user funds to an arbitrary address (no such function exists).
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
