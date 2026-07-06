// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IStrategy} from "../interfaces/IStrategy.sol";
import {Errors} from "../libraries/Errors.sol";
import {ISwapRouter} from "../interfaces/external/ISwapRouter.sol";
import {IChainlinkAggregator} from "../interfaces/external/IChainlinkAggregator.sol";

/// @dev Minimal Vault surface used by BaseStrategy to read the current Keeper EOA for
///      `onlyKeeper` gating on `claimAndCompound`. Reading dynamically (vs. caching an
///      immutable) lets the Vault Owner rotate the Keeper without redeploying every
///      strategy.
interface IVaultKeeperView {
    function keeper() external view returns (address);
}

/// @dev Minimal Vault surface for V2.1.2 Owner-gated setters. Dynamic read supports the
///      Vault's Ownable2Step transferOwnership flow (F-06) — new Owner acquires all
///      strategy-side Owner privileges immediately after `acceptOwnership`.
interface IVaultOwnerView {
    function owner() external view returns (address);
}

/// @dev V2.1.2 (Soken N-02): minimal Vault surface for the pause propagation. When
///      Guardian pauses the Vault, all Keeper fund-moving strategy actions must halt.
interface IVaultPausedView {
    function paused() external view returns (bool);
}

/// @title BaseStrategy
/// @notice Abstract base for protocol-specific yield strategies (Aave, Compound, Morpho, ...).
/// @dev Concrete adapters override the internal `_deposit` / `_withdraw` / `_emergencyWithdraw` /
///      `balanceOf` / `currentAPY` / `harvestable` hooks. This base handles:
///        - access control (onlyVault on every fund-moving entrypoint)
///        - asset / vault immutables (cannot be reassigned post-deploy)
///        - SafeERC20 transfers between Vault and Strategy
///        - ReentrancyGuard on all state-changing externals
///        - zero-amount short-circuit
abstract contract BaseStrategy is IStrategy, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Generation identifier hash set at deploy time. Same convention as Vault.VERSION_HASH
    ///         but distinct name to avoid selector collision when read via same indexer/UI.
    /// @dev `keccak256(abi.encodePacked(versionString))` — immutable bytecode-embedded for
    ///      genuine bytecode separation between dev/prod (etherscan "Similar Match" elimination).
    bytes32 public immutable STRATEGY_VERSION_HASH;

    /// @notice Underlying token (must equal Vault.asset()).
    IERC20 public immutable underlyingAsset;

    /// @notice Vault that owns this strategy. Only this address can move funds.
    address public immutable override vault;

    /// @notice V2.1 (Soken F-04): DEX router used by `claimAndCompound` to swap claimed
    ///         reward tokens into the underlying asset before re-depositing into the
    ///         same external protocol. UniswapV3 `SwapRouter02` shape on ETH/Base/Arb,
    ///         PancakeV3 `SmartRouter` on BSC (both UniV3-fork compatible).
    /// @dev    Pinned at constructor time, immutable. To change the DEX, redeploy the
    ///         strategy and re-whitelist via Vault.
    ISwapRouter public immutable dexRouter;

    /// @notice V2.1.2 (Soken constructor guard): the `block.chainid` captured at
    ///         deployment time. Every fund-moving external checks this against the
    ///         current `block.chainid` and reverts on mismatch — blocks replay on
    ///         forked / wrong chains. Public so indexers / dashboards can surface
    ///         the intended chain of each strategy contract.
    uint256 public immutable DEPLOY_CHAIN_ID;

    // ─────────────────────────────────────────────────────────────
    // V2.1.2 (Soken F-04-MEV.1) — on-chain minOut floor
    // ─────────────────────────────────────────────────────────────

    /// @notice Default per-token max slippage (5%) used when the Owner has not set an
    ///         override via `setRewardMaxSlippage`.
    uint16 public constant DEFAULT_MAX_SLIPPAGE_BPS = 500;

    /// @notice Hard ceiling on `rewardMaxSlippageBps` — Owner cannot loosen slippage
    ///         beyond 10% even for illiquid reward tokens.
    uint16 public constant MAX_SLIPPAGE_BPS_CAP = 1_000;

    /// @notice Chainlink `updatedAt` must be within this window from `block.timestamp`.
    ///         1 day matches most Chainlink heartbeat SLAs plus a safety margin.
    uint256 public constant PRICE_STALENESS = 1 days;

    /// @notice Optional Chainlink USD price feed per reward token. When set, the feed
    ///         is preferred over the Owner-set fallback price. Feed address(0) = unset.
    mapping(address => IChainlinkAggregator) public rewardPriceFeed;

    /// @notice Owner-set fallback USD price per reward token, scaled by 1e8
    ///         (Chainlink convention). Used when a Chainlink feed is unavailable
    ///         (e.g. FLUID, KINZA, SPK on some chains). Owner is expected to update
    ///         this value periodically via `setRewardFallbackPrice`.
    mapping(address => uint256) public rewardFallbackPriceE8;

    /// @notice Per-reward-token max slippage in bps. 0 = use `DEFAULT_MAX_SLIPPAGE_BPS`.
    mapping(address => uint16) public rewardMaxSlippageBps;

    /// @notice V2.1.2 (Soken N-01 / N-SP-01 / F-04-MEV.2): Owner-managed whitelist of
    ///         tokens that may appear as intermediate hops in the UniV3 multi-hop swap
    ///         path. Endpoint tokens (rewardToken, underlyingAsset) are already bound by
    ///         `_validateSwapPath`. Typical entries: WETH, WBTC, USDT, DAI on each chain.
    ///         Empty by default — Owner must whitelist before the first multi-hop claim.
    mapping(address => bool) public allowedHopToken;

    // V2.1.2 events — indexable audit trail of Owner-set price / slippage config.
    event RewardPriceFeedSet(address indexed rewardToken, address indexed feed);
    event RewardFallbackPriceSet(address indexed rewardToken, uint256 priceE8);
    event RewardMaxSlippageSet(address indexed rewardToken, uint16 slippageBps);
    event AllowedHopTokenSet(address indexed hopToken, bool allowed);
    event IdleAssetSwept(uint256 amount);

    /// @notice V2.1.2 (Soken constructor guard): emitted once at deploy time with the
    ///         router address, its bytecode length, and the pinned chain id. Lets
    ///         indexers and audit tooling verify each production strategy points at
    ///         the intended router on the intended chain without decoding constructor
    ///         calldata.
    event DexRouterConfigured(address indexed dexRouter, uint256 chainId, uint256 dexRouterCodeSize);

    // ─────────────────────────────────────────────────────────────
    // Events (state-changing entrypoints)
    // ─────────────────────────────────────────────────────────────

    event Deposited(uint256 amount);
    event Withdrawn(uint256 requested, uint256 withdrawn);
    event EmergencyWithdrawn(uint256 withdrawn);

    /// @notice V2.1 (Soken F-04): emitted by `_swapAndReinvest` after a successful
    ///         reward → underlying swap + re-deposit into the external protocol. The
    ///         resulting `balanceOf()` growth flows into Vault.totalAssets() and the
    ///         streaming fee accrues 15% of the gain to the Treasury on the next user
    ///         action (no separate fee handling here).
    event RewardsCompounded(
        address indexed rewardToken,
        uint256 rewardAmountIn,
        uint256 underlyingAmountOut
    );

    // ─────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────

    modifier onlyVault() {
        if (msg.sender != vault) revert Errors.NotVault();
        _;
    }

    /// @dev V2.1 (Soken F-04): gates `claimAndCompound` on the Vault's current Keeper.
    ///      Read dynamically (not cached) so the Vault Owner can rotate the Keeper EOA
    ///      via `setKeeper` without redeploying any strategy.
    modifier onlyKeeper() {
        if (msg.sender != IVaultKeeperView(vault).keeper()) revert Errors.NotKeeper();
        _;
    }

    /// @dev V2.1.2: gates Owner-only setters (price feed / fallback / slippage) on the
    ///      Vault's current Owner. Dynamic read so Ownable2Step transfer auto-propagates
    ///      to strategy-side privileges without a redeploy.
    modifier onlyVaultOwner() {
        if (msg.sender != IVaultOwnerView(vault).owner()) revert Errors.NotOwner();
        _;
    }

    /// @dev V2.1.2 (Soken N-02): halts Keeper fund-moving strategy actions while the
    ///      Vault is paused. Applied to `claimAndCompound` on each concrete strategy.
    ///      User withdraw remains unaffected (Vault re-declares it pause-free).
    modifier whenVaultNotPaused() {
        if (IVaultPausedView(vault).paused()) revert Errors.VaultPaused();
        _;
    }

    /// @dev V2.1.2 (Soken constructor guard): rejects any fund-moving call executed on
    ///      a chain other than the one the strategy was deployed on. Cheap check
    ///      (`CHAINID` opcode + immutable compare). Prevents replay of same-bytecode
    ///      deployments across chain forks (e.g. a minority fork where the DEX router
    ///      address exists but points to a different contract).
    modifier onlyDeployChain() {
        if (block.chainid != DEPLOY_CHAIN_ID) {
            revert Errors.WrongChain(DEPLOY_CHAIN_ID, block.chainid);
        }
        _;
    }

    // ─────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────

    /// @param vault_               Vault address that will own and route funds through this strategy.
    /// @param asset_               Underlying ERC-20 token (USDC). Must match the Vault's asset.
    /// @param dexRouter_           V2.1 — UniswapV3 `SwapRouter02` / PancakeV3 `SmartRouter` used by
    ///                             `_swapAndReinvest` (Soken F-04). Pass `address(0)` to disable
    ///                             reward compounding on this strategy instance — `claimAndCompound`
    ///                             will then revert if a child contract calls `_swapAndReinvest`.
    /// @param strategyVersionHash_ Generation hash: keccak256("1.0.0") prod / keccak256("1.0.0-dev") dev.
    constructor(address vault_, address asset_, address dexRouter_, bytes32 strategyVersionHash_) {
        if (vault_ == address(0)) revert Errors.ZeroAddress();
        if (asset_ == address(0)) revert Errors.ZeroAddress();
        if (strategyVersionHash_ == bytes32(0)) revert Errors.ZeroAmount();

        // V2.1.2 (Soken constructor guard): if the deployer opts in to compounding
        // (dexRouter_ != 0), verify the address actually has bytecode. Catches the
        // common misconfiguration of pasting an EOA (e.g. deployer key by mistake) or
        // a stale address whose contract self-destructed pre-Cancun. `address(0)` is
        // still accepted as the explicit "no compounding" signal — `_swapAndReinvest`
        // reverts when called on such a strategy.
        if (dexRouter_ != address(0)) {
            uint256 codeSize;
            assembly {
                codeSize := extcodesize(dexRouter_)
            }
            if (codeSize == 0) revert Errors.DexRouterNotContract(dexRouter_);
        }

        vault = vault_;
        underlyingAsset = IERC20(asset_);
        dexRouter = ISwapRouter(dexRouter_);
        STRATEGY_VERSION_HASH = strategyVersionHash_;

        // V2.1.2 (Soken constructor guard): pin the deploy chain so a same-bytecode
        // replay on a fork or wrong chain is rejected by `onlyDeployChain`.
        DEPLOY_CHAIN_ID = block.chainid;

        // Constructor-time audit trail — indexer-visible without ABI-decoding calldata.
        uint256 emittedCodeSize;
        if (dexRouter_ != address(0)) {
            assembly {
                emittedCodeSize := extcodesize(dexRouter_)
            }
        }
        emit DexRouterConfigured(dexRouter_, block.chainid, emittedCodeSize);
    }

    // ─────────────────────────────────────────────────────────────
    // IStrategy — view (concrete defaults; child can override)
    // ─────────────────────────────────────────────────────────────

    /// @inheritdoc IStrategy
    function asset() external view override returns (address) {
        return address(underlyingAsset);
    }

    /// @inheritdoc IStrategy
    /// @dev Default = 0 (instant exit). Override for protocols with cooldown / unstaking delay.
    function withdrawalDelay() external view virtual override returns (uint256) {
        return 0;
    }

    // ─────────────────────────────────────────────────────────────
    // IStrategy — view (must be implemented by concrete strategy)
    // ─────────────────────────────────────────────────────────────

    /// @inheritdoc IStrategy
    function balanceOf() external view virtual override returns (uint256);

    /// @inheritdoc IStrategy
    function currentAPY() external view virtual override returns (uint256);

    /// @inheritdoc IStrategy
    function harvestable() external view virtual override returns (uint256);

    // ─────────────────────────────────────────────────────────────
    // IStrategy — external (uniform guards + SafeERC20 + delegate to internal hooks)
    // ─────────────────────────────────────────────────────────────

    /// @inheritdoc IStrategy
    /// @dev Vault must have approved this strategy for `amount` of the underlying asset.
    function deposit(uint256 amount) external override onlyVault onlyDeployChain nonReentrant {
        if (amount == 0) revert Errors.ZeroAmount();
        underlyingAsset.safeTransferFrom(vault, address(this), amount);
        _deposit(amount);
        emit Deposited(amount);
    }

    /// @inheritdoc IStrategy
    function withdraw(uint256 amount)
        external
        override
        onlyVault
        onlyDeployChain
        nonReentrant
        returns (uint256 withdrawn)
    {
        if (amount == 0) revert Errors.ZeroAmount();
        withdrawn = _withdraw(amount);
        if (withdrawn > 0) {
            underlyingAsset.safeTransfer(vault, withdrawn);
        }
        emit Withdrawn(amount, withdrawn);
    }

    /// @inheritdoc IStrategy
    /// @dev Pulls everything possible without reverting on partial liquidity. Vault auto-blacklists
    ///      this strategy after a successful emergency exit.
    function emergencyWithdraw()
        external
        override
        onlyVault
        onlyDeployChain
        nonReentrant
        returns (uint256 withdrawn)
    {
        withdrawn = _emergencyWithdraw();
        if (withdrawn > 0) {
            underlyingAsset.safeTransfer(vault, withdrawn);
        }
        emit EmergencyWithdrawn(withdrawn);
    }

    // ─────────────────────────────────────────────────────────────
    // Internal hooks (concrete strategy implements protocol-specific calls)
    // ─────────────────────────────────────────────────────────────

    /// @dev Move `amount` from this strategy's balance into the external protocol (e.g. Aave supply).
    ///      Asset has already been pulled from the Vault before this is called.
    function _deposit(uint256 amount) internal virtual;

    /// @dev Pull at most `amount` from the external protocol back to this strategy.
    ///      Returns the actual amount pulled (may be less due to rounding or available liquidity).
    ///      The base then forwards the funds to the Vault.
    function _withdraw(uint256 amount) internal virtual returns (uint256 withdrawn);

    /// @dev Pull as much as possible without reverting. Used during emergency exits.
    ///      Returns the actual amount pulled. Base forwards to Vault.
    function _emergencyWithdraw() internal virtual returns (uint256 withdrawn);

    // ─────────────────────────────────────────────────────────────
    // V2.1.2 — Owner-set price config (Soken F-04-MEV.1 mitigation)
    // ─────────────────────────────────────────────────────────────

    /// @notice Configure the Chainlink USD price feed for a reward token. Passing
    ///         `address(0)` clears the feed (the strategy will then fall back to the
    ///         Owner-set fallback price, if any).
    /// @dev    Owner is expected to point at the canonical Chainlink aggregator for
    ///         (reward, USD) on this chain, e.g. `COMP/USD` on Ethereum. Feed decimals
    ///         are read at call time from `feed.decimals()`.
    function setRewardPriceFeed(address rewardToken, address feed)
        external
        onlyVaultOwner
    {
        if (rewardToken == address(0)) revert Errors.ZeroAddress();
        rewardPriceFeed[rewardToken] = IChainlinkAggregator(feed);
        emit RewardPriceFeedSet(rewardToken, feed);
    }

    /// @notice Owner-set fallback USD price (× 1e8) for a reward token without a
    ///         Chainlink feed. Passing 0 clears the fallback.
    /// @dev    Reward tokens like FLUID, KINZA, SPK often lack Chainlink coverage. The
    ///         Owner is expected to update this price periodically (weekly EMA or on
    ///         significant deviation). Trust surface: this value is not on-chain-
    ///         attested; a malicious Owner could inflate it to disable the floor. That
    ///         sits within the existing Owner-trust model (see docs/TRUST_MODEL.md).
    function setRewardFallbackPrice(address rewardToken, uint256 priceE8)
        external
        onlyVaultOwner
    {
        if (rewardToken == address(0)) revert Errors.ZeroAddress();
        rewardFallbackPriceE8[rewardToken] = priceE8;
        emit RewardFallbackPriceSet(rewardToken, priceE8);
    }

    /// @notice Owner-set per-token max slippage (bps). Passing 0 restores the default
    ///         (`DEFAULT_MAX_SLIPPAGE_BPS` = 500 = 5%). Capped at `MAX_SLIPPAGE_BPS_CAP`.
    function setRewardMaxSlippage(address rewardToken, uint16 slippageBps)
        external
        onlyVaultOwner
    {
        if (rewardToken == address(0)) revert Errors.ZeroAddress();
        if (slippageBps > MAX_SLIPPAGE_BPS_CAP) {
            revert Errors.FeeTooHigh(slippageBps, MAX_SLIPPAGE_BPS_CAP);
        }
        rewardMaxSlippageBps[rewardToken] = slippageBps;
        emit RewardMaxSlippageSet(rewardToken, slippageBps);
    }

    /// @notice Whitelist / de-whitelist a token as an allowed intermediate hop for
    ///         the UniV3 multi-hop swap path. Endpoint tokens are already bound and
    ///         are NOT gated here. Typical whitelist: WETH, WBTC, USDT, DAI, and any
    ///         high-liquidity venue token the Owner has vetted for this chain.
    /// @dev    Soken N-01 / N-SP-01 / F-04-MEV.2. The check runs on every
    ///         `_validateSwapPath` invocation, so a de-whitelist takes effect
    ///         immediately on the next claim.
    function setAllowedHopToken(address hopToken, bool allowed)
        external
        onlyVaultOwner
    {
        if (hopToken == address(0)) revert Errors.ZeroAddress();
        allowedHopToken[hopToken] = allowed;
        emit AllowedHopTokenSet(hopToken, allowed);
    }

    /// @notice V2.1.2 (Soken): sweep any idle `underlyingAsset` (USDC) sitting on this
    ///         strategy contract back to the Vault. Handles orphaned residue from:
    ///           - partial `_emergencyWithdraw` where the protocol had capped liquidity
    ///           - Keeper mis-order (deposit tx reverted after transferFrom but before
    ///             the external protocol supply call — historically not possible under
    ///             our flow, but this is a belt-and-suspenders rescue)
    ///           - direct ERC-20 transfers to the strategy address by mistake
    /// @dev    Fund-safety invariants preserved:
    ///           - ONLY the `underlyingAsset` (USDC) is sweep-able. Reward tokens,
    ///             aTokens / cTokens / vTokens / fTokens, and any other ERC-20 sitting
    ///             on this strategy remain untouchable by the Owner. This is critical
    ///             — reward tokens flow through `claimAndCompound` only, and protocol
    ///             receipt tokens represent live user positions.
    ///           - Destination is HARD-CODED to `vault`. Owner cannot route funds to
    ///             an external wallet. Consistent with the CLAUDE.md "자금 통제 원칙":
    ///             no primitive that lets Owner exit user funds to an arbitrary address.
    ///         Zero balance is a no-op (returns 0) — not a revert — so a scheduled
    ///         maintenance call is idempotent.
    /// @return swept The USDC amount actually forwarded to the Vault.
    function sweepIdleAssetToVault()
        external
        onlyVaultOwner
        onlyDeployChain
        nonReentrant
        returns (uint256 swept)
    {
        swept = underlyingAsset.balanceOf(address(this));
        if (swept > 0) {
            underlyingAsset.safeTransfer(vault, swept);
        }
        emit IdleAssetSwept(swept);
    }

    /// @dev Compute the on-chain fair-price floor for `minOut` in `_swapAndReinvest`.
    ///      Prefers Chainlink; falls back to Owner-set price; reverts if neither is
    ///      configured (Keeper must wait for Owner to bootstrap the price config
    ///      before the first claim). Applies `maxSlippageBps` (per-token override or
    ///      default 5%) to arrive at the minimum acceptable USDC out.
    /// @param rewardToken  The reward token being swapped.
    /// @param amountIn     Amount of `rewardToken` (in its native decimals) about to be
    ///                     forwarded to the DEX router.
    /// @return minOutFloor Minimum `underlyingAsset` out that the caller MUST supply.
    function _computeMinOutFloor(address rewardToken, uint256 amountIn)
        internal
        view
        returns (uint256 minOutFloor)
    {
        uint256 priceE8;                                // USD price × 1e8
        IChainlinkAggregator feed = rewardPriceFeed[rewardToken];

        if (address(feed) != address(0)) {
            (, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
            if (answer <= 0) revert Errors.InvalidPrice();
            if (block.timestamp - updatedAt > PRICE_STALENESS) {
                revert Errors.PriceFeedStale(updatedAt, block.timestamp);
            }
            uint256 feedDec = feed.decimals();
            // Normalize any feed decimals to 8 (Chainlink convention).
            if (feedDec == 8) {
                priceE8 = uint256(answer);
            } else if (feedDec < 8) {
                priceE8 = uint256(answer) * (10 ** (8 - feedDec));
            } else {
                priceE8 = uint256(answer) / (10 ** (feedDec - 8));
            }
        } else {
            priceE8 = rewardFallbackPriceE8[rewardToken];
            if (priceE8 == 0) revert Errors.MinOutFloorUnconfigured(rewardToken);
        }

        // fairOut = amountIn × priceE8 / 10^rewardDec × 10^underlyingDec / 10^8
        //         = amountIn × priceE8 × 10^underlyingDec / (10^rewardDec × 10^8)
        uint256 rewardDec = IERC20Metadata(rewardToken).decimals();
        uint256 underlyingDec = IERC20Metadata(address(underlyingAsset)).decimals();

        uint256 fairOut = (amountIn * priceE8 * (10 ** underlyingDec))
                            / (10 ** rewardDec)
                            / 1e8;

        uint16 slippage = rewardMaxSlippageBps[rewardToken];
        if (slippage == 0) slippage = DEFAULT_MAX_SLIPPAGE_BPS;

        minOutFloor = (fairOut * (10_000 - slippage)) / 10_000;
    }

    // ─────────────────────────────────────────────────────────────
    // V2.1 — Reward claim + auto-compound helper (Soken F-04)
    // ─────────────────────────────────────────────────────────────

    /// @notice Swap a claimed reward token into the underlying asset via the configured
    ///         DEX router, then re-deposit the proceeds into the same external protocol
    ///         (auto-compound). Concrete adapters call this from their public
    ///         `claimAndCompound(...)` after pulling the reward from the protocol's
    ///         distributor / merkle contract.
    /// @dev    Fund safety:
    ///           - DEX is the constructor-pinned `dexRouter` (UniV3 / PancakeV3). Reverts
    ///             if address(0) was supplied.
    ///           - `recipient` is `address(this)` — output never leaves the strategy.
    ///           - `amountOutMinimum` (`minOut`) is the only slippage guard; the Keeper
    ///             computes it off-chain from a price feed and passes it in.
    ///           - The reward → USDC swap MUST NOT touch the underlying-asset balance
    ///             held by the protocol position (e.g. Aave aToken); we only handle the
    ///             standalone reward token (e.g. COMP, XVS, MORPHO, FLUID, SPK).
    ///         The resulting `balanceOf()` growth flows into Vault.totalAssets() and the
    ///         streaming fee captures the operator's 15% share automatically on the next
    ///         user action — no explicit fee handling here.
    /// @param rewardToken  ERC-20 reward token (e.g. COMP). Must not equal underlyingAsset
    ///                     and must match the FIRST 20 bytes of `swapPath`.
    /// @param swapPath     UniV3 multi-hop path bytes (`token0 || fee0 || token1 || fee1 || ...
    ///                     || tokenN`). Single-hop = 43 bytes (`tokenIn || fee || tokenOut`).
    ///                     Last 20 bytes MUST equal `address(underlyingAsset)` so we can never
    ///                     accidentally swap to a different output token.
    /// @param amountIn     Reward amount to swap. Usually `rewardToken.balanceOf(this)`.
    /// @param minOut       Minimum underlying received (slippage protection).
    /// @return usdcOut     Underlying actually received from the swap (also re-deposited).
    function _swapAndReinvest(
        address rewardToken,
        bytes calldata swapPath,
        uint256 amountIn,
        uint256 minOut
    ) internal returns (uint256 usdcOut) {
        if (amountIn == 0) return 0;

        // V2.1.2 (Soken F-04 follow-up): reward token is the underlying asset — no swap
        // needed. Some distributors pay yield directly in the underlying (Compound V3 has
        // a supply-side USDC accrual path; Aave rewards can be configured to USDC by the
        // Emission Manager). Route straight into `_deposit`, skipping DEX + slippage +
        // path validation. `swapPath` and `minOut` are ignored on this branch.
        if (rewardToken == address(underlyingAsset)) {
            _deposit(amountIn);
            emit RewardsCompounded(rewardToken, amountIn, amountIn);
            return amountIn;
        }

        if (address(dexRouter) == address(0)) revert Errors.ZeroAddress();

        // Layout + endpoint binding — prevents a malicious Keeper from re-routing the
        // swap to a different input or output token.
        _validateSwapPath(rewardToken, swapPath);

        // V2.1.2 (Soken F-04-MEV.1): reject `minOut` below the on-chain fair-price floor
        // so a compromised or misconfigured Keeper cannot let the swap sandwich freely.
        {
            uint256 floor_ = _computeMinOutFloor(rewardToken, amountIn);
            if (minOut < floor_) revert Errors.MinOutBelowFloor(minOut, floor_);
        }

        IERC20(rewardToken).forceApprove(address(dexRouter), amountIn);
        usdcOut = dexRouter.exactInput(
            ISwapRouter.ExactInputParams({
                path: swapPath,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut
            })
        );

        // Re-deposit the proceeds into the same external protocol (auto-compound).
        // Skipped on a zero swap output (router gave us nothing) — avoids a redundant
        // protocol call. The reward balance is now drained so a future claim cycle
        // starts fresh.
        if (usdcOut > 0) {
            _deposit(usdcOut);
        }
        emit RewardsCompounded(rewardToken, amountIn, usdcOut);
    }

    /// @dev Checks the path bytes are well-formed and bound to the right endpoints, and
    ///      each intermediate hop token is Owner-whitelisted.
    ///      Split out of `_swapAndReinvest` so its stack stays shallow enough to compile
    ///      without `viaIR`.
    function _validateSwapPath(address rewardToken, bytes calldata path) private view {
        uint256 pathLen = path.length;
        // Every hop is `address (20B) + fee (3B)`, terminated by the output address —
        // so length must be 20 + N*23 (>= 43 for single-hop).
        if (pathLen < 43 || (pathLen - 20) % 23 != 0) revert Errors.InvalidPath();
        address pathIn;
        address pathOut;
        assembly {
            pathIn  := shr(96, calldataload(path.offset))
            pathOut := shr(96, calldataload(add(path.offset, sub(pathLen, 20))))
        }
        if (pathIn != rewardToken) revert Errors.InvalidPath();
        if (pathOut != address(underlyingAsset)) revert Errors.InvalidPath();

        // V2.1.2 (Soken N-01 / N-SP-01 / F-04-MEV.2): every intermediate hop token must
        // be Owner-whitelisted. numHops = (pathLen - 20) / 23 = number of fee segments =
        // numTokens - 1. Middle tokens sit at calldata offsets 23, 46, ..., 23*(numHops-1).
        // Single-hop paths (numHops == 1) have no middle token and skip the loop.
        uint256 numHops = (pathLen - 20) / 23;
        for (uint256 i = 1; i < numHops; ) {
            address hopToken;
            uint256 off = 23 * i;
            assembly {
                hopToken := shr(96, calldataload(add(path.offset, off)))
            }
            if (!allowedHopToken[hopToken]) {
                revert Errors.HopTokenNotWhitelisted(hopToken);
            }
            unchecked { ++i; }
        }
    }
}
