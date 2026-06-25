// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IStrategy} from "../interfaces/IStrategy.sol";
import {Errors} from "../libraries/Errors.sol";
import {ISwapRouter} from "../interfaces/external/ISwapRouter.sol";

/// @dev Minimal Vault surface used by BaseStrategy to read the current Keeper EOA for
///      `onlyKeeper` gating on `claimAndCompound`. Reading dynamically (vs. caching an
///      immutable) lets the Vault Owner rotate the Keeper without redeploying every
///      strategy.
interface IVaultKeeperView {
    function keeper() external view returns (address);
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
        // dexRouter_ may be address(0) for strategies that opt out of reward compounding —
        // `_swapAndReinvest` will revert with NotKeeper-style guard when invoked.
        vault = vault_;
        underlyingAsset = IERC20(asset_);
        dexRouter = ISwapRouter(dexRouter_);
        STRATEGY_VERSION_HASH = strategyVersionHash_;
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
    function deposit(uint256 amount) external override onlyVault nonReentrant {
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
        if (address(dexRouter) == address(0)) revert Errors.ZeroAddress();
        if (rewardToken == address(underlyingAsset)) revert Errors.AssetMismatch(rewardToken, address(underlyingAsset));
        if (amountIn == 0) return 0;

        // Layout + endpoint binding — prevents a malicious Keeper from re-routing the
        // swap to a different input or output token.
        _validateSwapPath(rewardToken, swapPath);

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

    /// @dev Checks the path bytes are well-formed and bound to the right endpoints.
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
    }
}
