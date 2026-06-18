// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VaultV2} from "../../contracts/Vault.sol";
import {MockUSDC} from "../../contracts/mocks/MockUSDC.sol";
import {Errors} from "../../contracts/libraries/Errors.sol";

/// @title Streaming-fee fuzz suite — exercises `_accrue()` and its four
///        audit-critical fixes under randomized share-price trajectories,
///        fee-rate changes, and timing.
///
/// Each test seeds a single user, mutates `totalAssets()` directly via
/// `deal()` (the Vault is strategy-agnostic from the share-price math
/// perspective — `totalAssets()` reads `idle + sum(strategy)`, and with
/// zero strategies registered `idle` alone drives the share price), and
/// then asserts the relevant invariant.
contract VaultV2AccrueFuzz is Test {
    VaultV2 internal vault;
    MockUSDC internal usdc;
    address internal owner = address(0xA11CE);
    address internal keeper = address(0xB0B);
    address internal guardian = address(0xC0DE);
    address internal treasury = address(0xDEAD);
    address internal user = address(0xCA47);

    // V2-prod-balanced equivalents (from deployments/v2-prod/balanced/*.json).
    uint16 internal constant FEE_RATE_BPS = 1500;          // 15%
    uint16 internal constant MAX_FEE = 2000;               // 20% (hardcoded ceiling)
    uint16 internal constant MAX_ALLOCATION_ABSOLUTE = 4000; // Balanced tier
    uint256 internal constant DEPOSIT_CAP = 1_000_000_000_000e6;  // effectively uncapped for fuzz
    uint256 internal constant USER_CAP = 1_000_000_000_000e6;     // effectively uncapped for fuzz

    function setUp() public {
        usdc = new MockUSDC();

        vault = new VaultV2(VaultV2.InitConfig({
            asset: IERC20(address(usdc)),
            name: "Apyee USDC Vault V2 (Balanced)",
            symbol: "apUSDC-b",
            initialOwner: owner,
            keeper: keeper,
            guardian: guardian,
            treasury: treasury,
            feeRate: FEE_RATE_BPS,
            depositCap: DEPOSIT_CAP,
            defaultUserCap: USER_CAP,
            maxAllocationAbsolute: MAX_ALLOCATION_ABSOLUTE,
            versionHash: keccak256("2.0.0-prod-balanced")
        }));

        // Seed first deposit so that `lastSharePrice` is lazily initialized.
        _depositAsUser(user, 1_000e6);
    }

    /// ──────────────────────────────────────────────────────────────────────
    /// Helpers
    /// ──────────────────────────────────────────────────────────────────────

    function _depositAsUser(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _seedYield(uint256 yieldAmount) internal {
        // Increase Vault idle by `yieldAmount` — equivalent to a strategy
        // posting yield back to the Vault during a divest cycle.
        usdc.mint(address(vault), yieldAmount);
    }

    function _seedLoss(uint256 lossAmount) internal {
        // Decrease Vault idle by `lossAmount` — equivalent to a strategy
        // taking a depeg/peg-recovery loss. Use vm.prank/transfer to drain.
        vm.prank(address(vault));
        usdc.transfer(address(0xBEEF), lossAmount);
    }

    function _sharePrice() internal view returns (uint256) {
        uint256 ts = vault.totalSupply();
        if (ts == 0) return 0;
        return vault.totalAssets() * 1e18 / ts;
    }

    /// ──────────────────────────────────────────────────────────────────────
    /// Fix [[1]] — loss tolerance: sp ≤ lastSharePrice ⇒ fee = 0
    /// ──────────────────────────────────────────────────────────────────────

    function testFuzz_lossTolerance_noFeeMinted(uint256 lossBps) public {
        // Random loss between 1bps and 5000bps (50%) of current TA.
        lossBps = bound(lossBps, 1, 5000);

        uint256 spBefore = vault.lastSharePrice();
        uint256 treasurySharesBefore = vault.balanceOf(treasury);

        uint256 lossAmount = vault.totalAssets() * lossBps / 10_000;
        if (lossAmount == 0) return;
        _seedLoss(lossAmount);

        // Trigger _accrue() via public entrypoint.
        vm.warp(block.timestamp + 1);
        vault.accrue();

        // Invariants:
        //   1. No fee shares minted to treasury.
        //   2. lastSharePrice tracked downward to the new (lower) sp.
        assertEq(
            vault.balanceOf(treasury),
            treasurySharesBefore,
            "loss-tolerance: treasury must not receive fee on loss"
        );
        assertLt(
            vault.lastSharePrice(),
            spBefore,
            "loss-tolerance: lastSharePrice must track downward"
        );
    }

    /// ──────────────────────────────────────────────────────────────────────
    /// Fix [[2]] — direct asset-unit math: dust yield truncates to fee=0
    ///             but the baseline still bumps so the next cycle sees
    ///             only future yield as profit.
    /// ──────────────────────────────────────────────────────────────────────

    function testFuzz_dustYield_feeBoundedByYield(uint256 dustWei) public {
        // Bound to small yields to exercise the precision path of Fix [[2]]
        // (direct asset-unit math). Range covers sub-bps to ~1 bps of TA.
        dustWei = bound(dustWei, 1, 1000); // 1 wei to 1000 wei of USDC

        uint256 spBefore = vault.lastSharePrice();
        uint256 treasurySharesBefore = vault.balanceOf(treasury);

        _seedYield(dustWei);

        vm.warp(block.timestamp + 1);
        vault.accrue();

        uint256 spAfter = vault.lastSharePrice();

        // Invariant 1: baseline moves up monotonically on any profit
        // (including sub-bps dust — Fix [[2]] no longer truncates at the
        //  profitBps intermediate stage).
        assertGe(spAfter, spBefore, "baseline must move up monotonically on profit");

        // Invariant 2: fee mint is bounded by yield × feeRate. Without
        // the decimalsOffset (=6) inflation, feeAssets ≤ dustWei × 1500 / 10000.
        // In share units that ceiling is `dustWei × 1500 / 10000 × 10^6`.
        // Add a 2x safety margin to absorb rounding ulps.
        uint256 treasuryDelta = vault.balanceOf(treasury) - treasurySharesBefore;
        uint256 maxExpectedShares = dustWei * FEE_RATE_BPS / 10_000 * 1e6 * 2 + 10;
        assertLe(
            treasuryDelta,
            maxExpectedShares,
            "dust yield: fee shares must be bounded by yield * feeRate (no oversize mint)"
        );
    }

    /// ──────────────────────────────────────────────────────────────────────
    /// Fix [[3]] — dilutive mint formula: pendingFeeShares(view) == actual mint
    /// ──────────────────────────────────────────────────────────────────────

    function testFuzz_pendingFeeShares_matchesActualMint(uint256 yieldBps) public {
        // Random yield between 1bps and 5000bps (50%) of current TA.
        yieldBps = bound(yieldBps, 1, 5000);

        uint256 yieldAmount = vault.totalAssets() * yieldBps / 10_000;
        if (yieldAmount == 0) return;
        _seedYield(yieldAmount);

        vm.warp(block.timestamp + 1);

        // View-only projection BEFORE the actual mint.
        uint256 pending = vault.pendingFeeShares();
        uint256 treasurySharesBefore = vault.balanceOf(treasury);

        // Realize.
        vault.accrue();

        uint256 actualMinted = vault.balanceOf(treasury) - treasurySharesBefore;

        assertEq(
            pending,
            actualMinted,
            "pendingFeeShares projection must equal actual minted feeShares"
        );
    }

    /// ──────────────────────────────────────────────────────────────────────
    /// Fix [[4]] — post-mint baseline = pre-mint sp (not the diluted sp).
    ///             Prevents double-taxation on dilution recovery.
    /// ──────────────────────────────────────────────────────────────────────

    function testFuzz_postMintBaseline_equalsPreMintSp(uint256 yieldBps) public {
        // Yield range that produces a nonzero fee.
        yieldBps = bound(yieldBps, 100, 5000); // 1% to 50% of TA

        uint256 yieldAmount = vault.totalAssets() * yieldBps / 10_000;
        if (yieldAmount == 0) return;
        _seedYield(yieldAmount);

        // Compute the pre-mint sp the way the contract will.
        uint256 ta = vault.totalAssets();
        uint256 ts = vault.totalSupply();
        uint256 preMintSp = ta * 1e18 / ts;

        vm.warp(block.timestamp + 1);
        vault.accrue();

        // Baseline must be the pre-mint sp, NOT the post-mint diluted sp.
        assertEq(
            vault.lastSharePrice(),
            preMintSp,
            "post-mint baseline must equal pre-mint sp (no double-tax)"
        );
    }

    /// ──────────────────────────────────────────────────────────────────────
    /// Same-block guard: lastAccruedAt == block.timestamp ⇒ idempotent
    /// ──────────────────────────────────────────────────────────────────────

    function testFuzz_sameBlockGuard_secondAccrueIsNoop(uint256 yieldBps) public {
        yieldBps = bound(yieldBps, 100, 5000);

        uint256 yieldAmount = vault.totalAssets() * yieldBps / 10_000;
        if (yieldAmount == 0) return;
        _seedYield(yieldAmount);

        vm.warp(block.timestamp + 1);
        vault.accrue();

        uint256 treasurySharesAfterFirst = vault.balanceOf(treasury);
        uint256 lastSpAfterFirst = vault.lastSharePrice();

        // Second call in the SAME block.
        vault.accrue();

        assertEq(
            vault.balanceOf(treasury),
            treasurySharesAfterFirst,
            "same-block guard: no additional shares minted"
        );
        assertEq(
            vault.lastSharePrice(),
            lastSpAfterFirst,
            "same-block guard: lastSharePrice unchanged"
        );
    }

    /// ──────────────────────────────────────────────────────────────────────
    /// MAX_FEE bound: setFeeRate(> MAX_FEE) reverts
    /// ──────────────────────────────────────────────────────────────────────

    function testFuzz_setFeeRate_aboveMaxFee_reverts(uint16 newRate) public {
        vm.assume(newRate > MAX_FEE);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(Errors.FeeTooHigh.selector, newRate, MAX_FEE)
        );
        vault.setFeeRate(newRate);
    }

    /// ──────────────────────────────────────────────────────────────────────
    /// setFeeRate accrues at OLD rate before applying NEW rate
    /// ──────────────────────────────────────────────────────────────────────

    function testFuzz_setFeeRate_oldRateLocksInBeforeNewApplies(
        uint256 yieldBps,
        uint16 newRate
    ) public {
        yieldBps = bound(yieldBps, 100, 5000);
        newRate = uint16(bound(newRate, 0, MAX_FEE));

        uint256 yieldAmount = vault.totalAssets() * yieldBps / 10_000;
        if (yieldAmount == 0) return;
        _seedYield(yieldAmount);

        vm.warp(block.timestamp + 1);

        // Project fee at the OLD rate before changing it.
        uint256 pendingBeforeChange = vault.pendingFeeShares();
        uint256 treasurySharesBefore = vault.balanceOf(treasury);

        vm.prank(owner);
        vault.setFeeRate(newRate);

        uint256 mintedDuringRateChange = vault.balanceOf(treasury) - treasurySharesBefore;

        assertEq(
            mintedDuringRateChange,
            pendingBeforeChange,
            "setFeeRate must accrue at OLD rate before NEW rate applies"
        );
        assertEq(vault.feeRate(), newRate, "feeRate updated after accrual");
    }

    /// ──────────────────────────────────────────────────────────────────────
    /// setTreasury accrues to OLD treasury before swap
    /// ──────────────────────────────────────────────────────────────────────

    function testFuzz_setTreasury_settlesOldTreasuryFirst(
        uint256 yieldBps,
        address newTreasury
    ) public {
        yieldBps = bound(yieldBps, 100, 5000);
        vm.assume(newTreasury != address(0));
        vm.assume(newTreasury != treasury);

        uint256 yieldAmount = vault.totalAssets() * yieldBps / 10_000;
        if (yieldAmount == 0) return;
        _seedYield(yieldAmount);

        vm.warp(block.timestamp + 1);

        uint256 pendingBeforeSwap = vault.pendingFeeShares();
        uint256 oldTreasuryBefore = vault.balanceOf(treasury);
        uint256 newTreasuryBefore = vault.balanceOf(newTreasury);

        vm.prank(owner);
        vault.setTreasury(newTreasury);

        assertEq(
            vault.balanceOf(treasury) - oldTreasuryBefore,
            pendingBeforeSwap,
            "old treasury must receive accrued fees on swap"
        );
        assertEq(
            vault.balanceOf(newTreasury),
            newTreasuryBefore,
            "new treasury must not receive anything during the swap"
        );
    }

    /// ──────────────────────────────────────────────────────────────────────
    /// withdraw works while paused — invariant
    /// ──────────────────────────────────────────────────────────────────────

    function testFuzz_pause_doesNotBlockWithdraw(uint256 redeemBps) public {
        redeemBps = bound(redeemBps, 1, 10_000); // 0.01% to 100% of shares

        vm.prank(guardian);
        vault.pause();
        assertTrue(vault.paused(), "vault must be paused");

        uint256 userShares = vault.balanceOf(user);
        uint256 redeemShares = userShares * redeemBps / 10_000;
        if (redeemShares == 0) return;

        // Compute exit value before redeem to assert the user actually got assets.
        uint256 expectedAssets = vault.previewRedeem(redeemShares);

        uint256 usdcBefore = usdc.balanceOf(user);
        vm.prank(user);
        vault.redeem(redeemShares, user, user);
        uint256 usdcAfter = usdc.balanceOf(user);

        assertEq(
            usdcAfter - usdcBefore,
            expectedAssets,
            "user must receive previewed asset amount even while paused"
        );
    }

    /// ──────────────────────────────────────────────────────────────────────
    /// Monotonic baseline: between accrues, share price never decreases due
    ///                     to a yield event (only loss can lower it).
    /// ──────────────────────────────────────────────────────────────────────

    function testFuzz_monotonicSpOnYield(uint256 yieldBps) public {
        yieldBps = bound(yieldBps, 1, 5000);

        uint256 spBefore = _sharePrice();
        uint256 yieldAmount = vault.totalAssets() * yieldBps / 10_000;
        if (yieldAmount == 0) return;
        _seedYield(yieldAmount);

        uint256 spAfterSeed = _sharePrice();
        assertGe(spAfterSeed, spBefore, "sp must not decrease on yield");

        vm.warp(block.timestamp + 1);
        vault.accrue();

        // After accrue, sp may slightly drop because of dilutive fee mint,
        // but it must still be > spBefore (we taxed only the growth, not the principal).
        uint256 spAfterAccrue = _sharePrice();
        assertGe(spAfterAccrue, spBefore, "post-accrue sp must still exceed pre-yield sp");
    }
}
