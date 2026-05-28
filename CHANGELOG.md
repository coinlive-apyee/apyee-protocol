# Changelog

All notable changes to Apyee Protocol contracts are documented here.

This project uses [Semantic Versioning](https://semver.org/). Contracts are **immutable**: a new major version means a **new deployment** at a new address (not an upgrade). User migration to a new major version is opt-in.

---

## v1.0.0 — Soft Launch (2026-05-28)

First public release. Fresh 4-chain deployment on Ethereum / Base / Arbitrum / BNB Chain.

### Contracts

- **Vault** (ERC-4626 immutable) — 4 chains. Single underlying asset: USDC.
- **Strategy adapters** — 17 total across chains: AaveV3 / CompoundV3 / Morpho / Spark / Venus / Kinza / Fluid. See [README → Deployed Contracts](README.md#deployed-contracts) for addresses.

### Operating parameters

| Parameter | Value | Source |
|---|---|---|
| `depositCap` (per chain) | 500,000 USDC | Soft Launch ceiling — Owner-configurable via `setDepositCap` |
| `defaultUserCap` | 10,000 USDC | Free-tier per-user limit — overridable per-address via `setUserCap` |
| `feeRate` | 1500 bps (15%) | Share-price model — fee minted to Treasury as shares |
| `MAX_FEE` | 2000 bps (20%) | **Hardcoded constant**, cannot be exceeded |
| `MAX_ALLOCATION_BPS_ABSOLUTE` | 4000 bps (40%) | **Hardcoded constant** — single-strategy ceiling |
| `MIN_IDLE_BPS` | 1000 bps (10%) | Keeper guideline (not enforced on-chain) |
| `BLACKLIST_COOLDOWN` | 72 hours | Auto-blacklist re-enable cooldown |
| `VERSION_HASH` | `0x06c015bd22b4c69690933c1058878ebdfef31f9aaae40bbe86d8a09fe1b2972c` | `keccak256("1.0.0")` — assertable on-chain |

### Roles (transferred to Multi-sig at deploy)

- **Owner / Treasury**: `0xEC4d3B6a39D61B85dF61cCb35CE693517992A98e` (Gnosis Safe Multi-sig, identical across 4 chains)
- **Keeper**: `0x84c00eEdBb07C0782dE9758A75114Ee7194FA12c` (single EOA — calls `harvest` / `investToStrategy` / `divestFromStrategy` / `emergencyWithdraw` only)
- **Guardian**: `0xD943214ECF438388ece5035855598010766Aaac1` (single EOA — calls `pause()` only)

### Security properties (test-enforced)

- Owner cannot withdraw user funds to an arbitrary address — function does not exist.
- `setFeeRate` reverts on values > `MAX_FEE`.
- `pause()` does not block `withdraw()` or `redeem()`.
- Reentrancy guards on every state-changing external-call path.
- `SafeERC20` for all token transfers.
- ERC-4626 inflation-attack mitigation via decimals offset (OpenZeppelin v5).
- `totalAssets()` == sum of strategy balances + idle (invariant).

### BNB Chain — Venus sub-wei baseline

A permanent **1 USDC baseline deposit** is held by the Keeper on the BNB Chain Vault to prevent sub-wei dust reverts in `VenusStrategy.withdraw`. Deposit tx: [`0x5d9f7907...`](https://bscscan.com/tx/0x5d9f7907ce10ea98ff4ad7af6bb5890e4528282f49ee527d497a43fe0a6a2ffe).

### Audit status

Pre-audit. Solo audit planned post-soft-launch (2026 Q3 target). Contest audit (Code4rena / Cantina / Sherlock) after solo. Soft Launch deposit caps are intentionally conservative until audit completion.

---

> **Upcoming**: cap-raise schedule (Soft Launch → Solo Audit → Public) and Pro-tier per-user cap activation will be announced via on-chain events (`DepositCapUpdated` / `DefaultUserCapUpdated` / `UserCapUpdated`) and reflected in this changelog.
