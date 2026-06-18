# Trust Model — What the Owner Can and Cannot Do

> **TL;DR**: There is no function in `Vault.sol` that allows the Owner to
> send user funds to an arbitrary address. The Owner can change parameters
> and the whitelist; movement of assets requires the Keeper role and is
> bounded by the whitelist. This document enumerates every privileged
> function with line references so users can verify directly against the
> source.
>
> Source: [`contracts/Vault.sol`](../contracts/Vault.sol) at tag
> [`v2.0.0`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.0.0).
> Identical bytecode is deployed on all 4 chains — see
> [`deployments/v2-prod/`](../deployments/v2-prod/) for addresses.

---

## 1. Three Roles

| Role | Holder | How set |
|---|---|---|
| **Owner** | Gnosis Safe Multi-sig `0xEC4d3B6a39D61B85dF61cCb35CE693517992A98e` (same address on all 4 chains) | Transferred via OpenZeppelin `Ownable.transferOwnership` at deploy step 04. Deployer EOA holds Owner only between deploy and that step. |
| **Keeper** | Single EOA `0x84c00eEdBb07C0782dE9758A75114Ee7194FA12c` | `setKeeper(newKeeper)` — onlyOwner |
| **Guardian** | Single EOA `0xD943214ECF438388ece5035855598010766Aaac1` | `setGuardian(newGuardian)` — onlyOwner |

`onlyOwner` is enforced by OpenZeppelin's `Ownable`. `onlyKeeper` and
`onlyGuardian` are defined in `Vault.sol` lines 257-269:

```solidity
modifier onlyKeeper() {
    if (msg.sender != keeper) revert Errors.NotKeeper();
    _;
}
modifier onlyGuardian() {
    if (msg.sender != guardian) revert Errors.NotGuardian();
    _;
}
```

---

## 2. What the Owner CAN do

Full enumeration of `onlyOwner` functions in `Vault.sol`:

| Function | Line | Effect | Bound |
|---|---:|---|---|
| `setKeeper(address)` | 600 | Replace Keeper EOA | Zero-address check |
| `setGuardian(address)` | 608 | Replace Guardian EOA | Zero-address check |
| `setTreasury(address)` | 618 | Replace Treasury (streaming-fee recipient) | Calls `_accrue()` first → pending fees mint to OLD treasury before swap |
| `setFeeRate(uint16)` | 630 | Update streaming fee rate | Bounded by `MAX_FEE = 2000` (20%), reverts above. Calls `_accrue()` first → historical yield taxed at OLD rate |
| `setDepositCap(uint256)` | 640 | Update Vault total cap | Unbounded (cap can be raised or set to 0) |
| `setDefaultUserCap(uint256)` | 647 | Update default per-user cap | Unbounded |
| `setUserCap(address, uint256)` | 656 | Override one user's cap | Unbounded per-user |
| `addStrategy(address, uint16, uint16)` | 673 | Whitelist a strategy | `maxAllocationBps ≤ MAX_ALLOCATION_BPS_ABSOLUTE` enforced; strategy's `asset()` must equal Vault's asset (USDC) |
| `setStrategyMaxAllocation(address, uint16)` | 702 | Tighten / relax a strategy's cap | Bounded by `MAX_ALLOCATION_BPS_ABSOLUTE` |
| `removeStrategy(address)` | 720 | De-whitelist a strategy | Strategy must report zero balance (forces full divest first) |
| `unblacklistStrategy(address)` | 735 | Lift auto-blacklist | Requires `BLACKLIST_COOLDOWN` (72h) since `blacklistedAt` |
| `unpause()` | 874 | Resume normal operation | — |

**Hard-coded ceilings** (immutable in bytecode, Owner cannot change):

- `MAX_FEE = 2000 bps (20%)` — `setFeeRate` reverts above.
- `MAX_ALLOCATION_BPS_ABSOLUTE = immutable` (2500 / 4000 / 6000 per tier) —
  `addStrategy` / `setStrategyMaxAllocation` revert above.
- `BLACKLIST_COOLDOWN = 72h` — `unblacklistStrategy` blocked until elapsed.

---

## 3. What the Owner CANNOT do — verified by absence of functions

The following functions **do not exist** in `Vault.sol`. There is no
`onlyOwner`-gated path to call any of these:

