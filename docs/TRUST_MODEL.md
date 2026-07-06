# Trust Model — What the Owner Can and Cannot Do

> **TL;DR**: No NON-OWNER role (Keeper, Guardian, any unprivileged caller) can
> move user principal to an arbitrary address. The Owner (Multi-sig) is a trusted
> role that CAN, by combining `addStrategy(maliciousStrategy)` with `setKeeper(self)`
> + `investToStrategy`, route principal through a self-supplied strategy — an
> accepted centralization risk inherent to the trusted multi-sig.
> This document enumerates every privileged function with line references so
> users can verify directly against the source.
>
> V2.1 (Soken §F-16, 2026-06-25) corrected the previous "no privileged role can
> move principal" phrasing to the precise non-owner guarantee above. The
> centralization risk is intrinsic to ALL DeFi protocols with a multi-sig owner
> (Yearn / Compound / Aave / MakerDAO all share it) and is mitigated by:
> the m-of-n Safe threshold, the public `StrategyAdded` event, and the invariant
> that user `withdraw()` is always open (even while paused).
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
| `setQuarantine(address, bool)` | 893 | V2.1 (Soken F-05) — exclude / restore a strategy from `totalAssets()` accounting | Strategy must be active or blacklisted. Quarantined strategies are also rejected by `investToStrategy`. Off-chain reconciliation required before flipping (share price will shift if the strategy still holds funds). |
| `transferOwnership(address)` | inherited Ownable2Step | Queue new owner — recipient must call `acceptOwnership` to complete the transfer | V2.1 (Soken F-06) — two-step transfer rejects mistyped destinations |

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

---

## 9. V2.1.2 additions — Soken APY-2026-06-002 remediation

> Sections §1–§8 above describe the trust model as of V2.1 (audit round 1, Soken F-16
> response). This section documents the additions introduced in V2.1.2 following Soken
> audit round 2 (APY-2026-06-002). All existing invariants from §1–§8 remain in force;
> the additions below are strictly additive — nothing is removed or relaxed. Source
> for the additions: [`contracts/strategies/BaseStrategy.sol`](../contracts/strategies/BaseStrategy.sol) at tag `v2.1.2`.

### 9.1 New Owner powers (extends §2)

V2.1.2 adds five Owner-gated setters and one rescue helper on `BaseStrategy`. All are
enforced by a dynamic `onlyVaultOwner` modifier that reads `vault.owner()` at call
time (composes with `Ownable2Step` — new Owner acquires the strategy-side privileges
immediately on `acceptOwnership`). All emit indexable events.

| Function | Effect | Bound |
|---|---|---|
| `setRewardPriceFeed(rewardToken, feed)` | Point a reward token at a Chainlink USD price feed. `address(0)` clears the feed. | Zero-address check on `rewardToken`. Feed decimals normalised to 8 (Chainlink convention) at read time. |
| `setRewardFallbackPrice(rewardToken, priceE8)` | Owner-set fallback USD price (× 1e8) used when no Chainlink feed is configured. `0` clears. | Zero-address check on `rewardToken`. See §9.7.2 for the trust implications of this setter. |
| `setRewardMaxSlippage(rewardToken, slippageBps)` | Per-token slippage override for the on-chain minOut floor. `0` restores the default (`DEFAULT_MAX_SLIPPAGE_BPS = 500` = 5%). | Reverts `FeeTooHigh` above `MAX_SLIPPAGE_BPS_CAP = 1000` (10%). Owner cannot loosen slippage past 10% for any token. |
| `setAllowedHopToken(hopToken, allowed)` | Whitelist / de-whitelist an intermediate hop token for the UniV3 multi-hop path. | Zero-address check. Endpoint tokens (`rewardToken`, `underlyingAsset`) are already bound by `_validateSwapPath` and are NOT gated here. De-whitelist takes effect on the next `claimAndCompound`. |
| `sweepIdleAssetToVault()` | Move stray `underlyingAsset` sitting on the strategy contract back to Vault. | See §9.5. |

**Hard-coded ceilings** (extends §2 hard-coded list):

- `MAX_SLIPPAGE_BPS_CAP = 1000 bps (10%)` — `setRewardMaxSlippage` reverts above.
- `PRICE_STALENESS = 1 days` — Chainlink `updatedAt` older than this reverts `PriceFeedStale`.
- `DEFAULT_MAX_SLIPPAGE_BPS = 500 bps (5%)` — applied when Owner has not set a per-token override.

### 9.2 Claim-and-compound MEV defenses (F-04-MEV.1, F-04-MEV.2, N-01, N-SP-01, N-03)

V2.1 introduced `claimAndCompound` (reward → USDC swap + re-deposit). Soken round 2
flagged three residual MEV surfaces on that path. V2.1.2 closes each with a
compile-time or runtime invariant:

**A. Endpoint binding** — `BaseStrategy._validateSwapPath` requires the first 20
bytes of the UniV3 path to equal the claimed `rewardToken` and the last 20 bytes to
equal `underlyingAsset` (USDC). The Keeper cannot re-route the swap to any other
input or output token. Malformed path length (not `20 + N × 23` bytes) reverts
`InvalidPath`.

