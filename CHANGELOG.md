# Changelog

All notable changes to Apyee Protocol contracts are documented here.

This project uses [Semantic Versioning](https://semver.org/). Contracts are **immutable**: a new major version means a **new deployment** at a new address (not an upgrade). User migration to a new major version is opt-in.

---

## v2.0.0 — V2 Soft Launch (2026-06)

V2 generation. Single audited Solidity source parameterizable per tier
(Conservative / Balanced / Aggressive). Phase 1 deploys Balanced to all 4
chains plus Aggressive to Base.

### Contracts

- **Vault** (ERC-4626 immutable, streaming fee) — 5 vaults across 4 chains.
- **Strategy adapters** — reused interface contracts from v1.0.0 (same
  `BaseStrategy` / `AaveV3Strategy` / `CompoundV3Strategy` / `MorphoStrategy`
  / `VenusStrategy` / `FluidStrategy` Solidity sources). Strategy
  redeployment is required because each adapter binds to a specific Vault
  in its constructor.

### Vault addresses

| Chain | Tier | Vault |
|---|---|---|
| Ethereum | Balanced | `0xE15e1095925aE629450c29b5E4F1dd5b68f6eD07` |
| Base | Balanced | `0x25e8527be8D7e090C4D0111Fa6b5061868F65de4` |
| Base | Aggressive | `0x3757801E4E605aa0794e3c249bDDD849C98E0ff2` |
| Arbitrum | Balanced | `0xAf9B06C3Ac9991366cE4bBeC6Ba3170EB2aa0Cb3` |
| BNB Chain | Balanced | `0x0e5102ecd1cb960eC62659DFA8Fa9a8349a777fD` |

Full strategy / metadata: [`deployments/v2-prod/`](deployments/v2-prod/).

### Operating parameters

| Parameter | Value | Source |
|---|---|---|
| `depositCap` (Balanced / Aggressive) | 500,000 USDC | Soft Launch ceiling |
| `depositCap` (Conservative) | 250,000 USDC | Soft Launch ceiling |
| `defaultUserCap` | 10,000 USDC | Free-tier per-user limit |
| `feeRate` | 1500 bps (15%) | Streaming model — fee minted to Treasury as shares on `_accrue()` |
| `MAX_FEE` | 2000 bps (20%) | **Hardcoded constant**, cannot be exceeded |
| `MAX_ALLOCATION_BPS_ABSOLUTE` | 2500 / 4000 / 6000 bps (per tier) | **`immutable` constructor parameter** — burned into bytecode |
| `VERSION_HASH` (Balanced prod) | `0xfdb55585a303e75f7a4789857f4098cb223dc75837bbb8578ac57d0410e2d833` | `keccak256("2.0.0-prod-balanced")` |
| `VERSION_HASH` (Aggressive prod) | `0x08cea3a61fa9df526030aa93f19280a5e701e966a04a5b02c34a589d7721a72b` | `keccak256("2.0.0-prod-aggressive")` |

### Notable diffs vs v1.0.0

1. **Streaming performance fee** — `_accrue()` hooks into `_deposit` /
   `_withdraw` / `setFeeRate`. Fee is derived from share-price growth
   (`lastSharePrice`) instead of strategy P&L baselines.
2. **`MAX_ALLOCATION_BPS_ABSOLUTE` parameterized** — was `constant 4000`, now
   `immutable` constructor arg, so one source compiles into N tier configs.
3. **Storage added** — `lastAccruedAt`, `lastSharePrice` (1e18 normalized
   assets-per-share).
4. **Removed** — `harvest()`, `Harvested` event, `lastRecordedBalance`
   mapping, baseline bumping inside `_invest` / `_divest` (irrelevant — fees
   now derive from share price, not strategy P&L).

### Roles (transferred to Multi-sig at deploy)

- **Owner / Treasury**: `0xEC4d3B6a39D61B85dF61cCb35CE693517992A98e` (Gnosis
  Safe Multi-sig, identical across 4 chains).
- **Keeper**: `0x84c00eEdBb07C0782dE9758A75114Ee7194FA12c` (single EOA —
  calls `investToStrategy` / `divestFromStrategy` / `emergencyWithdraw`
  only). Note: `harvest()` is removed in V2 — accrual is automatic.
- **Guardian**: `0xD943214ECF438388ece5035855598010766Aaac1` (single EOA —
  calls `pause()` only).

### Audit status

Pre-audit. Solo audit planned. v2.0.0 supersedes v1.0.0 as the audit scope —
v1.0.0 vaults remain on-chain (immutable) but are not part of V2 audit
deliverables. V1 source remains accessible via the
[`v1.0.0` git tag](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v1.0.0).

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