| Action | Status |
|---|:---:|
| Withdraw user funds to an arbitrary EOA / Multi-sig | ❌ no function |
| Transfer the Vault's USDC balance directly | ❌ no function |
| `mint` shares to Owner / Treasury at will (outside the streaming-fee math) | ❌ no function |
| `burn` user shares | ❌ no function |
| Override individual `lastSharePrice` / `lastAccruedAt` | ❌ no function |
| Disable `_accrue()` or `nonReentrant` | ❌ no function |
| Bypass `MAX_FEE` ceiling | ❌ enforced by `revert` at line 631 |
| Bypass `MAX_ALLOCATION_BPS_ABSOLUTE` | ❌ enforced by `revert` at lines 681-683, 711 |
| Move strategy assets back to an arbitrary address | ❌ `divestFromStrategy` returns to Vault only (line 787) |

You can verify the absence directly:

```bash
# All ERC-20 transfer call sites in Vault.sol
$ grep -n 'asset.safeTransfer\|asset.safeTransferFrom\|IERC20(asset' contracts/Vault.sol
523:        uint256 idle = IERC20(asset()).balanceOf(address(this));   # _withdraw read-only check
582:        uint256 idle = IERC20(asset()).balanceOf(address(this));   # totalAssets read-only
762:        IERC20 vaultAsset = IERC20(asset());                       # investToStrategy (onlyKeeper)
833:        IERC20 vaultAsset = IERC20(asset());                       # _autoPullFromStrategies (called by _withdraw)
```

There is no `transfer` / `transferFrom` / `safeTransfer` / `safeTransferFrom`
on the Vault's underlying asset that is reachable from an `onlyOwner`
path. The only state-changing asset movement is `forceApprove` at line
773, which is inside `investToStrategy` — gated by `onlyKeeper`, bounded
by the per-strategy `maxAllocationBps`, and the recipient is the
whitelisted strategy (not an arbitrary address).

---

## 4. Asset movement paths — all four enumerated

| Path | Caller | Recipient | Bound |
|---|---|---|---|
| `_deposit` → ERC4626 pulls from `caller` to Vault | User (via `deposit` / `mint`) | Vault | Cap checks (`depositCap`, `userCap`) |
| `_withdraw` → ERC4626 sends Vault → `receiver` | User (via `withdraw` / `redeem`) | User-chosen receiver | User must hold the redeemed shares (or be approved). Works **even while paused**. |
| `investToStrategy` → `forceApprove` + `IStrategy.deposit` | **Keeper** (`onlyKeeper`) | Whitelisted strategy only | `maxAllocationBps`, `MAX_ALLOCATION_BPS_ABSOLUTE`, `info.isActive` |
| `divestFromStrategy` / `_autoPullFromStrategies` / `emergencyWithdraw` → strategy pulls back to Vault | Keeper (or `_withdraw` internal) | **Vault only** (strategy adapter hard-codes `vault` as recipient — see `BaseStrategy.sol` lines 120, 137: `underlyingAsset.safeTransfer(vault, withdrawn);`) | Strategy whitelist |

The strategy adapter's `withdraw` and `emergencyWithdraw` functions
unconditionally send recovered assets back to `vault` (the immutable
storage variable set at constructor time). There is no parameter for an
alternative recipient. Source:
[`contracts/strategies/BaseStrategy.sol`](../contracts/strategies/BaseStrategy.sol)
lines 110-138.

---

## 5. Indirect risk surface — honest disclosure

Two indirect paths exist where the Owner could, **in combination with
the Keeper**, move user funds in a way that violates user intent. Both
are documented here so users can monitor for them.

### 5.1 Malicious strategy whitelist

An attacker who controls the Multi-sig (Owner) could:

1. Deploy a malicious strategy contract that satisfies `IStrategy` and
   reports `asset() == USDC`.
2. Call `addStrategy(maliciousStrategy, 0, MAX_ALLOCATION_BPS_ABSOLUTE)`.
3. Wait for the Keeper to call `investToStrategy` (or compromise the
   Keeper EOA to call it directly).
4. The malicious strategy's `deposit(amount)` could route the received
   USDC to attacker-controlled storage.