**B. Intermediate-hop whitelist** — the same `_validateSwapPath` iterates the middle
hops (offsets `23·i` for `1 ≤ i < numHops`) and requires each to satisfy
`allowedHopToken[hop] == true`. Owner-managed via §9.1. Single-hop paths (path
length = 43 bytes) have no middle token and skip the check. Reverts
`HopTokenNotWhitelisted(hopToken)`.

**C. On-chain minOut floor** — `_computeMinOutFloor` derives a fair-price minimum
from Chainlink (if a feed is configured for the reward token) or the Owner-set
fallback price, then reduces by the per-token slippage (or default 5%).
`_swapAndReinvest` reverts `MinOutBelowFloor(minOut, floor)` when the
Keeper-supplied `minOut` is below the floor. Neither Chainlink nor fallback
configured → `MinOutFloorUnconfigured(rewardToken)`. Negative or stale feed answer →
`InvalidPrice` / `PriceFeedStale(updatedAt, blockTs)`. A `minOut = 0` call always
reverts (0 < floor for any positive `amountIn`).

The three layers are independent — bypassing one leaves the others in place. The
resulting worst-case sandwich loss on a Keeper compromise is capped at
`MAX_SLIPPAGE_BPS_CAP = 10%` of the reward stream, and principal is unreachable via
this path (see §5.2).

### 9.3 Pause propagation to strategies (N-02)

Prior to V2.1.2, `Vault.pause()` halted new deposits / invests / harvests on the
Vault but the strategy-side `claimAndCompound` remained callable — a Guardian pause
did not prevent a Keeper (or compromised Keeper) from continuing to move funds
through the DEX. V2.1.2 adds `whenVaultNotPaused` on each of the five concrete
strategies' `claimAndCompound`. The modifier reads `IVaultPausedView(vault).paused()`
and reverts `Errors.VaultPaused()` when true.

User `withdraw` / `redeem` remain pause-free — the invariant from §6 ("`pause()`
cannot block user `withdraw()`") extends unchanged.

### 9.4 Reward-token == underlying skip-swap

Some distributors pay yield directly in the underlying asset (Compound V3's
supply-side USDC accrual; Aave rewards configured to USDC by the Emission Manager).
Prior to V2.1.2, `_swapAndReinvest` reverted `AssetMismatch` on this input, blocking
the compounding path entirely. V2.1.2 replaces the revert with a skip-swap branch:
when `rewardToken == underlyingAsset`, the function skips DEX interaction, path
validation, and floor check, and routes `amountIn` directly to `_deposit`. The
`RewardsCompounded(rewardToken, amountIn, amountIn)` event still emits so telemetry
parity is preserved.

Trust implication: none. This branch cannot be triggered by an attacker — the
`rewardToken` argument comes from the distributor read (not caller-supplied), and
`amountIn` is bounded by the distributor's own accounting.

### 9.5 Owner rescue helper `sweepIdleAssetToVault()`

Handles orphaned residue that can arise from partial `_emergencyWithdraw`,
distributor / router failures, or direct mistaken transfers to a strategy address.

- **Callable by**: Owner only (`onlyVaultOwner`). Reverts `NotOwner` otherwise.
- **Moves**: `underlyingAsset` (USDC) only. Reward tokens, protocol receipt tokens
  (aToken / cToken / vToken / fToken), and any other ERC-20 sitting on the strategy
  remain untouchable. This preserves the "Owner cannot move principal to an
  arbitrary address" invariant (§3) — the strategy's *live* position (protocol
  receipt tokens) is protected exactly as before.
- **Destination**: hard-coded to `vault`. No parameter for an alternative recipient
  exists. Source: `BaseStrategy.sweepIdleAssetToVault` — the function signature has
  zero arguments and the transfer target is a compile-time constant.
- **Idempotency**: zero-balance calls are a no-op (return 0, emit `IdleAssetSwept(0)`,
  do not revert).

### 9.6 Constructor guards

Two constructor-level invariants prevent common misconfiguration and cross-chain
replay of same-bytecode strategies:

- **`dexRouter` must be a contract**. Constructor rejects any `dexRouter_ != 0`
  whose `extcodesize == 0`. Reverts `DexRouterNotContract(dexRouter_)`. The special
  case `address(0)` is the explicit "no compounding on this strategy" signal and is
  still accepted (`_swapAndReinvest` will revert `ZeroAddress` if called on such a
  strategy).
