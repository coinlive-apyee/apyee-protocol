// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IStrategy} from "./interfaces/IStrategy.sol";
import {Errors} from "./libraries/Errors.sol";

/// @title Vault
/// @notice ERC-4626 vault that allocates a single underlying asset (USDC) across whitelisted strategies.
/// @dev Immutable — no upgradeable proxy. Critical bugs require V2 redeploy + migration (Yearn/Uniswap pattern).
contract Vault is ERC4626, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────
    // Constants (hardcoded, immutable post-deploy)
    // ─────────────────────────────────────────────────────────────

    /// @notice Maximum performance fee in bps (20%). Cannot be exceeded.
    uint16 public constant MAX_FEE = 2000;

    /// @notice Absolute upper bound for any single strategy's maxAllocationBps (40% of TVL in bps).
    /// @dev Per-strategy cap is set in StrategyInfo.maxAllocationBps and must satisfy
    ///      `targetBps ≤ maxAllocationBps ≤ MAX_ALLOCATION_BPS_ABSOLUTE` (spec 1.20 / 5.7).
    uint16 public constant MAX_ALLOCATION_BPS_ABSOLUTE = 4000;

    /// @notice Recommended minimum idle ratio (10% of TVL in bps). Keeper guideline, NOT enforced
    ///         on-chain — emergency withdrawals must still be able to drain idle to 0.
    uint16 public constant MIN_IDLE_BPS = 1000;

    /// @notice Cooldown after auto-blacklist before re-enabling is allowed.
    uint256 public constant BLACKLIST_COOLDOWN = 72 hours;

    /// @dev ERC-4626 inflation attack mitigation. USDC has 6 decimals → shares = 12 decimals.
    uint8 private constant DECIMALS_OFFSET = 6;

    // ─────────────────────────────────────────────────────────────
    // Roles & Config
    // ─────────────────────────────────────────────────────────────

    /// @notice Address authorized to call harvest() / investToStrategy() / divestFromStrategy() /
    ///         emergencyWithdraw(). Single EOA.
    address public keeper;

    /// @notice Address authorized to call pause(). Single EOA, fast response.
    address public guardian;

    /// @notice Address that receives performance fee shares.
    address public treasury;

    /// @notice Performance fee in basis points (1e4 = 100%). Bounded by MAX_FEE.
    uint16 public feeRate;

    /// @notice Generation identifier hash set at deploy time. Distinguishes dev/prod redeploys
    ///         of identical Solidity source code AT THE BYTECODE LEVEL (immutable values are
    ///         embedded in runtime bytecode → genuinely different bytecode per generation).
    /// @dev `keccak256(abi.encodePacked(versionString))`:
    ///        - keccak256("1.0.0")      = prod
    ///        - keccak256("1.0.0-dev")  = dev (mainnet sandbox)
    ///        - keccak256("1.1.0")      = next prod generation
    ///      Backends/frontends compare onchain hash with precomputed keccak hashes to identify
    ///      generation. Hash form chosen over `string public` so etherscan cannot link dev/prod
    ///      via shared bytecode ("Similar Match" elimination).
    bytes32 public immutable VERSION_HASH;

    /// @notice Maximum total assets allowed in the vault. Adjusted per launch stage (1.21).
    uint256 public depositCap;

    /// @notice Default per-user deposit cap (USDC value). Applied when `userCap[user] == 0`.
    /// @dev Free tier — Soft Launch initial 10_000e6 ($10K). Owner adjusts via setDefaultUserCap()
    ///      to expand all users at once. See SPEC 1.21.4.
    uint256 public defaultUserCap;

    /// @notice Per-user override cap (USDC value). 0 = no override, falls back to defaultUserCap.
    /// @dev Pro / Institutional / VIP tiers via setUserCap(user, cap). Backend manages tier policy
    ///      off-chain — contract only enforces the cap value. SPEC 1.21.4.
    mapping(address => uint256) public userCap;

    // ─────────────────────────────────────────────────────────────
    // Strategy registry
    // ─────────────────────────────────────────────────────────────

    struct StrategyInfo {
        uint16 targetBps; // target allocation in bps (must be ≤ maxAllocationBps)
        uint16 maxAllocationBps; // per-strategy hard cap in bps (≤ MAX_ALLOCATION_BPS_ABSOLUTE)
        bool isActive; // currently in rotation
        bool isBlacklisted; // auto-blacklisted by emergencyWithdraw
        uint256 blacklistedAt; // timestamp of blacklist (for cooldown)
    }

    mapping(address => StrategyInfo) public strategyInfo;
    address[] public strategyList;

    /// @notice Last observed `IStrategy.balanceOf()` per strategy.
    /// @dev    Updated on every invest / divest / withdraw / emergency / harvest so that
    ///         `currentBalance - lastRecordedBalance` is the unrealized P&L since last sync.
    ///         Pure share-price model (spec 1.12): only the diff is fee-bearing; principal
    ///         movement (invest/divest) updates the baseline directly so it is not mistaken
    ///         for profit on the next harvest.
    mapping(address => uint256) public lastRecordedBalance;

    // ─────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────

    event KeeperUpdated(address indexed newKeeper);
    event GuardianUpdated(address indexed newGuardian);
    event TreasuryUpdated(address indexed newTreasury);
    event FeeRateUpdated(uint16 newRate);
    event DepositCapUpdated(uint256 newCap);

    event StrategyAdded(address indexed strategy, uint16 targetBps, uint16 maxAllocationBps);
    event StrategyRemoved(address indexed strategy);
    event StrategyMaxAllocationUpdated(address indexed strategy, uint16 newMaxAllocationBps);
    event StrategyBlacklisted(address indexed strategy, string reason);
    event StrategyUnblacklisted(address indexed strategy);

    event Harvested(uint256 totalProfit, uint256 feeShares);
    event EmergencyWithdrawal(address indexed strategy, uint256 amount, string reason);

    event InvestedToStrategy(address indexed strategy, uint256 amount);
    event DivestedFromStrategy(address indexed strategy, uint256 requested, uint256 withdrawn);

    event DefaultUserCapUpdated(uint256 newCap);
    event UserCapUpdated(address indexed user, uint256 cap);

    // ─────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert Errors.NotKeeper();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert Errors.NotGuardian();
        _;
    }

    // ─────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────

    /// @param asset_           Underlying token (USDC).
    /// @param name_            Vault token name (e.g. "Apyee USDC Vault").
    /// @param symbol_          Vault token symbol (e.g. "apUSDC").
    /// @param owner_           Initial owner — should be transferred to Gnosis Safe Multi-sig immediately after deploy.
    /// @param keeper_          Initial Keeper EOA.
    /// @param guardian_        Initial Guardian EOA.
    /// @param treasury_        Initial Treasury address (receives fee shares).
    /// @param feeRate_         Initial performance fee in bps. Must be ≤ MAX_FEE.
    /// @param depositCap_      Initial vault total deposit cap. Soft Launch = 10_000e6 USDC (1.21.4).
    /// @param defaultUserCap_  Initial per-user deposit cap (Free tier). Soft Launch = 10_000e6 USDC (1.21.4).
    /// @param versionHash_     Generation hash: keccak256("1.0.0") for prod, keccak256("1.0.0-dev") for dev.
    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        address owner_,
        address keeper_,
        address guardian_,
        address treasury_,
        uint16 feeRate_,
        uint256 depositCap_,
        uint256 defaultUserCap_,
        bytes32 versionHash_
    ) ERC4626(asset_) ERC20(name_, symbol_) Ownable(owner_) {
        if (owner_ == address(0)) revert Errors.ZeroAddress();
        if (keeper_ == address(0)) revert Errors.ZeroAddress();
        if (guardian_ == address(0)) revert Errors.ZeroAddress();
        if (treasury_ == address(0)) revert Errors.ZeroAddress();
        if (feeRate_ > MAX_FEE) revert Errors.FeeTooHigh(feeRate_, MAX_FEE);
        if (versionHash_ == bytes32(0)) revert Errors.ZeroAmount();

        keeper = keeper_;
        guardian = guardian_;
        treasury = treasury_;
        feeRate = feeRate_;
        depositCap = depositCap_;
        defaultUserCap = defaultUserCap_;
        VERSION_HASH = versionHash_;

        emit KeeperUpdated(keeper_);
        emit GuardianUpdated(guardian_);
        emit TreasuryUpdated(treasury_);
        emit FeeRateUpdated(feeRate_);
        emit DepositCapUpdated(depositCap_);
        emit DefaultUserCapUpdated(defaultUserCap_);
    }

    // ─────────────────────────────────────────────────────────────
    // ERC-4626 overrides
    // ─────────────────────────────────────────────────────────────

    /// @inheritdoc ERC4626
    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }

    /// @notice Total assets = idle balance held by the vault + sum of all active strategies' balances.
    function totalAssets() public view override returns (uint256 total) {
        total = IERC20(asset()).balanceOf(address(this));
        uint256 length = strategyList.length;
        for (uint256 i = 0; i < length; ++i) {
            address strat = strategyList[i];
            if (strategyInfo[strat].isActive) {
                total += IStrategy(strat).balanceOf();
            }
        }
    }

    /// @inheritdoc ERC4626
    function maxDeposit(address receiver) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 ta = totalAssets();
        if (ta >= depositCap) return 0;
        uint256 vaultRemaining = depositCap - ta;

        uint256 cap = _effectiveUserCap(receiver);
        uint256 currentValue = convertToAssets(balanceOf(receiver));
        uint256 userRemaining = cap > currentValue ? cap - currentValue : 0;

        return vaultRemaining < userRemaining ? vaultRemaining : userRemaining;
    }

    /// @inheritdoc ERC4626
    function maxMint(address receiver) public view override returns (uint256) {
        return convertToShares(maxDeposit(receiver));
    }

    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        // Check per-user cap first (clearer UX error — user knows it's their own cap).
        _enforcePerUserCap(receiver, assets);
        uint256 ta = totalAssets();
        if (ta + assets > depositCap) revert Errors.DepositCapReached(ta + assets, depositCap);
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        uint256 assets = previewMint(shares);
        _enforcePerUserCap(receiver, assets);
        uint256 ta = totalAssets();
        if (ta + assets > depositCap) revert Errors.DepositCapReached(ta + assets, depositCap);
        return super.mint(shares, receiver);
    }

    /// @dev Returns the effective per-user cap: override if set (> 0), otherwise default.
    function _effectiveUserCap(address user) internal view returns (uint256) {
        uint256 override_ = userCap[user];
        return override_ > 0 ? override_ : defaultUserCap;
    }

    /// @dev Reverts if `receiver` current USDC value + new `assets` exceeds their effective cap.
    ///      Yield-driven growth above the cap is OK (already-deposited principal); only further
    ///      deposits are blocked. Transfer-in of shares from another address bypasses this check
    ///      (deposit-time only) — accepted edge case (ERC-20 transfer hook gas cost not justified).
    function _enforcePerUserCap(address receiver, uint256 assets) internal view {
        uint256 cap = _effectiveUserCap(receiver);
        uint256 currentValue = convertToAssets(balanceOf(receiver));
        uint256 attempted = currentValue + assets;
        if (attempted > cap) revert Errors.UserCapExceeded(cap, attempted);
    }

    /// @notice Withdraw assets — always available, even when paused (CLAUDE.md 2.4).
    /// @dev Auto-pulls from strategies if idle balance is insufficient (Pattern B).
    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256)
    {
        _pullFromStrategies(assets);
        return super.withdraw(assets, receiver, owner_);
    }

    /// @notice Redeem shares — always available, even when paused.
    /// @dev Auto-pulls from strategies if idle balance is insufficient (Pattern B).
    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256)
    {
        _pullFromStrategies(previewRedeem(shares));
        return super.redeem(shares, receiver, owner_);
    }

    /// @dev Pull funds from active strategies to satisfy `assets` worth of withdrawals.
    ///      Iterates strategyList in order; skips inactive/blacklisted/empty entries.
    ///      If after iteration the idle balance is still insufficient, super.withdraw will
    ///      revert in the underlying transfer step (vault is illiquid — emergency state).
    function _pullFromStrategies(uint256 assets) internal {
        address vaultAsset = asset();
        uint256 idle = IERC20(vaultAsset).balanceOf(address(this));
        if (idle >= assets) return;

        uint256 needed = assets - idle;
        uint256 length = strategyList.length;

        for (uint256 i = 0; i < length && needed > 0; ++i) {
            address strat = strategyList[i];
            if (!strategyInfo[strat].isActive) continue;

            uint256 stratBal = IStrategy(strat).balanceOf();
            if (stratBal == 0) continue;

            uint256 pull = needed > stratBal ? stratBal : needed;
            uint256 withdrawn = IStrategy(strat).withdraw(pull);

            // Principal pull — drop baseline by actual amount returned.
            uint256 lastBal = lastRecordedBalance[strat];
            lastRecordedBalance[strat] = withdrawn >= lastBal ? 0 : lastBal - withdrawn;

            if (withdrawn >= needed) {
                needed = 0;
                break;
            }
            unchecked {
                needed -= withdrawn;
            }
        }
        // If `needed > 0` here, super.withdraw's underlying safeTransfer will revert
        // with ERC20InsufficientBalance — vault cannot satisfy the withdrawal.
    }

    // ─────────────────────────────────────────────────────────────
    // Owner config (Multi-sig)
    // ─────────────────────────────────────────────────────────────

    function setKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) revert Errors.ZeroAddress();
        keeper = newKeeper;
        emit KeeperUpdated(newKeeper);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert Errors.ZeroAddress();
        guardian = newGuardian;
        emit GuardianUpdated(newGuardian);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert Errors.ZeroAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function setFeeRate(uint16 newRate) external onlyOwner {
        if (newRate > MAX_FEE) revert Errors.FeeTooHigh(newRate, MAX_FEE);
        feeRate = newRate;
        emit FeeRateUpdated(newRate);
    }

    /// @notice Vault total deposit cap. Soft Launch 10_000e6 → Public 100_000e6 → Public+ unbounded (1.21.4).
    function setDepositCap(uint256 newCap) external onlyOwner {
        depositCap = newCap;
        emit DepositCapUpdated(newCap);
    }

    /// @notice Default per-user deposit cap (Free tier). Backend manages tier policy off-chain
    ///         and calls setUserCap() for individual overrides (Pro/Institutional/VIP).
    /// @dev Setting to 0 effectively blocks all default-tier deposits (intentional emergency lever).
    function setDefaultUserCap(uint256 newCap) external onlyOwner {
        defaultUserCap = newCap;
        emit DefaultUserCapUpdated(newCap);
    }

    /// @notice Per-user override cap. `cap = 0` removes the override (falls back to defaultUserCap).
    /// @dev Free → Pro upgrade: setUserCap(user, 100_000e6). Pro → Free downgrade: setUserCap(user, 0).
    ///      Owner-only by design. Phase 2 may delegate to a pricingManager hot wallet for Pro scale.
    function setUserCap(address user, uint256 cap) external onlyOwner {
        if (user == address(0)) revert Errors.ZeroAddress();
        userCap[user] = cap;
        emit UserCapUpdated(user, cap);
    }

    // ─────────────────────────────────────────────────────────────
    // Strategy management (Owner)
    // ─────────────────────────────────────────────────────────────

    /// @notice Add a new strategy with its own allocation cap.
    /// @param strategy           Strategy adapter address.
    /// @param targetBps          Initial target allocation (Keeper attempts to maintain this).
    /// @param maxAllocationBps_  Hard cap for this strategy (e.g. Aave 4000 / Compound 3500 / new 2000).
    ///                           Must satisfy `targetBps ≤ maxAllocationBps_ ≤ MAX_ALLOCATION_BPS_ABSOLUTE`.
    function addStrategy(address strategy, uint16 targetBps, uint16 maxAllocationBps_)
        external
        onlyOwner
    {
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

    /// @notice Update a strategy's per-strategy allocation cap.
    /// @dev Useful when a protocol's risk profile changes (e.g. Compound recently audited → raise cap).
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

    /// @notice Remove a strategy. Must have zero balance — drain via emergencyWithdraw or rebalance first.
    function removeStrategy(address strategy) external onlyOwner {
        StrategyInfo storage info = strategyInfo[strategy];
        if (!info.isActive && !info.isBlacklisted) revert Errors.StrategyNotWhitelisted(strategy);

        uint256 bal = IStrategy(strategy).balanceOf();
        if (bal > 0) revert Errors.StrategyHasBalance(strategy, bal);

        info.isActive = false;
        info.isBlacklisted = false;
        info.targetBps = 0;
        // strategyList not pruned — isActive flag handles iteration filtering.
        emit StrategyRemoved(strategy);
    }

    /// @notice Re-enable a previously auto-blacklisted strategy. Subject to BLACKLIST_COOLDOWN (72h).
    function unblacklistStrategy(address strategy) external onlyOwner {
        StrategyInfo storage info = strategyInfo[strategy];
        if (!info.isBlacklisted) revert Errors.StrategyNotWhitelisted(strategy);

        uint256 elapsed = block.timestamp - info.blacklistedAt;
        if (elapsed < BLACKLIST_COOLDOWN) {
            revert Errors.BlacklistCooldownActive(BLACKLIST_COOLDOWN - elapsed);
        }
        info.isBlacklisted = false;
        info.isActive = true;
        info.blacklistedAt = 0;
        emit StrategyUnblacklisted(strategy);
    }

    function strategyCount() external view returns (uint256) {
        return strategyList.length;
    }

    // ─────────────────────────────────────────────────────────────
    // Pause (Guardian pauses, Owner unpauses)
    // ─────────────────────────────────────────────────────────────

    function pause() external onlyGuardian {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─────────────────────────────────────────────────────────────
    // Liquidity routing (Keeper) — Pattern B: explicit invest, auto-pull on withdraw
    // ─────────────────────────────────────────────────────────────

    /// @notice Push idle USDC from the vault into an active strategy.
    /// @dev Resulting strategy balance must not exceed this strategy's per-strategy cap
    ///      (`StrategyInfo.maxAllocationBps`, capped above by MAX_ALLOCATION_BPS_ABSOLUTE = 40%).
    function investToStrategy(address strategy, uint256 amount) external onlyKeeper nonReentrant {
        _investToStrategy(strategy, amount);
    }

    /// @notice Pull funds from a strategy back to the vault's idle balance.
    /// @dev Allowed for both active and blacklisted strategies (drain after blacklist).
    function divestFromStrategy(address strategy, uint256 amount) external onlyKeeper nonReentrant {
        _divestFromStrategy(strategy, amount);
    }

    /// @dev Internal core. Called by externals (with nonReentrant) and by `rebalance`
    ///      (already nonReentrant at the entrypoint).
    function _investToStrategy(address strategy, uint256 amount) internal {
        StrategyInfo storage info = strategyInfo[strategy];
        if (!info.isActive) revert Errors.StrategyNotWhitelisted(strategy);
        if (amount == 0) revert Errors.ZeroAmount();

        IERC20 vaultAsset = IERC20(asset());
        uint256 idle = vaultAsset.balanceOf(address(this));
        if (idle < amount) revert Errors.IdleInsufficient(amount, idle);

        uint256 ta = totalAssets();
        uint256 maxStratAlloc = (ta * info.maxAllocationBps) / 10000;
        uint256 newStratBal = IStrategy(strategy).balanceOf() + amount;
        if (newStratBal > maxStratAlloc) {
            revert Errors.AllocationExceeded(newStratBal, maxStratAlloc);
        }

        vaultAsset.forceApprove(strategy, amount);
        IStrategy(strategy).deposit(amount);

        // Principal movement, not profit — bump baseline so the next harvest doesn't
        // count this deposit as fee-bearing P&L.
        lastRecordedBalance[strategy] += amount;

        emit InvestedToStrategy(strategy, amount);
    }

    /// @dev Internal core. Returns actual amount returned to the vault (may be < requested).
    function _divestFromStrategy(address strategy, uint256 amount)
        internal
        returns (uint256 withdrawn)
    {
        StrategyInfo storage info = strategyInfo[strategy];
        if (!info.isActive && !info.isBlacklisted) revert Errors.StrategyNotWhitelisted(strategy);
        if (amount == 0) revert Errors.ZeroAmount();

        withdrawn = IStrategy(strategy).withdraw(amount);

        // Principal pull, not loss — drop baseline by the actual amount returned.
        uint256 lastBal = lastRecordedBalance[strategy];
        lastRecordedBalance[strategy] = withdrawn >= lastBal ? 0 : lastBal - withdrawn;

        emit DivestedFromStrategy(strategy, amount, withdrawn);
    }

    // ─────────────────────────────────────────────────────────────
    // Keeper actions (logic stubs — implemented in subsequent commits)
    // ─────────────────────────────────────────────────────────────

    /// @notice Collect profits from all active strategies and mint fee shares to Treasury.
    /// @dev Pure share-price model (spec 1.12). Strategy funds are NOT moved here — Aave/Compound/Morpho
    ///      auto-accrue interest into `balanceOf()`, so `currentBal - lastRecordedBalance` is the
    ///      unrealized P&L since last sync. We simply mint `feeShares = convertToShares(profit * feeRate)`
    ///      to the Treasury, which dilutes share value just enough to capture the fee.
    ///
    ///      Loss handling: if `currentBal ≤ lastBal`, no fee. Baseline is still updated to
    ///      `currentBal` so the next recovery isn't double-counted as profit.
    ///
    ///      Dynamic harvest threshold (expectedFee > gasCost × 3, CLAUDE.md 2.6) is enforced
    ///      off-chain by the Keeper before calling this — the contract itself does not gate.
    function harvest() external onlyKeeper nonReentrant {
        uint256 totalProfit = 0;
        uint256 length = strategyList.length;

        for (uint256 i = 0; i < length; ++i) {
            address strat = strategyList[i];
            if (!strategyInfo[strat].isActive) continue;

            uint256 currentBal = IStrategy(strat).balanceOf();
            uint256 lastBal = lastRecordedBalance[strat];

            if (currentBal > lastBal) {
                unchecked {
                    totalProfit += currentBal - lastBal;
                }
            }
            // Always sync baseline — a recovered loss should not become "profit".
            lastRecordedBalance[strat] = currentBal;
        }

        if (totalProfit == 0) {
            emit Harvested(0, 0);
            return;
        }

        uint256 feeAssets = (totalProfit * feeRate) / 10000;
        uint256 feeShares = feeAssets == 0 ? 0 : convertToShares(feeAssets);

        if (feeShares > 0) {
            _mint(treasury, feeShares);
        }

        emit Harvested(totalProfit, feeShares);
    }

    /// @notice Emergency withdraw from a strategy and auto-blacklist it.
    /// @dev Triggered on critical signals (depeg, util 75%+, TVL drop, pause event — spec 1.20).
    function emergencyWithdraw(address strategy, string calldata reason)
        external
        onlyKeeper
        nonReentrant
    {
        StrategyInfo storage info = strategyInfo[strategy];
        if (!info.isActive) revert Errors.StrategyNotWhitelisted(strategy);

        uint256 withdrawn = IStrategy(strategy).emergencyWithdraw();

        info.isActive = false;
        info.isBlacklisted = true;
        info.blacklistedAt = block.timestamp;

        // Strategy fully drained — reset baseline.
        lastRecordedBalance[strategy] = 0;

        emit EmergencyWithdrawal(strategy, withdrawn, reason);
        emit StrategyBlacklisted(strategy, reason);
    }
}
