// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IStrategy} from "./interfaces/IStrategy.sol";
import {Errors} from "./libraries/Errors.sol";

/// @title VaultV2 — Streaming performance fee + parameterized allocation cap
/// @notice ERC-4626 vault for tier-based deployments (Conservative / Balanced / Aggressive).
///         Performance fee is **accrued continuously** based on share price growth
///         (V1 was harvest-triggered). `MAX_ALLOCATION_BPS_ABSOLUTE` is now an immutable
///         constructor parameter so a single Solidity source can produce N tier-deployment
///         configs (Generation × Tier matrix — Solo Audit 1× covers all).
/// @dev Immutable — no upgradeable proxy. V3 would require redeploy + migration.
///
/// Key diffs vs V1:
///   1. `MAX_ALLOCATION_BPS_ABSOLUTE`: `constant 4000` → `immutable` (per-tier override)
///   2. Add storage: `lastAccruedAt`, `lastSharePrice` (1e18 normalized assets-per-share)
///   3. Add `_accrue()` — profit-based streaming fee. 3 audit-critical precision fixes baked in.
///   4. Hook `_accrue()` into `_deposit` / `_withdraw` / `setFeeRate`
///   5. Remove: `harvest()`, `Harvested` event, `lastRecordedBalance` mapping, baseline bumping
///      in `_invest` / `_divest` (irrelevant — fees now derive from share price, not strategy P&L)
///   6. Add: `FeesAccrued` event, `pendingFeeShares()` view (off-chain UX)
contract VaultV2 is ERC4626, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────

    /// @notice Maximum performance fee in bps (20%). Cannot be exceeded.
    uint16 public constant MAX_FEE = 2000;

    /// @notice Hard ceiling on `MAX_ALLOCATION_BPS_ABSOLUTE` constructor arg (= 100% TVL).
    uint16 public constant MAX_ALLOCATION_CEILING = 10000;

    /// @notice Recommended minimum idle ratio (Keeper guideline, NOT on-chain enforced).
    uint16 public constant MIN_IDLE_BPS = 1000;

    /// @notice Cooldown after auto-blacklist before re-enabling is allowed.
    uint256 public constant BLACKLIST_COOLDOWN = 72 hours;

    /// @notice Share price normalization factor (1e18). Tracked baseline uses this scale.
    uint256 public constant ACCRUE_PRECISION = 1e18;

    /// @dev ERC-4626 inflation attack mitigation. USDC has 6 decimals → shares = 12 decimals.
    uint8 private constant DECIMALS_OFFSET = 6;

    /// @notice Build-time source tag for Etherscan Similar Match 차단.
    /// @dev Etherscan 의 Similar Match 알고리즘은 bytecode metadata trailer (= source IPFS hash)
    ///      만 비교 — `immutable` constructor args 는 비교 대상 X. 따라서 `VERSION_HASH` 분기만
    ///      으론 Similar Match 차단 불가. 이 `SOURCE_TAG` string literal 이 metadata 에 포함
    ///      되어 generation × tier 마다 다른 metadata hash 를 생성 → Similar Match 차단.
    ///
    ///      Deploy script (`scripts/deploy/v2/01-deploy-vault.ts`) 가 `__SOURCE_TAG__` placeholder
    ///      를 generation × tier 별로 sed 치환 후 compile + deploy + 원본 복원.
    ///      6 분기 매트릭스 = V2_VAULT.md §4.4:
    ///         "v2-dev-balanced" / "v2-dev-aggressive" / "v2-dev-conservative" /
    ///         "v2-prod-balanced" / "v2-prod-aggressive" / "v2-prod-conservative"
    ///      audit 입장 = 6 분기 모두 literal 외 동일, audit 1× 로 cover.
    string public constant SOURCE_TAG = "__SOURCE_TAG__";

    // ─────────────────────────────────────────────────────────────
    // Immutable per-tier config
    // ─────────────────────────────────────────────────────────────

    /// @notice Per-strategy allocation absolute cap (in bps). Set at deploy time per tier:
    ///   Conservative tier: 2500 (25%) — single strategy ≤ 1/4 TVL
    ///   Balanced     tier: 4000 (40%) — current V1 setting
    ///   Aggressive   tier: 6000 (60%) — single strategy ≤ 3/5 TVL
    /// @dev Constructor checks `value ≤ MAX_ALLOCATION_CEILING (10000)`. Embedded in runtime bytecode.
    uint16 public immutable MAX_ALLOCATION_BPS_ABSOLUTE;

    /// @notice keccak256 of the version string. Distinguishes generation × tier (6 hash matrix).
    /// @dev Expected values (Generation × Tier, set at deploy time):
    ///   v2-dev-conservative   = keccak256("2.0.0-dev-conservative")
    ///   v2-dev-balanced       = keccak256("2.0.0-dev-balanced")
    ///   v2-dev-aggressive     = keccak256("2.0.0-dev-aggressive")
    ///   v2-prod-conservative  = keccak256("2.0.0-prod-conservative")
    ///   v2-prod-balanced      = keccak256("2.0.0-prod-balanced")
    ///   v2-prod-aggressive    = keccak256("2.0.0-prod-aggressive")
    ///
    /// Effect:
    ///   - Backend Keeper bot fail-fast: rejects calls if VERSION_HASH mismatches expected
    ///     generation × tier for the current environment (dev/prod 혼선 차단)
    ///   - Debugging: contract identification via storage slot read
    ///   - Etherscan Similar Match is **unaffected** (metadata-trailer based algorithm) —
    ///     accepted as V1 / Uniswap V3 pattern. See docs/page2/V2_VAULT.md §4.4.
    bytes32 public immutable VERSION_HASH;

    // ─────────────────────────────────────────────────────────────
    // Roles & Config
    // ─────────────────────────────────────────────────────────────

    /// @notice Single EOA authorized to call `harvest`-style invest/divest functions.
    ///         Owner-mutable via `setKeeper`. Keeper cannot move funds outside whitelisted strategies.
    /// @custom:security single point of failure if compromised — limited blast radius (cannot drain Vault).
    address public keeper;

    /// @notice Single EOA authorized to call `pause()` only. Owner-mutable via `setGuardian`.
    ///         All other Guardian permissions are intentionally absent (CLAUDE.md §2.4).
    /// @custom:security pausing does NOT block user withdrawals — withdraw/redeem stay open by invariant.
    address public guardian;

    /// @notice Address that receives streaming-fee shares (continuous performance fee accrual).
    ///         Owner-mutable via `setTreasury` (calls `_accrue()` first → settles old treasury).
    ///         Typically the Treasury Multi-sig Safe.
    address public treasury;

    /// @notice Performance fee rate in bps. Bounded by `MAX_FEE` (= 2000 / 20%).
    ///         Owner-mutable via `setFeeRate` (calls `_accrue()` first → no retroactive taxation).
    uint16  public feeRate;

    /// @notice Hard upper bound on Vault total assets (depositCap). Reverts deposits past this.
    ///         Owner-mutable via `setDepositCap`. Setting to 0 effectively pauses new deposits
    ///         (the V1 → V2 migration pattern; see V2_VAULT.md §5.1).
    uint256 public depositCap;

    /// @notice Per-user position cap (applies when `userCap[user] == 0`). Owner-mutable.
    ///         Soft Launch default $10K, hardcoded in deploy config (see SPEC 1.21.4).
    uint256 public defaultUserCap;

    /// @notice Per-user override cap. Non-zero values take precedence over `defaultUserCap`.
    ///         Owner-mutable via `setUserCap(user, cap)`. Used for parking wallets / Pro accounts.
    mapping(address => uint256) public userCap;

    // ─────────────────────────────────────────────────────────────
    // Streaming fee state  (NEW in V2)
    // ─────────────────────────────────────────────────────────────

    /// @notice Last block.timestamp at which `_accrue()` ran.
    uint256 public lastAccruedAt;

    /// @notice Last share price (assets-per-share × 1e18) at the moment of last accrual.
    ///         Used as the baseline against which the next accrual computes profit growth.
    ///         Initialized to ACCRUE_PRECISION (= 1.0 normalized) in constructor.
    uint256 public lastSharePrice;

    // ─────────────────────────────────────────────────────────────
    // Strategy whitelist & per-strategy info  (UNCHANGED vs V1 except removed lastRecordedBalance)
    // ─────────────────────────────────────────────────────────────

    /// @notice Per-strategy whitelist record.
    /// @dev Slot layout: 2 × uint16 + 2 × bool fits in a single storage slot;
    ///      `blacklistedAt` consumes the next slot. Keep field order stable for diff
    ///      readability across V2 generations (dev / prod) — slot packing must not regress.
    /// @param targetBps         Initial allocation target the Keeper aims for (bps of TVL).
    /// @param maxAllocationBps  Per-strategy hard cap (bps). Must satisfy `≤ MAX_ALLOCATION_BPS_ABSOLUTE`.
    /// @param isActive          True if Keeper may invest/divest into this strategy.
    /// @param isBlacklisted     True after `emergencyWithdraw` — blocks `invest`, allows `divest` only.
    /// @param blacklistedAt     Timestamp of the blacklist trigger (used for `BLACKLIST_COOLDOWN`).
    /// @dev V2.1 (Soken F-05): `isQuarantined` is an Owner-controlled escape hatch that
    ///      excludes a strategy from `totalAssets()` accounting without calling its
    ///      `balanceOf()`. Used when an external protocol view path becomes unreachable
    ///      (paused / exploited / migrated) and a naive try-catch return-0 would silently
    ///      understate NAV. Quarantine **must** be paired with prior off-chain
    ///      reconciliation of the strategy's real value — share price will jump on
    ///      `setQuarantine(true)` if the strategy still holds funds.
    struct StrategyInfo {
        uint16 targetBps;
        uint16 maxAllocationBps;
        bool isActive;
        bool isBlacklisted;
        bool isQuarantined;          // V2.1 — F-05 escape hatch (Owner-set)
        uint256 blacklistedAt;
    }

    /// @notice Per-strategy whitelist record. Read with `strategyInfo(addr)`.
    mapping(address => StrategyInfo) public strategyInfo;

    /// @notice Iterable list of every strategy ever registered (active + blacklisted).
    ///         Removed strategies are NOT removed from the array — `isActive == false` only.
    ///         Used by `totalAssets()` to sum balances across all known strategies
    ///         (active OR blacklisted) and by `_autoPullFromStrategies` to drain idle on withdraw.
    address[] public strategyList;

    // ─────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────

    /// @notice Keeper EOA changed by Owner (`setKeeper`).
    event KeeperUpdated(address indexed newKeeper);

    /// @notice Guardian EOA changed by Owner (`setGuardian`).
    event GuardianUpdated(address indexed newGuardian);

    /// @notice Treasury address changed by Owner. `_accrue()` ran before the change so any
    ///         pending fee shares are already minted to the OLD treasury.
    event TreasuryUpdated(address indexed newTreasury);

    /// @notice Performance fee rate changed by Owner. `_accrue()` ran before the change so
    ///         existing yield is locked in at the OLD rate (no retroactive taxation).
    event FeeRateUpdated(uint16 newRate);

    /// @notice Vault total cap changed by Owner. Setting `newCap == 0` halts new deposits
    ///         (used during V1 → V2 migration; see V2_VAULT.md §5.1).
    event DepositCapUpdated(uint256 newCap);

    /// @notice Per-user default cap changed by Owner. Applies when `userCap[user] == 0`.
    event DefaultUserCapUpdated(uint256 newCap);

    /// @notice Per-user override cap set by Owner. `0` reverts to `defaultUserCap`.
    event UserCapUpdated(address indexed user, uint256 newCap);

    /// @notice Strategy whitelisted with initial target / cap by Owner.
    event StrategyAdded(address indexed strategy, uint16 targetBps, uint16 maxAllocationBps);

    /// @notice Strategy fully removed by Owner (only allowed when `balanceOf == 0`).
    event StrategyRemoved(address indexed strategy);

    /// @notice Strategy auto-blacklisted by `emergencyWithdraw` (Keeper).
    event StrategyBlacklisted(address indexed strategy);

    /// @notice Strategy un-blacklisted by Owner after `BLACKLIST_COOLDOWN` elapsed.
    event StrategyUnblacklisted(address indexed strategy);

    /// @notice Per-strategy `maxAllocationBps` updated by Owner. Bounded by `MAX_ALLOCATION_BPS_ABSOLUTE`.
    event StrategyMaxAllocationUpdated(address indexed strategy, uint16 newMaxBps);

    /// @notice V2.1 (F-05): Strategy excluded from / restored to `totalAssets()` accounting
    ///         by Owner. Used when an external protocol view path becomes unreachable so the
    ///         vault keeps serving deposits/withdrawals. Share price will jump if the
    ///         strategy still holds funds — Owner must reconcile off-chain first.
    event StrategyQuarantineUpdated(address indexed strategy, bool quarantined);

    /// @notice Keeper transferred `amount` of asset from Vault idle into strategy via `IStrategy.deposit`.
    event InvestedToStrategy(address indexed strategy, uint256 amount);

    /// @notice Keeper requested `requested` to be pulled back from strategy; strategy returned `withdrawn`.
    ///         Slippage / partial-withdraw is normal — front-end should display delta if nonzero.
    event DivestedFromStrategy(address indexed strategy, uint256 requested, uint256 withdrawn);

    /// @notice Keeper drained strategy via `IStrategy.emergencyWithdraw()`. Strategy is auto-blacklisted
    ///         (`isActive=false`, `isBlacklisted=true`, `blacklistedAt=now`) — un-blacklist requires
    ///         `BLACKLIST_COOLDOWN` (72h) + Owner action.
    event EmergencyWithdrawn(address indexed strategy, uint256 withdrawn);

    /// @notice Emitted when `_autoPullFromStrategies` (called from user `withdraw`/`redeem`)
    ///         skipped a strategy because its `withdraw(amount)` reverted.
    /// @dev Common cause: protocol-level dust thresholds (e.g. Venus vToken redeem of
    ///      sub-unit underlying → `redeemTokens zero` revert). The user withdraw continues
    ///      to the next strategy — overall tx is NOT reverted unless ALL strategies fail
    ///      AND idle remains short, in which case `IdleInsufficient` reverts at the end.
    ///      Off-chain monitors should alert on repeated emissions (operator action signal:
    ///      consider `emergencyWithdraw` on the offending strategy).
    /// @param strategy   The strategy whose `withdraw` call reverted.
    /// @param requested  The asset amount that was attempted to pull (skipped).
    event StrategyWithdrawSkipped(address indexed strategy, uint256 requested);

    /// @notice Emitted when streaming fee is realized (Treasury receives newly-minted shares).
    /// @param feeAssets    Notional asset value of the fee at the time of accrual.
    /// @param feeShares    Number of shares minted to `treasury` (dilutive).
    /// @param newSp        Share price (1e18 normalized) AFTER fee mint (= new baseline).
    event FeesAccrued(uint256 feeAssets, uint256 feeShares, uint256 newSp);

    // ─────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────

    /// @dev Restricts callable functions to the configured `keeper` EOA only.
    ///      Reverts with `Errors.NotKeeper()` on mismatch.
    modifier onlyKeeper() {
        if (msg.sender != keeper) revert Errors.NotKeeper();
        _;
    }

    /// @dev Restricts callable functions to the configured `guardian` EOA only.
    ///      Reverts with `Errors.NotGuardian()` on mismatch.
    modifier onlyGuardian() {
        if (msg.sender != guardian) revert Errors.NotGuardian();
        _;
    }

    // ─────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────

    /// @notice Aggregated initialization config. Grouped into a struct so the constructor
    ///         fits within Solidity's stack-depth limit without `viaIR=true` — important for
    ///         solidity-coverage instrumentation compatibility.
    /// @dev Field order has no on-chain significance, but matches the historical positional
    ///      constructor for diff readability.
    struct InitConfig {
        IERC20 asset;
        string name;
        string symbol;
        address initialOwner;
        address keeper;
        address guardian;
        address treasury;
        uint16 feeRate;
        uint256 depositCap;
        uint256 defaultUserCap;
        uint16 maxAllocationAbsolute; // per-tier cap (2500 / 4000 / 6000)
        bytes32 versionHash;          // see V2_VAULT.md §4.4 (6-hash matrix)
    }

    constructor(InitConfig memory cfg)
        ERC4626(cfg.asset)
        ERC20(cfg.name, cfg.symbol)
        Ownable(cfg.initialOwner)
    {
        if (cfg.keeper == address(0) || cfg.guardian == address(0) || cfg.treasury == address(0)) {
            revert Errors.ZeroAddress();
        }
        if (cfg.feeRate > MAX_FEE) revert Errors.FeeTooHigh(cfg.feeRate, MAX_FEE);
        if (cfg.maxAllocationAbsolute == 0 || cfg.maxAllocationAbsolute > MAX_ALLOCATION_CEILING) {
            revert Errors.AllocationExceeded(cfg.maxAllocationAbsolute, MAX_ALLOCATION_CEILING);
        }
        if (cfg.depositCap == 0) revert Errors.ZeroAmount();
        if (cfg.defaultUserCap == 0) revert Errors.ZeroAmount();

        keeper = cfg.keeper;
        guardian = cfg.guardian;
        treasury = cfg.treasury;
        feeRate = cfg.feeRate;
        depositCap = cfg.depositCap;
        defaultUserCap = cfg.defaultUserCap;
        MAX_ALLOCATION_BPS_ABSOLUTE = cfg.maxAllocationAbsolute;
        VERSION_HASH = cfg.versionHash;

        // Streaming fee baseline — lazy init.
        //
        // `lastSharePrice` is NOT pre-seeded with `ACCRUE_PRECISION` (1e18). Reason:
        // `_calcSharePrice()` returns `TA × 1e18 / TS`, and on the first deposit the
        // share count is `assets × 10**decimalsOffset` (= USDC 6 + offset 6 = 1e12 units).
        // That makes the first observed `sp ≈ 1e12`, far below 1e18 — a naive
        // ACCRUE_PRECISION baseline would trip the loss-tolerance branch on the very
        // first action and silently drift the baseline downward.
        //
        // Instead we leave `lastSharePrice = 0` (default) and snap it to the actual
        // share price in `_deposit()` right after `super._deposit()` produces non-zero
        // supply. `_accrue()` also carries a defensive `lastSharePrice == 0` early-return
        // for any path where supply becomes non-zero without going through `_deposit`.
        lastAccruedAt = block.timestamp;

        emit KeeperUpdated(cfg.keeper);
        emit GuardianUpdated(cfg.guardian);
        emit TreasuryUpdated(cfg.treasury);
        emit FeeRateUpdated(cfg.feeRate);
        emit DepositCapUpdated(cfg.depositCap);
        emit DefaultUserCapUpdated(cfg.defaultUserCap);
    }

    // ─────────────────────────────────────────────────────────────
    // Decimals offset (ERC-4626 inflation attack mitigation)
    // ─────────────────────────────────────────────────────────────

    /// @dev Returns the shares-to-asset decimal offset (= 6). USDC has 6 decimals → shares get 12.
    ///      OpenZeppelin's `_decimalsOffset` is the canonical inflation-attack defense for ERC-4626.
    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }

    // ─────────────────────────────────────────────────────────────
    // ERC-4626 conversion overrides (V2.1.2 — accrue-aware view math)
    // ─────────────────────────────────────────────────────────────

    /// @dev V2.1.2 — override to include pending streaming-fee shares in the divisor.
    ///      Without this, view helpers (`maxWithdraw` / `previewWithdraw` /
    ///      `previewRedeem` / `convertToAssets`) return a value that the transactional
    ///      path cannot honor: `withdraw()` calls `_accrue()` first, which mints new
    ///      treasury shares and dilutes each user share. A user hitting MAX with the
    ///      pre-fix `maxWithdraw` triggers `ERC4626ExceededMaxWithdraw` by a small
    ///      residual (= the fee that would be minted mid-tx).
    ///
    ///      Correctness on the transactional path is preserved: `_deposit` / `_withdraw`
    ///      / `mint` / `redeem` all call `_accrue()` before super, so at the moment
    ///      `_convertToAssets` runs inside those paths, `_pendingFeeShares()` returns 0.
    ///      This override is therefore a **no-op on transactional paths** and a
    ///      correction only on external view queries.
    ///
    ///      This is a natural extension of Soken F-01 (accrue-BEFORE-preview) from the
    ///      transactional path to the view path — same principle, same accounting model.
    function _convertToAssets(uint256 shares, Math.Rounding rounding)
        internal
        view
        override
        returns (uint256)
    {
        return shares.mulDiv(
            totalAssets() + 1,
            totalSupply() + _pendingFeeShares() + 10 ** _decimalsOffset(),
            rounding
        );
    }

    /// @dev V2.1.2 — mirror of `_convertToAssets` for the shares direction. See rationale above.
    function _convertToShares(uint256 assets, Math.Rounding rounding)
        internal
        view
        override
        returns (uint256)
    {
        return assets.mulDiv(
            totalSupply() + _pendingFeeShares() + 10 ** _decimalsOffset(),
            totalAssets() + 1,
            rounding
        );
    }

    // ─────────────────────────────────────────────────────────────
    // 🌟 STREAMING FEE — core innovation of V2
    // ─────────────────────────────────────────────────────────────

    /// @notice Read-only view of pending fee shares (= would-mint amount if `_accrue` ran now).
    /// @dev Off-chain consumers (frontend / Keeper bot / DeFiLlama) can show "accrued but not realized".
    ///      Returns 0 if share price has not grown since last accrual (loss tolerance — see [[1]] below).
    function pendingFeeShares() external view returns (uint256) {
        return _pendingFeeShares();
    }

    /// @dev V2.1.2 — internal variant of `pendingFeeShares()` so the view-function
    ///      overrides (`_convertToAssets` / `_convertToShares`) can reuse it without
    ///      an external self-call. Identical semantics to the external wrapper.
    function _pendingFeeShares() internal view returns (uint256) {
        if (totalSupply() == 0) return 0;
        uint256 sp = _calcSharePrice();
        if (sp <= lastSharePrice) return 0;
        return _feeSharesFor(sp);
    }

    /// @notice Forces accrual. Anyone can call (no permission) — harmless / idempotent.
    /// @dev Useful for manual sync or Keeper convenience. Normal users don't need to call it.
    function accrue() external nonReentrant {
        _accrue();
    }

    /// @dev Internal accrual — invoked by every state-changing user action (`_deposit` / `_withdraw`)
    ///      and by `setFeeRate` (so old rate is locked in before new rate applies — anti-soak guard).
    ///
    ///      Three audit-critical fixes baked into this implementation (see [[2..4]]):
    ///        [[1]] Loss tolerance: `sp <= lastSp` → no fee, baseline only updates downward (no
    ///              double-charging when sp recovers from a transient dip — but no HWM either,
    ///              by design choice [[CONFIRMED 2026-06-01]]).
    ///        [[2]] Direct asset-unit fee math (no `profitBps` intermediate) — preserves 1e18
    ///              precision on stable yields (5% APY = 1.37bps/day, would lose 27%/day to
    ///              integer truncation if going through bps).
    ///        [[3]] Correct dilutive share-mint formula:
    ///              `feeShares = feeAssets × TS / (TA - feeAssets)`  ← solves for "minted shares
    ///              equal feeAssets in value after dilution". Standard `convertToShares(feeAssets)`
    ///              would slightly undercharge.
    ///        [[4]] Post-mint baseline = `sp` (pre-mint, the value we just taxed) — NOT recalculated
    ///              `_calcSharePrice()` (post-mint, already-diluted). Re-reading would let the
    ///              dilution-recovery be re-counted as new yield → double taxation.
    function _accrue() internal {
        if (lastAccruedAt == block.timestamp) return;   // same-block re-entry: skip
        if (totalSupply() == 0) {
            // V2.1 — Soken F-17 remediation: clear baseline so the next deposit re-snaps to
            // the fresh share price. Without this reset, a re-seeded vault carries a stale-positive
            // `lastSharePrice` that triggers an enormous apparent jump on the next deposit and
            // permanently bricks the vault on the FeeTooHigh guard at L#L435 below.
            lastAccruedAt = block.timestamp;
            lastSharePrice = 0;
            return;
        }

        uint256 sp = _calcSharePrice();

        // Defensive lazy-init guard. Normally `_deposit()` snaps `lastSharePrice` to the
        // first sp after `super._deposit()`, so this branch only triggers if supply became
        // non-zero by some non-standard path. Treat as "first observation": initialize baseline
        // and skip fee (no historical reference to compare against).
        /* istanbul ignore next — unreachable under standard deposit flow; kept as a defensive
           guard for any future path that bumps totalSupply() outside _deposit. */
        if (lastSharePrice == 0) {
            lastAccruedAt = block.timestamp;
            lastSharePrice = sp;
            return;
        }

        // [[1]] Loss/flat: no fee, baseline tracks downward (no HWM by design)
        if (sp <= lastSharePrice) {
            lastAccruedAt = block.timestamp;
            lastSharePrice = sp;
            return;
        }

        // [[2]] Compute feeAssets from realized profit, not post-yield TA (Soken F-03 fix).
        //       Old (over-charged): feeAssets = TA_now × g × feeRate / 1e4 = correct × (1+g)
        //       New (exact):        feeAssets = TS × (sp - lastSp) / 1e18 × feeRate / 1e4
        //                                     = realized profit × feeRate
        //       The post-yield TA basis charged a multiplicative (1+g) over-tax (e.g. 16.5%
        //       on a 10% gap at the 15% headline rate). The supply-at-baseline basis exactly
        //       matches the marketed "X% of yield" semantics.
        uint256 ts = totalSupply();
        uint256 feeAssets = ts.mulDiv(
            (sp - lastSharePrice) * uint256(feeRate),
            ACCRUE_PRECISION * 10_000,
            Math.Rounding.Floor
        );
        uint256 ta = totalAssets();

        if (feeAssets == 0) {
            // Sub-wei profit / extreme dust — skip mint, bump baseline + timestamp
            lastAccruedAt = block.timestamp;
            lastSharePrice = sp;
            return;
        }

        // Safety: feeAssets cannot exceed totalAssets (defensive — denominator math would already block)
        if (feeAssets >= ta) {
            // Should never happen on a non-pathological feeRate ≤ 2000. Defensive revert.
            revert Errors.FeeTooHigh(feeRate, MAX_FEE);
        }

        // [[3]] Correct dilutive share-mint: shares such that minted value = feeAssets after dilution
        uint256 feeShares = feeAssets.mulDiv(ts, ta - feeAssets, Math.Rounding.Floor);

        /* istanbul ignore next — Math.mulDiv(Floor) of a positive numerator can in theory
           round to zero, but only under degenerate supply (≈ 1 wei share). OZ's ERC-4626
           _decimalsOffset mitigation keeps the share floor far above that. */
        if (feeShares == 0) {
            lastAccruedAt = block.timestamp;
            lastSharePrice = sp;
            return;
        }

        _mint(treasury, feeShares);

        // [[4]] Baseline = pre-mint sp (already taxed), NOT post-mint (would double-tax on recovery)
        lastAccruedAt = block.timestamp;
        lastSharePrice = sp;

        emit FeesAccrued(feeAssets, feeShares, sp);
    }

    /// @dev Share price in 1e18-normalized assets-per-share.
    ///      Returns ACCRUE_PRECISION when supply is 0 (pre-first-deposit).
    function _calcSharePrice() internal view returns (uint256) {
        uint256 ts = totalSupply();
        /* istanbul ignore next — both callers (_accrue, _feeSharesFor via pendingFeeShares)
           gate on totalSupply() > 0 first; kept defensively to keep the helper standalone. */
        if (ts == 0) return ACCRUE_PRECISION;
        return totalAssets().mulDiv(ACCRUE_PRECISION, ts, Math.Rounding.Floor);
    }

    /// @dev Compute would-mint fee shares for a hypothetical post-yield share price `sp`.
    ///      Used by view function `pendingFeeShares` — not by `_accrue` (which inlines for clarity).
    /// @dev V2.1 — Soken F-03: identical formula change as `_accrue`. fee base is
    ///      totalSupply × (sp - lastSharePrice) / 1e18 (= realized profit), not post-yield TA.
    function _feeSharesFor(uint256 sp) internal view returns (uint256) {
        uint256 ts = totalSupply();
        uint256 feeAssets = ts.mulDiv(
            (sp - lastSharePrice) * uint256(feeRate),
            ACCRUE_PRECISION * 10_000,
            Math.Rounding.Floor
        );
        uint256 ta = totalAssets();
        if (feeAssets == 0 || feeAssets >= ta) return 0;
        return feeAssets.mulDiv(ts, ta - feeAssets, Math.Rounding.Floor);
    }

    // ─────────────────────────────────────────────────────────────
    // ERC-4626 hooks — accrue BEFORE deposit/withdraw runs
    // ─────────────────────────────────────────────────────────────

    /// @dev OZ ERC-4626 hook. Runs `_accrue()` first (so the deposit price is fee-correct),
    ///      then enforces per-user + Vault caps, then delegates to `super._deposit()`.
    ///      Lazy initializes `lastSharePrice` after the first successful deposit (see constructor).
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
    {
        _accrue();
        // Per-user cap
        uint256 cap = userCap[receiver] > 0 ? userCap[receiver] : defaultUserCap;
        uint256 receiverPosition = convertToAssets(balanceOf(receiver));
        if (receiverPosition + assets > cap) revert Errors.UserCapExceeded(receiverPosition + assets, cap);
        // Vault cap
        if (totalAssets() + assets > depositCap) {
            revert Errors.DepositCapReached(totalAssets() + assets, depositCap);
        }
        super._deposit(caller, receiver, assets, shares);

        // Lazy baseline init (see constructor comment). After the first successful super._deposit
        // totalSupply() > 0 holds, so `_calcSharePrice()` returns a meaningful value that matches
        // the scale produced by `_accrue()` going forward. Skipped on subsequent deposits because
        // `lastSharePrice` is already non-zero (and would otherwise overwrite a taxed baseline).
        if (lastSharePrice == 0) {
            lastSharePrice = _calcSharePrice();
        }
    }

    /// @dev OZ ERC-4626 hook. Runs `_accrue()` first (fee-correct exit price), then auto-pulls
    ///      from strategies if Vault idle is insufficient, then delegates to `super._withdraw()`.
    ///      Auto-pull iterates `strategyList` until enough idle is gathered, reverting
    ///      `IdleInsufficient` if exhaustion still leaves idle short.
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        _accrue();
        // Auto-pull from strategies if idle insufficient
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle < assets) {
            _autoPullFromStrategies(assets - idle);
        }
        super._withdraw(caller, receiver, owner, assets, shares);

        // V2.1 — Soken F-17 remediation: if the last share exited, clear the baseline so a
        // re-seeding deposit lands on the lazy-init path (`if (lastSharePrice == 0)` in `_deposit`)
        // and re-snaps to the fresh price instead of detonating the FeeTooHigh guard via a
        // stale-positive baseline.
        if (totalSupply() == 0) {
            lastSharePrice = 0;
        }
    }

    /// @inheritdoc ERC4626
    /// @dev Wraps with `nonReentrant` + `whenNotPaused`. Per-user / Vault caps enforced inside `_deposit`.
    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        // V2.1 (Soken F-01): accrue BEFORE OpenZeppelin prices the share count.
        // `super.deposit` calls `previewDeposit(assets)` first; without this hook the
        // pending fee mint would inflate `totalSupply()` *after* pricing, leaving the
        // depositor with fewer shares than their assets are worth post-accrue.
        // `_deposit` calls `_accrue()` again — the lastAccruedAt same-block guard makes
        // the second call a no-op (defence in depth).
        _accrue();
        return super.deposit(assets, receiver);
    }

    /// @inheritdoc ERC4626
    /// @dev Wraps with `nonReentrant` + `whenNotPaused`. Mints `shares` to `receiver` by converting assets.
    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        // V2.1 (Soken F-01): see `deposit` rationale — accrue before pricing.
        _accrue();
        return super.mint(shares, receiver);
    }

    /// @inheritdoc ERC4626
    /// @dev Withdraw is ALWAYS allowed, even when paused (CLAUDE.md §2.4 invariant). Auto-pulls from
    ///      strategies via `_autoPullFromStrategies` if idle is short.
    /// @dev V2.1 (Soken F-01): accrue BEFORE `previewWithdraw` (which super calls). Without
    ///      this, the withdrawer burns fewer shares than the post-accrue ratio requires
    ///      and over-extracts at remaining holders' expense.
    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        _accrue();
        return super.withdraw(assets, receiver, owner);
    }

    /// @inheritdoc ERC4626
    /// @dev Same invariants as `withdraw`. Burns `shares` and returns the corresponding assets.
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        // V2.1 (Soken F-01): accrue before pricing — see `withdraw` rationale.
        _accrue();
        return super.redeem(shares, receiver, owner);
    }

    /// @inheritdoc ERC4626
    /// @dev Returns the minimum of: (a) per-user remaining cap and (b) Vault remaining cap.
    ///      Returns 0 while paused (Vault rejects new deposits).
    function maxDeposit(address receiver) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 cap = userCap[receiver] > 0 ? userCap[receiver] : defaultUserCap;
        uint256 pos = convertToAssets(balanceOf(receiver));
        uint256 userRemaining = pos < cap ? cap - pos : 0;
        uint256 ta = totalAssets();
        uint256 vaultRemaining = ta < depositCap ? depositCap - ta : 0;
        return userRemaining < vaultRemaining ? userRemaining : vaultRemaining;
    }

    /// @inheritdoc ERC4626
    /// @dev Convenience converter — `maxDeposit(receiver)` translated to share units.
    function maxMint(address receiver) public view override returns (uint256) {
        return convertToShares(maxDeposit(receiver));
    }

    /// @inheritdoc ERC4626
    /// @notice Vault total assets = idle USDC + Σ strategy.balanceOf() (active + blacklisted).
    /// @dev INVARIANT: `totalAssets() == idle + sum(strategy.balanceOf for s in strategyList
    ///      where isActive || isBlacklisted)`. Verified by [CLAUDE.md §5.2] invariant tests.
    ///      Blacklisted strategies are still summed so that user redemptions don't undervalue
    ///      shares (assets are still recoverable via Owner `removeStrategy` after blacklist).
    function totalAssets() public view override returns (uint256) {
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        uint256 length = strategyList.length;
        uint256 sum;
        for (uint256 i = 0; i < length; ++i) {
            address s = strategyList[i];
            StrategyInfo storage info = strategyInfo[s];
            if (!info.isActive && !info.isBlacklisted) continue;
            // V2.1 (Soken F-05): Owner-controlled escape hatch. A quarantined strategy is
            // excluded from accounting so a reverting external view (paused / exploited
            // / migrated underlying protocol) cannot freeze the entire ERC-4626 surface.
            // See `setQuarantine` for invariants and the off-chain reconciliation requirement.
            if (info.isQuarantined) continue;
            sum += IStrategy(s).balanceOf();
        }
        return idle + sum;
    }

    // ─────────────────────────────────────────────────────────────
    // Owner config setters — _accrue() BEFORE rate changes
    // ─────────────────────────────────────────────────────────────

    /// @notice Replace the Keeper EOA. Only Owner can call.
    /// @param newKeeper The new Keeper address. Non-zero required.
    function setKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) revert Errors.ZeroAddress();
        keeper = newKeeper;
        emit KeeperUpdated(newKeeper);
    }

    /// @notice Replace the Guardian EOA. Only Owner can call.
    /// @param newGuardian The new Guardian address. Non-zero required.
    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert Errors.ZeroAddress();
        guardian = newGuardian;
        emit GuardianUpdated(newGuardian);
    }

    /// @notice Replace the Treasury (streaming-fee share recipient). Only Owner can call.
    /// @dev Calls `_accrue()` first so that pending fee shares mint to the OLD treasury
    ///      before the address swap — prevents "treasury swap during pending yield" exploit.
    /// @param newTreasury The new Treasury address. Non-zero required.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert Errors.ZeroAddress();
        _accrue();          // settle any pending fees to OLD treasury before switch
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice Update performance fee rate. Accrues old rate first → no retroactive taxation.
    /// @dev CRITICAL: `_accrue()` runs BEFORE `feeRate` is mutated so that historical yield
    ///      is taxed at the OLD rate. Without this, a rate change would retroactively re-tax
    ///      already-realized yield at the new rate (audit-critical pattern).
    /// @param newRate The new fee rate in bps. Bounded by `MAX_FEE` (= 2000 / 20%).
    function setFeeRate(uint16 newRate) external onlyOwner {
        if (newRate > MAX_FEE) revert Errors.FeeTooHigh(newRate, MAX_FEE);
        _accrue();          // CRITICAL: lock in fees at OLD rate before NEW rate applies
        feeRate = newRate;
        emit FeeRateUpdated(newRate);
    }

    /// @notice Update Vault total deposit cap. Only Owner can call. Zero halts new deposits
    ///         (existing positions still withdrawable — used for V1 → V2 migration step 2).
    /// @param newCap The new Vault cap in asset units (USDC raw with 6 decimals).
    function setDepositCap(uint256 newCap) external onlyOwner {
        depositCap = newCap;
        emit DepositCapUpdated(newCap);
    }

    /// @notice Update default per-user cap (applies when `userCap[user] == 0`). Only Owner.
    /// @param newCap The new default per-user cap in asset units.
    function setDefaultUserCap(uint256 newCap) external onlyOwner {
        defaultUserCap = newCap;
        emit DefaultUserCapUpdated(newCap);
    }

    /// @notice Override a specific user's cap. Only Owner. Setting `newCap = 0` reverts
    ///         the user back to `defaultUserCap`.
    /// @param user   The user address whose cap is being overridden.
    /// @param newCap The override cap in asset units (0 → revert to default).
    function setUserCap(address user, uint256 newCap) external onlyOwner {
        userCap[user] = newCap;
        emit UserCapUpdated(user, newCap);
    }

    // ─────────────────────────────────────────────────────────────
    // Strategy management — unchanged from V1 except removed lastRecordedBalance
    // ─────────────────────────────────────────────────────────────

    /// @notice Whitelist a strategy. Only Owner. Strategy must:
    ///   1. expose `IStrategy.asset()` matching the Vault's underlying USDC,
    ///   2. specify `maxAllocationBps_ ≤ MAX_ALLOCATION_BPS_ABSOLUTE` (tier cap),
    ///   3. specify `targetBps ≤ maxAllocationBps_`.
    /// @dev Pushes to `strategyList` (iterable). Already-added or blacklisted strategy reverts.
    /// @param strategy           Strategy contract address (must implement `IStrategy`).
    /// @param targetBps          Initial allocation target the Keeper aims for (bps of TVL).
    /// @param maxAllocationBps_  Per-strategy hard cap (bps). Must satisfy ≤ `MAX_ALLOCATION_BPS_ABSOLUTE`.
    function addStrategy(address strategy, uint16 targetBps, uint16 maxAllocationBps_) external onlyOwner {
        if (strategy == address(0)) revert Errors.ZeroAddress();
        StrategyInfo storage info = strategyInfo[strategy];
        if (info.isActive || info.isBlacklisted) revert Errors.StrategyAlreadyAdded(strategy);

        address strategyAsset = IStrategy(strategy).asset();
        if (strategyAsset != asset()) revert Errors.AssetMismatch(asset(), strategyAsset);

        if (maxAllocationBps_ > MAX_ALLOCATION_BPS_ABSOLUTE) {
            revert Errors.AllocationExceeded(maxAllocationBps_, MAX_ALLOCATION_BPS_ABSOLUTE);
        }
        if (targetBps > maxAllocationBps_) {
            revert Errors.AllocationExceeded(targetBps, maxAllocationBps_);
        }

        info.targetBps = targetBps;
        info.maxAllocationBps = maxAllocationBps_;
        info.isActive = true;
        info.isBlacklisted = false;
        info.blacklistedAt = 0;
        strategyList.push(strategy);
        emit StrategyAdded(strategy, targetBps, maxAllocationBps_);
    }

    /// @notice Update a strategy's per-strategy hard cap. Only Owner.
    /// @dev Strategy must be active or blacklisted (already registered). New cap must satisfy
    ///      `newMaxBps ≤ MAX_ALLOCATION_BPS_ABSOLUTE` AND `info.targetBps ≤ newMaxBps`.
    /// @param strategy   The strategy address whose cap is being updated.
    /// @param newMaxBps  The new max allocation in bps.
    function setStrategyMaxAllocation(address strategy, uint16 newMaxBps) external onlyOwner {
        StrategyInfo storage info = strategyInfo[strategy];
        if (!info.isActive && !info.isBlacklisted) revert Errors.StrategyNotWhitelisted(strategy);
        if (newMaxBps > MAX_ALLOCATION_BPS_ABSOLUTE) {
            revert Errors.AllocationExceeded(newMaxBps, MAX_ALLOCATION_BPS_ABSOLUTE);
        }
        if (info.targetBps > newMaxBps) {
            revert Errors.AllocationExceeded(info.targetBps, newMaxBps);
        }
        info.maxAllocationBps = newMaxBps;
        emit StrategyMaxAllocationUpdated(strategy, newMaxBps);
    }

    /// @notice Permanently remove a strategy. Only Owner. Strategy must have **zero balance**
    ///         (Keeper should `divestFromStrategy` everything first).
    /// @dev V2.1 — Soken F-02/F-07 remediation: the address is now swap-and-popped out of
    ///      `strategyList` as well as marked inactive. Without the array removal, a later
    ///      re-add (which only checks `isActive || isBlacklisted`) would create a duplicate
    ///      entry and `totalAssets()` would double-count the strategy's balance.
    /// @param strategy  The strategy address to remove.
    function removeStrategy(address strategy) external onlyOwner {
        StrategyInfo storage info = strategyInfo[strategy];
        if (!info.isActive && !info.isBlacklisted) revert Errors.StrategyNotWhitelisted(strategy);
        uint256 bal = IStrategy(strategy).balanceOf();
        if (bal > 0) revert Errors.StrategyHasBalance(strategy, bal);
        info.isActive = false;
        info.isBlacklisted = false;
        info.targetBps = 0;

        // Swap-and-pop `strategy` out of `strategyList` (F-02/F-07).
        uint256 length = strategyList.length;
        for (uint256 i = 0; i < length; ++i) {
            if (strategyList[i] == strategy) {
                if (i != length - 1) {
                    strategyList[i] = strategyList[length - 1];
                }
                strategyList.pop();
                break;
            }
        }

        emit StrategyRemoved(strategy);
    }

    /// @notice Re-enable a blacklisted strategy. Only Owner. Requires `BLACKLIST_COOLDOWN` (72h)
    ///         to have elapsed since the auto-blacklist trigger — cooling-off period for
    ///         re-evaluation of the underlying protocol issue.
    /// @param strategy  The blacklisted strategy address.
    function unblacklistStrategy(address strategy) external onlyOwner {
        StrategyInfo storage info = strategyInfo[strategy];
        if (!info.isBlacklisted) revert Errors.StrategyNotWhitelisted(strategy);
        if (block.timestamp < info.blacklistedAt + BLACKLIST_COOLDOWN) {
            revert Errors.BlacklistCooldownActive(info.blacklistedAt + BLACKLIST_COOLDOWN);
        }
        info.isBlacklisted = false;
        info.isActive = true;
        info.blacklistedAt = 0;
        emit StrategyUnblacklisted(strategy);
    }

    /// @notice V2.1 (Soken F-05): Owner-controlled accounting escape hatch. Excludes a
    ///         strategy from `totalAssets()` and `_autoPullFromStrategies` without calling
    ///         its `balanceOf()` / `withdraw()`. Use when the strategy's external view path
    ///         is unreachable (paused / exploited / migrated) so the vault keeps serving
    ///         deposits and withdrawals on the remaining strategies + idle.
    /// @dev    The strategy must already be registered (active or blacklisted). Quarantine
    ///         is intentionally orthogonal to active/blacklisted: an active-and-quarantined
    ///         strategy can be unquarantined to resume invest/divest, and a blacklisted
    ///         strategy can be quarantined to prevent its `balanceOf` from gating
    ///         `totalAssets()` after `emergencyWithdraw` failed.
    ///
    ///         ⚠ Setting `quarantined=true` removes the strategy's value from the share
    ///         price; off-chain reconciliation MUST confirm the residual on-chain balance
    ///         before quarantining (otherwise users entering after the quarantine pay below
    ///         the true price and existing holders take the loss). Clearing `quarantined=false`
    ///         when the protocol recovers similarly re-introduces the balance, lifting sp.
    /// @param strategy     The strategy to quarantine or restore.
    /// @param quarantined  True = exclude from accounting; False = include.
    function setQuarantine(address strategy, bool quarantined) external onlyOwner {
        StrategyInfo storage info = strategyInfo[strategy];
        if (!info.isActive && !info.isBlacklisted) revert Errors.StrategyNotWhitelisted(strategy);
        info.isQuarantined = quarantined;
        emit StrategyQuarantineUpdated(strategy, quarantined);
    }

    // ─────────────────────────────────────────────────────────────
    // Keeper actions — invest/divest (no fee logic; fees come from share price tracking)
    // ─────────────────────────────────────────────────────────────

    /// @notice Keeper deposits idle USDC into an active strategy.
    /// @dev Validates: strategy active, amount > 0, idle ≥ amount, post-deposit strategy
    ///      balance ≤ `(totalAssets × maxAllocationBps) / 10_000` (per-strategy cap).
    ///      Uses `forceApprove` (SafeERC20) to handle non-standard ERC-20 approve semantics.
    /// @param strategy  The active strategy to invest into.
    /// @param amount    Asset units to invest (USDC raw). Must be > 0.
    function investToStrategy(address strategy, uint256 amount) external onlyKeeper nonReentrant {
        StrategyInfo storage info = strategyInfo[strategy];
        if (!info.isActive) revert Errors.StrategyNotWhitelisted(strategy);
        // V2.1 (Soken F-05): block invest into a quarantined strategy — quarantine signals
        // the underlying protocol view path is broken, so new principal would be unrecoverable
        // until quarantine clears.
        if (info.isQuarantined) revert Errors.StrategyNotWhitelisted(strategy);
        if (amount == 0) revert Errors.ZeroAmount();

        IERC20 vaultAsset = IERC20(asset());
        uint256 idle = vaultAsset.balanceOf(address(this));
        if (idle < amount) revert Errors.IdleInsufficient(amount, idle);

        uint256 ta = totalAssets();
        uint256 maxStratAlloc = (ta * info.maxAllocationBps) / 10_000;
        uint256 newStratBal = IStrategy(strategy).balanceOf() + amount;
        if (newStratBal > maxStratAlloc) {
            revert Errors.AllocationExceeded(newStratBal, maxStratAlloc);
        }

        vaultAsset.forceApprove(strategy, amount);
        IStrategy(strategy).deposit(amount);
        emit InvestedToStrategy(strategy, amount);
    }

    /// @notice Keeper pulls assets back from a strategy.
    /// @dev Strategy can be active OR blacklisted (so blacklisted protocols can still be drained).
    ///      Partial returns are normal (strategy may not have sufficient liquid balance).
    /// @param strategy  The strategy to divest from.
    /// @param amount    Asset units to request back. Strategy may return less (partial liquidity).
    function divestFromStrategy(address strategy, uint256 amount) external onlyKeeper nonReentrant {
        StrategyInfo storage info = strategyInfo[strategy];
        if (!info.isActive && !info.isBlacklisted) revert Errors.StrategyNotWhitelisted(strategy);
        if (amount == 0) revert Errors.ZeroAmount();
        uint256 withdrawn = IStrategy(strategy).withdraw(amount);
        emit DivestedFromStrategy(strategy, amount, withdrawn);
    }

    /// @notice Drain a strategy entirely + auto-blacklist. Used when a strategy is compromised
    ///         (hack, depeg, governance attack). Sets `isActive=false`, `isBlacklisted=true`,
    ///         `blacklistedAt=now`. Un-blacklist requires `BLACKLIST_COOLDOWN` (72h) + Owner action.
    /// @dev Strategy must be active (already blacklisted = use `divestFromStrategy` instead).
    ///      Skips the `emergencyWithdraw()` call if the strategy reports zero balance.
    /// @param strategy  The active strategy to emergency-drain.
    function emergencyWithdraw(address strategy) external onlyKeeper nonReentrant {
        StrategyInfo storage info = strategyInfo[strategy];
        if (!info.isActive) revert Errors.StrategyNotWhitelisted(strategy);
        uint256 bal = IStrategy(strategy).balanceOf();
        uint256 withdrawn;
        if (bal > 0) {
            withdrawn = IStrategy(strategy).emergencyWithdraw();
        }
        info.isActive = false;
        info.isBlacklisted = true;
        info.blacklistedAt = block.timestamp;
        emit EmergencyWithdrawn(strategy, withdrawn);
        emit StrategyBlacklisted(strategy);
    }

    // ─────────────────────────────────────────────────────────────
    // Auto-pull from strategies (called by _withdraw when idle insufficient)
    // ─────────────────────────────────────────────────────────────

    /// @dev Called by `_withdraw` when Vault idle is insufficient for the requested withdraw.
    ///      Iterates `strategyList` in insertion order and pulls from each active strategy until
    ///      `needed` is met. Skips blacklisted strategies and zero-balance entries.
    ///
    ///      **Try-catch wrap**: `IStrategy.withdraw(pull)` is invoked inside a `try` block. If
    ///      the strategy's underlying protocol reverts (dust-level rounding, protocol pause,
    ///      utilization 100%, etc.) the iteration continues with the next strategy instead of
    ///      bubbling the revert and failing the entire user withdraw. A `StrategyWithdrawSkipped`
    ///      event is emitted so off-chain monitors can trigger an operator response (typically
    ///      `emergencyWithdraw` on the offending strategy, see V1 BSC Venus dust incident
    ///      2026-06-09 as the design driver).
    ///
    ///      Reverts `IdleInsufficient` ONLY if total pulls still leave idle below `needed` after
    ///      the loop — i.e. user fund safety is preserved (try-catch never silently shorts
    ///      the user; they always get full asset or a clear revert).
    /// @param needed  Asset units of additional idle required to satisfy the pending withdraw.
    function _autoPullFromStrategies(uint256 needed) internal {
        IERC20 vaultAsset = IERC20(asset());
        uint256 idleBefore = vaultAsset.balanceOf(address(this));
        uint256 remaining = needed;
        uint256 length = strategyList.length;
        for (uint256 i = 0; i < length && remaining > 0; ++i) {
            address s = strategyList[i];
            StrategyInfo storage info = strategyInfo[s];
            if (!info.isActive) continue;
            // V2.1 (Soken F-05): skip quarantined strategies — their `balanceOf` /
            // `withdraw` view path is unreachable and would revert the whole user withdraw.
            // User funds in a quarantined strategy are only recoverable after Owner clears
            // the quarantine flag (typically post external-protocol fix or migration).
            if (info.isQuarantined) continue;
            uint256 sBal = IStrategy(s).balanceOf();
            if (sBal == 0) continue;
            uint256 pull = sBal < remaining ? sBal : remaining;
            // try-catch: strategy.withdraw revert 시 다음 strategy 로 fallback. user 자금은
            // 루프 후 `pulled < needed` 검증 (`IdleInsufficient`) 으로 보호됨.
            try IStrategy(s).withdraw(pull) returns (uint256 withdrawn) {
                emit DivestedFromStrategy(s, pull, withdrawn);
                remaining = withdrawn >= remaining ? 0 : remaining - withdrawn;
            } catch {
                emit StrategyWithdrawSkipped(s, pull);
                // remaining 변경 없음 — 다음 strategy 가 부족분 보충 시도
            }
        }
        // 부족분 검증: 루프가 needed 만큼 실제로 끌어왔는지 확인. `idle` 단일 비교는 (idle 은
        // 항상 needed 이상이라) 의미가 없어 audit 친화적 검사가 아니었음 — `pulled < needed`
        // 로 보강. user 가 항상 정확한 금액을 받거나 명확한 `IdleInsufficient` revert.
        uint256 idleAfter = vaultAsset.balanceOf(address(this));
        uint256 pulled = idleAfter - idleBefore;
        if (pulled < needed) revert Errors.IdleInsufficient(needed, pulled);
    }

    // ─────────────────────────────────────────────────────────────
    // Pause (Guardian)
    // ─────────────────────────────────────────────────────────────

    /// @notice Pause new deposits / mints. Only Guardian can call.
    /// @dev INVARIANT: pausing does NOT block `withdraw` / `redeem` — users can always exit
    ///      (CLAUDE.md §2.4). Designed so a compromised strategy / vault config can stop
    ///      attack inflow without trapping legitimate user funds.
    function pause() external onlyGuardian { _pause(); }

    /// @notice Resume deposits after a pause. Only Owner can call (intentionally not Guardian —
    ///         Owner is the Multi-sig with higher coordination cost, preventing
    ///         single-key un-pause after an emergency).
    function unpause() external onlyOwner { _unpause(); }

    // ─────────────────────────────────────────────────────────────
    // Ownership (V2.1 — Soken F-06 remediation)
    // ─────────────────────────────────────────────────────────────

    /// @notice Disabled — an immutable yield vault must never be ownerless.
    /// @dev Soken F-06: stock `Ownable.renounceOwnership()` would permanently freeze
    ///      every privileged setter, including `unpause()`, with no on-chain recovery.
    ///      Ownership transfer uses the inherited two-step `Ownable2Step` flow
    ///      (`transferOwnership` → `acceptOwnership`), which protects against
    ///      mistyped destinations by requiring the new owner to actively accept.
    function renounceOwnership() public view override onlyOwner {
        revert("Ownable2Step: renounceOwnership disabled");
    }

    // ─────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────

    /// @notice Total count of registered strategies (active + blacklisted + removed).
    /// @dev Array length only — removed entries are NOT array-spliced (marked inactive instead).
    function strategyCount() external view returns (uint256) { return strategyList.length; }

    /// @notice Return the full list of registered strategy addresses (active + blacklisted + removed).
    /// @dev Caller should filter via `strategyInfo(addr).isActive` if only active strategies matter.
    function getStrategies() external view returns (address[] memory) { return strategyList; }
}