**Required conditions** (all must hold):
- Multi-sig signers cooperate (`m`-of-`n` threshold).
- Keeper EOA cooperates OR is replaced (`setKeeper` is `onlyOwner`).
- No on-chain monitor catches `StrategyAdded` and triggers user withdraw.

**Why this is residual risk, not negligible**:
- The Multi-sig threshold itself is the primary defence. If the
  threshold is `m`-of-`n` with independent signers, all `m` would need to
  collude.
- `StrategyAdded` is a public event. Monitoring tools (DeFiLlama,
  in-house bots, third-party alerts) surface it within seconds.
- Users have `withdraw()` available **even while paused** — there is no
  governance path to block exits.

### 5.2 Keeper compromise alone

If the Keeper EOA is stolen but the Multi-sig is intact, the attacker
can still call `investToStrategy(existingStrategy, ...)` for any
whitelisted strategy. The recipient is the existing strategy contract
(audited / battle-tested), not the attacker. The attacker can move user
funds around among whitelisted strategies but cannot extract them.

`emergencyWithdraw` also routes back to the Vault, so a Keeper attacker
cannot use it to extract.

### 5.3 What Keeper compromise CAN do

- Force unfavourable rebalances (move assets to a low-yield strategy).
- Drain all strategies back to Vault idle (which then sits as USDC in
  the Vault contract). Users can still `withdraw()` these.

None of these constitute fund theft. The blast radius is "yield loss
during the compromise window" plus "gas cost of unwanted tx", not
"principal loss".

---

## 6. Defences against the residual risks

| Mitigation | Status |
|---|---|
| Multi-sig threshold (Owner = Gnosis Safe, requires `m`-of-`n` signatures) | ✅ Live on all 4 chains |
| Public `StrategyAdded` / `StrategyMaxAllocationUpdated` / `KeeperUpdated` events for on-chain monitoring | ✅ Emitted by `addStrategy`, `setStrategyMaxAllocation`, `setKeeper` |
| `pause()` cannot block user `withdraw()` (invariant-tested) | ✅ `withdraw` / `redeem` have no `whenNotPaused` modifier — see lines 546, 552 |
| `BLACKLIST_COOLDOWN = 72h` prevents instant re-whitelist after emergency | ✅ Enforced in `unblacklistStrategy` |
| `MAX_FEE` and `MAX_ALLOCATION_BPS_ABSOLUTE` are hard-coded ceilings the Owner cannot raise | ✅ |
| Strategy adapters are immutable (no upgradeable proxy), audited interface, no `selfdestruct` | ✅ |
| Deposit / per-user caps limit per-account blast radius | ✅ Soft Launch: $500K/chain, $10K/user default |

---

## 7. What Apyee operators commit to

| Commitment | Public verification |
|---|---|
| Multi-sig `0xEC4d3B6a39D61B85dF61cCb35CE693517992A98e` is the Owner of every V2 Vault on every chain | Call `Vault.owner()` on each chain — must equal the Multi-sig address |
| The Multi-sig signer set and threshold are documented and unchanged outside of emergency rotation (which itself emits an on-chain Safe event) | Inspect the Safe transaction history at app.safe.global |
| Treasury (`0xEC4d3B6a39D61B85dF61cCb35CE693517992A98e`) receives only minted fee shares; user-deposited USDC never moves to the Treasury | `setTreasury` only updates the share recipient, never moves USDC. Verifiable by reading the function source and event log |
| Strategy whitelist additions go through a public notice + grace period before Keeper invests new assets (in-house policy) | `StrategyAdded` event timestamp vs first `InvestedToStrategy` to that strategy |

---

## 8. References

- [`contracts/Vault.sol`](../contracts/Vault.sol) — full source (audit scope)
- [`contracts/strategies/BaseStrategy.sol`](../contracts/strategies/BaseStrategy.sol) — strategy adapter base (audit scope)
- [docs/V2_DESIGN.md](V2_DESIGN.md) — streaming fee math and tier matrix
- [SECURITY.md](../SECURITY.md) — vulnerability disclosure policy
- ERC-4626: <https://eips.ethereum.org/EIPS/eip-4626>
- OpenZeppelin Ownable: <https://docs.openzeppelin.com/contracts/5.x/api/access#Ownable>
