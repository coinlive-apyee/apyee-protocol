# Apyee Protocol

> Non-custodial, AI-powered stablecoin yield aggregator — ERC-4626 Vault.

Apyee allocates user-deposited USDC across whitelisted DeFi lending strategies
on Ethereum, Base, Arbitrum, and BNB Chain. The Vault is **immutable** (no
upgradeable proxy), and the operator **cannot move user funds** — those code
paths do not exist.

---

## Status — Soft Launch (Phase 1)

- Per-chain deposit cap: **$500K USDC**
- Per-user deposit cap: configurable by Owner
- Emergency pause: available (Guardian)
- Withdrawals always enabled, even while paused

---

## Deployed Contracts

| Chain | Vault | Explorer |
|---|---|---|
| Ethereum | TBD | — |
| Base | TBD | — |
| Arbitrum | TBD | — |
| BNB Chain | TBD | — |

Addresses will be published here on mainnet launch.

---

## Audit Status

This protocol has **not yet undergone external audit**. A formal solo audit is
planned post-soft-launch.

Until audit completion, the protocol operates with conservative deposit caps
(see above) and a 3-role permission model designed to limit operator authority.

**Use at your own risk.** Report security issues to `security@apyee.xyz`.

---

## Core Design

- **Vault = Immutable** — no upgradeable proxy. Critical bugs require V2
  redeploy + manual user migration (Yearn / Uniswap pattern).
- **Strategy = Modular adapters** — only whitelisted Strategy contracts are
  callable from the Vault.
- **Share Price fee model** — performance fee is minted to the Treasury as
  shares; no USDC is moved out of the Vault.
- **`MAX_FEE = 2000 bps (20%)` hardcoded** — cannot be exceeded.
- **`MAX_ALLOCATION_BPS_ABSOLUTE = 4000 bps (40%)`** — absolute upper bound on
  any single strategy's allocation.
- **3-Role separation**: Owner (Multi-sig) / Keeper (single EOA bot) /
  Guardian (single EOA, pause-only).
- **`pause()` does not block user `withdraw()`** — invariant-tested.

### Strategy adapters (Phase 1)

| Chain | Aave V3 | Compound V3 | Morpho | Venus | Fluid |
|---|:---:|:---:|:---:|:---:|:---:|
| Ethereum | ✓ | ✓ | ✓ | — | ✓ |
| Base | ✓ | ✓ | — | — | — |
| Arbitrum | ✓ | ✓ | — | — | — |
| BNB Chain | — | — | — | ✓ | — |

---

## Roles & Permissions

| Role | Allowed | Disallowed |
|---|---|---|
| **Owner** (Multi-sig) | `addStrategy` / `removeStrategy` / `setFeeRate` / `setDepositCap` / `setDefaultUserCap` / `setUserCap` / `setKeeper` / `setGuardian` / `setTreasury` / `setStrategyMaxAllocation` | Funds movement — function does not exist |
| **Keeper** (EOA bot) | `harvest` / `investToStrategy` / `divestFromStrategy` / `emergencyWithdraw` | Anything else |
| **Guardian** (EOA) | `pause` | Anything else |

`pause()` is reversible by the Owner. User `withdraw()` works while paused.

---

## Safety Limits

| Constraint | Value | Where |
|---|---|---|
| Max performance fee | 2000 bps (20%) | `MAX_FEE` (constant) |
| Single-strategy absolute cap | 4000 bps (40%) | `MAX_ALLOCATION_BPS_ABSOLUTE` |
| Recommended idle ratio | ≥10% | `MIN_IDLE_BPS` (guideline) |
| Auto-blacklist cooldown | 72h | `BLACKLIST_COOLDOWN` |
| Soft Launch per-chain deposit cap | $500K USDC | Per-deploy, Owner-configurable |

---

## Build & Test

```bash
npm install
cp .env.example .env   # fill in RPC keys for fork tests

npm run compile
npm run test:unit          # unit tests (Vault: 100% statements / lines / funcs)
npm run test:invariant     # 12 invariant scenarios
npm run test:fork          # mainnet fork integration (Aave / Compound / Morpho)
npm run test:fork:bsc      # BSC fork (Venus)
npm run test:coverage
```

### Mainnet fork dry-run

```bash
FORK=true FORK_CHAIN=ethereum npx hardhat node                 # in one terminal
FORK_CHAIN=ethereum npx hardhat run scripts/deploy/01-deploy-vault.ts --network localhost
# 02 → 03 → 04 same pattern; FORK_CHAIN=base|arbitrum|bsc to switch chains
```

---

## Project Structure

```
contracts/
├── Vault.sol                       # ERC-4626 Vault (immutable)
├── interfaces/IStrategy.sol
├── strategies/
│   ├── BaseStrategy.sol            # shared permissions + reentrancy
│   ├── AaveV3Strategy.sol          # Aave V3 Pool + aToken
│   ├── CompoundV3Strategy.sol      # Comet single-market
│   ├── MorphoStrategy.sol          # MetaMorpho ERC-4626 wrapper
│   ├── VenusStrategy.sol           # Compound V2 fork (BSC)
│   └── FluidStrategy.sol           # Fluid Lending
├── libraries/Errors.sol            # custom errors
└── mocks/                          # test-only mocks
test/
├── unit/                           # unit tests
├── invariant/                      # 12 invariant scenarios
├── integration/                    # mainnet fork tests
└── fixtures/
scripts/
└── deploy/
    ├── 00-config.ts                # per-chain USDC + protocol addresses
    ├── 01-deploy-vault.ts
    ├── 02-deploy-strategies.ts
    ├── 03-register-strategies.ts
    └── 04-transfer-ownership.ts
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

---

## License

Business Source License 1.1 (BUSL-1.1). See [LICENSE](LICENSE).

Converts to GPL-2.0-or-later on the Change Date. Until then, production use of
derivative works is restricted per BUSL terms.

---

## Security Contact

`security@apyee.xyz`

For responsible disclosure of vulnerabilities. Please do not open public issues
for security bugs.
