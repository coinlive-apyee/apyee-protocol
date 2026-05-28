# Apyee Protocol

> Non-custodial, AI-powered stablecoin yield aggregator — ERC-4626 Vault.

Apyee allocates user-deposited USDC across whitelisted DeFi lending strategies
on Ethereum, Base, Arbitrum, and BNB Chain. The Vault is **immutable** (no
upgradeable proxy), and the operator **cannot move user funds** — those code
paths do not exist.

---

## Status — Soft Launch (v1.0.0, 2026-05-28)

- Per-chain deposit cap: **$500K USDC**
- Per-user deposit cap: $10K USDC default (Owner-configurable per address)
- Performance fee: 1500 bps (15%, share-price model — see Core Design)
- Emergency pause: available (Guardian)
- Withdrawals always enabled, even while paused
- Release tag: [`v1.0.0`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v1.0.0)
- `Vault.VERSION_HASH()`: `0x06c015bd22b4c69690933c1058878ebdfef31f9aaae40bbe86d8a09fe1b2972c`
  (= `keccak256("1.0.0")` — assert on-chain to verify generation)

---

## Deployed Contracts

Machine-readable: [`deployments/v1-prod.json`](deployments/v1-prod.json)

### Vaults

| Chain | Vault | Explorer |
|---|---|---|
| Ethereum | `0xdDd394e75e95b877E1DB759b6b355da4F7f0Dc0c` | [etherscan](https://etherscan.io/address/0xdDd394e75e95b877E1DB759b6b355da4F7f0Dc0c#code) |
| Base | `0xD31528927Dd47445E3EAF902a8b5A05bbC326BD6` | [basescan](https://basescan.org/address/0xD31528927Dd47445E3EAF902a8b5A05bbC326BD6#code) |
| Arbitrum | `0x3D81A544691b810b82485802C49Fe1350Ba1Ecda` | [arbiscan](https://arbiscan.io/address/0x3D81A544691b810b82485802C49Fe1350Ba1Ecda#code) |
| BNB Chain | `0xB0b040567e4A36E9e5D11985f0943E9225897C91` | [bscscan](https://bscscan.com/address/0xB0b040567e4A36E9e5D11985f0943E9225897C91#code) |

All Vaults are **verified** with Exact Match on the respective explorer. Source identical to this repo at tag `v1.0.0`.

### Strategy adapters

**Ethereum** — 5 strategies
- AaveV3Strategy (Aave V3): [`0xf90f06632ac5d6197892f258Db7776D577951AD8`](https://etherscan.io/address/0xf90f06632ac5d6197892f258Db7776D577951AD8#code)
- CompoundV3Strategy (Compound V3): [`0x74d3bf1535bd9FF47adC97FdF653772a13C11643`](https://etherscan.io/address/0x74d3bf1535bd9FF47adC97FdF653772a13C11643#code)
- MorphoStrategy (Steakhouse USDC MetaMorpho): [`0xa8204C618F6B88DE94b95A927b13DA8Daf61D9F7`](https://etherscan.io/address/0xa8204C618F6B88DE94b95A927b13DA8Daf61D9F7#code)
- AaveV3Strategy (Spark pool): [`0x543A292deE59bfcb3Ecc0e5185814b2d80C94098`](https://etherscan.io/address/0x543A292deE59bfcb3Ecc0e5185814b2d80C94098#code)
- FluidStrategy (Instadapp Fluid): [`0xF0B93e2452B82F27922df3C8A93397135F4C91dC`](https://etherscan.io/address/0xF0B93e2452B82F27922df3C8A93397135F4C91dC#code)

**Base** — 4 strategies
- AaveV3Strategy: [`0x870E0615A9274Ce7a3B5F6e805cF11f9529846b4`](https://basescan.org/address/0x870E0615A9274Ce7a3B5F6e805cF11f9529846b4#code)
- CompoundV3Strategy: [`0xE20954F2716cD7652f07a7b6FAeb30C48b909574`](https://basescan.org/address/0xE20954F2716cD7652f07a7b6FAeb30C48b909574#code)
- MorphoStrategy (Moonwell Flagship USDC): [`0xC1E3Fef3677b11a438509a09044593Db68Bb634D`](https://basescan.org/address/0xC1E3Fef3677b11a438509a09044593Db68Bb634D#code)
- FluidStrategy: [`0x715A9d8F5f06624503be21c55bc04F344a2021Df`](https://basescan.org/address/0x715A9d8F5f06624503be21c55bc04F344a2021Df#code)

**Arbitrum** — 4 strategies
- AaveV3Strategy: [`0x606924314b8B4BE79d80719E7398ed8fA3Aa3e3f`](https://arbiscan.io/address/0x606924314b8B4BE79d80719E7398ed8fA3Aa3e3f#code)
- CompoundV3Strategy: [`0xB0b040567e4A36E9e5D11985f0943E9225897C91`](https://arbiscan.io/address/0xB0b040567e4A36E9e5D11985f0943E9225897C91#code)
- MorphoStrategy: [`0x141bf6c70649089590A4FA0b0172f1f7Aa0AC206`](https://arbiscan.io/address/0x141bf6c70649089590A4FA0b0172f1f7Aa0AC206#code)
- FluidStrategy: [`0x06c3E33fB76B72A8f83d2A0507b2d0478a4bEf37`](https://arbiscan.io/address/0x06c3E33fB76B72A8f83d2A0507b2d0478a4bEf37#code)

**BNB Chain** — 4 strategies
- VenusStrategy (Compound V2 fork on BSC): [`0x141bf6c70649089590A4FA0b0172f1f7Aa0AC206`](https://bscscan.com/address/0x141bf6c70649089590A4FA0b0172f1f7Aa0AC206#code)
- AaveV3Strategy: [`0x06c3E33fB76B72A8f83d2A0507b2d0478a4bEf37`](https://bscscan.com/address/0x06c3E33fB76B72A8f83d2A0507b2d0478a4bEf37#code)
- AaveV3Strategy (Kinza pool): [`0xdFA3baB832d9f9D0FA8aE75b324F9007c79766F2`](https://bscscan.com/address/0xdFA3baB832d9f9D0FA8aE75b324F9007c79766F2#code)
- FluidStrategy: [`0x91C4e348AaFb935c856666eeB2c13218897e664E`](https://bscscan.com/address/0x91C4e348AaFb935c856666eeB2c13218897e664E#code)

### Operational roles

| Role | Address | Notes |
|---|---|---|
| Owner / Treasury | [`0xEC4d3B6a39D61B85dF61cCb35CE693517992A98e`](https://etherscan.io/address/0xEC4d3B6a39D61B85dF61cCb35CE693517992A98e) | Gnosis Safe Multi-sig (same address on all 4 chains). Receives fee shares. |
| Keeper | [`0x84c00eEdBb07C0782dE9758A75114Ee7194FA12c`](https://etherscan.io/address/0x84c00eEdBb07C0782dE9758A75114Ee7194FA12c) | Single EOA. Authorised to call `harvest` / `investToStrategy` / `divestFromStrategy` / `emergencyWithdraw` only. |
| Guardian | [`0xD943214ECF438388ece5035855598010766Aaac1`](https://etherscan.io/address/0xD943214ECF438388ece5035855598010766Aaac1) | Single EOA. Authorised to call `pause()` only. |

> **Verification tip**: call `Vault.VERSION_HASH()` on any of the 4 chains — must equal `0x06c015bd22b4c69690933c1058878ebdfef31f9aaae40bbe86d8a09fe1b2972c`. A different hash indicates a non-production deployment (e.g. internal `v1-dev` testbench).

---

## Audit Status

This protocol has **not yet undergone external audit**. A formal solo audit is
planned post-soft-launch.

Until audit completion, the protocol operates with conservative deposit caps
(see above) and a 3-role permission model designed to limit operator authority.

**Use at your own risk.** Report security issues to `support@apyee.com`.

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

### Strategy adapters (Soft Launch v1.0.0 — 17 total)

| Chain | Aave V3 | Compound V3 | Morpho | Spark | Venus | Kinza | Fluid |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Ethereum | ✓ | ✓ | ✓ (Steakhouse) | ✓ | — | — | ✓ |
| Base | ✓ | ✓ | ✓ (Moonwell) | — | — | — | ✓ |
| Arbitrum | ✓ | ✓ | ✓ | — | — | — | ✓ |
| BNB Chain | ✓ | — | — | — | ✓ | ✓ | ✓ |

Per-strategy allocation cap: `MAX_ALLOCATION_BPS_ABSOLUTE = 4000 bps (40%)`. Spark / Kinza reuse `AaveV3Strategy.sol` (interface-compatible fork pools).

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

`support@apyee.com`

For responsible disclosure of vulnerabilities. Please do not open public issues
for security bugs.