- **Chain pinning**. `DEPLOY_CHAIN_ID` is captured as immutable at construction.
  Every fund-moving external (`deposit`, `withdraw`, `emergencyWithdraw`,
  `sweepIdleAssetToVault`, and each strategy's `claimAndCompound`) is gated by
  `onlyDeployChain`, which reverts `WrongChain(expected, actual)` when
  `block.chainid != DEPLOY_CHAIN_ID`. Blocks replay of the same strategy deployment
  on a forked or wrong chain.
- **Audit event**. `DexRouterConfigured(dexRouter, chainId, dexRouterCodeSize)` is
  emitted once at construction so indexers / audit tooling can verify the router /
  chain pairing without decoding constructor calldata.

### 9.7 Residual risks (F-04-MEV.4 response)

The following risks are bounded but not eliminated by the invariants above. Each
subsection: **risk statement → on-chain limit → off-chain requirement**.

#### 9.7.1 Guardian pause delay

- **Risk**: External protocol exploit in progress; Guardian offline / key lost /
  detection lag → pause delayed → exposure grows linearly with delay.
- **On-chain limit**: `pause()` is atomic; single tx halts all Keeper strategy
  actions immediately when called. §9.3 propagation ensures strategies stop too.
- **Off-chain requirement**: 24/7 Guardian availability; automated event-based
  paging (large withdrawals, TVL drops, protocol admin actions). Planned
  improvement: multi-sig Guardian gateway (2-of-3) at TVL ≥ $10M.

#### 9.7.2 Reward-stream extraction via Owner compromise

- **Risk**: Owner multi-sig fully compromised; attacker calls
  `setRewardFallbackPrice(rewardToken, 1)` to collapse `_computeMinOutFloor` toward
  0; next Keeper claim is sandwiched for the full reward.
- **On-chain limit**: User principal (Vault USDC, protocol receipt tokens) is
  unreachable via this path — only in-flight reward stream is at risk. Tokens with
  a Chainlink feed set (via `setRewardPriceFeed`) bypass fallback and are
  unaffected. `MAX_SLIPPAGE_BPS_CAP = 10%` caps worst-case loss per claim.
- **Off-chain requirement**: Owner must be a Gnosis Safe multi-sig with
  hardware-wallet signers only. Every reward token with Chainlink coverage must
  have its feed configured (fallback is only for long-tail tokens like FLUID /
  KINZA / SPK). `setRewardFallbackPrice` traffic reviewed as a security signal —
  unscheduled changes are anomalies.

#### 9.7.3 Quarantine arbitrage

- **Risk**: Partial `emergencyWithdraw` leaves residual balance in the external
  protocol; `Strategy.balanceOf()` still reports notional value; asymmetric
  information around the eventual recovery announcement lets informed actors
  deposit or withdraw at a distorted share price.
- **On-chain limit**: `BLACKLIST_COOLDOWN = 72h` blocks instant re-whitelist (§2).
  V2.1.2 `sweepIdleAssetToVault()` (§9.5) lets partial recoveries move to Vault
  immediately without a user tx. Vault `totalAssets` is `∑ strategy.balanceOf`; no
  admin override of the accounting equation exists.
- **Off-chain requirement**: Operator judgement on write-down timing
  (`divestFromStrategy` + explicit loss realization); transparent public disclosure
  during the uncertainty window. In acute cases, temporary `depositCap = 0` to
  block new entries.

#### 9.7.4 Keeper key compromise (defense-in-depth summary)

- **Risk**: Keeper EOA key leaks (server compromise, misconfiguration, dependency
  supply-chain attack); attacker submits `claimAndCompound(..., minOut = 0)` or
  otherwise abuses the Keeper surface.
- **On-chain limit**: Keeper power is bounded to whitelisted strategies (§5.2 / §5.3);
  no external-address transfer path exists. §9.2.C floor caps sandwich loss at 10%
  of the reward stream. `setKeeper(newAddr)` rotates power in a single Owner tx
  (dynamic `vault.keeper()` read on each strategy — no redeploy required).
- **Off-chain requirement (three layers)**:
  1. **Infra**: Keeper private key held in AWS Secrets Manager only; bot instance
     acquires it via IAM role + STS temporary credentials (15-minute expiry). Never
     resident on disk or in environment variables.
  2. **Application**: bot computes `minOut` off-chain from an independent oracle
     and reference implementation before submission. This catches the on-chain
     floor via convergent check, not blind trust.
  3. **Contract**: `_computeMinOutFloor` (§9.2.C) is the backstop when layers 1
     and 2 are bypassed. This layer is the V2.1.2 addition.

### 9.8 V2.1.2 Yes/No signal (extends §5 / §6)

| Scenario | Contract enforced? | Off-chain required? |
|---|:---:|:---:|
| Keeper submits `minOut = 0` sandwich | ✅ (`MinOutBelowFloor`) | ✅ (bot-layer validation §9.7.4) |
| Cross-chain replay of strategy deployment | ✅ (`WrongChain`) | — |
| `dexRouter` misconfigured as EOA at deploy | ✅ (`DexRouterNotContract` at construction) | — |
| Guardian pause bypassed via strategy call | ✅ (`VaultPaused` via §9.3) | — |
| Reward-token == USDC compounding | ✅ (skip-swap branch §9.4) | — |
| Owner multi-sig full compromise (reward stream) | ⚠ (Chainlink feed preferred; slippage cap) | ✅ (§9.7.2) |

Legend as §6.

### 9.9 Change log (V2.1.2 additions)

| Date | Change |
|---|---|
| 2026-07-06 | §9 appended — V2.1.2 remediation for Soken APY-2026-06-002. Source at tag `v2.1.2`. |
