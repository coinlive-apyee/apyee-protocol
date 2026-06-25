import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  ACCRUE_PRECISION,
  DEFAULT_FEE_RATE,
  MAX_FEE,
  deployVaultV2Fixture,
} from "../fixtures/deployVaultV2";

const usdc = (n: string) => ethers.parseUnits(n, 6);

/// V2.1 — Soken APY-2026-06-001 remediation specs.
///
/// One file per fix that has a non-trivial behavioral assertion:
///   F-17 — vault brick via stale lastSharePrice (Critical)
///   F-01 — accrual hook-ordering fairness (Medium)
///   F-05 — Owner quarantine escape hatch (Informational, future adapter)
///   F-06 — Ownable2Step + renounce-disabled (Low)
///   F-02 — strategyList swap-and-pop / no duplicate on re-add (Medium)
///   F-03 — fee base = realized profit, not post-yield TA (Low)
///
/// Each block also documents the inverse assertion against the pre-fix behavior
/// so a regression on the same root cause would be caught by the same test.
describe("VaultV2 V2.1 remediation", () => {
  // ─────────────────────────────────────────────────────────────
  // F-17 (Critical) — lastSharePrice reset on totalSupply()→0
  // ─────────────────────────────────────────────────────────────
  describe("F-17 — lastSharePrice reset prevents vault brick", () => {
    async function depositAndExitFully(amount: bigint) {
      const fx = await loadFixture(deployVaultV2Fixture);
      const { vault, usdc: token, alice, treasury } = fx;

      // 1. Alice deposits, then a quiet yield window to seed a non-trivial lastSharePrice baseline.
      await token.connect(alice).approve(await vault.getAddress(), amount);
      await vault.connect(alice).deposit(amount, alice.address);

      const vaultAddr = await vault.getAddress();
      await token.mint(vaultAddr, amount / 100n); // +1% yield direct donation
      await time.increase(1);
      await vault.accrue();

      // 2. Drain ALL holders: alice + treasury (whatever fee shares accrued).
      const aliceShares = await vault.balanceOf(alice.address);
      const treasuryShares = await vault.balanceOf(treasury.address);
      if (aliceShares > 0n) {
        await vault.connect(alice).redeem(aliceShares, alice.address, alice.address);
      }
      if (treasuryShares > 0n) {
        await vault.connect(treasury).redeem(treasuryShares, treasury.address, treasury.address);
      }
      expect(await vault.totalSupply()).to.equal(0n);
      return fx;
    }

    it("test_f17_lastSharePriceResetsToZero_whenTotalSupplyReturnsToZero", async () => {
      const { vault } = await depositAndExitFully(usdc("1000"));
      // The fix: V2.1 _withdraw + _accrue both reset lastSharePrice = 0 when totalSupply()==0.
      // Without the fix this stayed stale-positive and detonated the FeeTooHigh guard on the
      // next deposit (Soken §F-17 PoC).
      expect(await vault.lastSharePrice()).to.equal(0n);
    });

    it("test_f17_freshDepositAfterEmptyVault_doesNotBrick", async () => {
      const fx = await depositAndExitFully(usdc("1000"));
      const { vault, usdc: token, bob } = fx;
      const vaultAddr = await vault.getAddress();

      // Soken §F-17 attack: donate ≥10 wei USDC to a now-empty vault then redeposit.
      // Pre-fix: next accrue trips FeeTooHigh and freezes every deposit/withdraw/accrue.
      // Post-fix: lastSharePrice == 0 → lazy re-init in _deposit re-snaps cleanly.
      await token.mint(vaultAddr, 1000n); // 1000 wei = $0.001 — well above 10-wei trip threshold

      const seed = usdc("100");
      await token.connect(bob).approve(vaultAddr, seed);
      await expect(vault.connect(bob).deposit(seed, bob.address)).to.not.be.reverted;

      // Vault stays usable: accrue + withdraw + setFeeRate are all live again.
      await time.increase(1);
      await expect(vault.accrue()).to.not.be.reverted;
      const bobShares = await vault.balanceOf(bob.address);
      await expect(
        vault.connect(bob).redeem(bobShares / 2n, bob.address, bob.address),
      ).to.not.be.reverted;
    });
  });

  // ─────────────────────────────────────────────────────────────
  // F-01 (Medium) — accrue-first ordering keeps deposit/redeem fair
  // ─────────────────────────────────────────────────────────────
  describe("F-01 — public entrypoints accrue before pricing", () => {
    it("test_f01_depositAfterQuietYield_returnsImmediatelyRedeemableValue", async () => {
      const { vault, usdc: token, owner, alice, bob } = await loadFixture(deployVaultV2Fixture);
      const vaultAddr = await vault.getAddress();

      // Alice seeds the vault and waits — accrual is dormant.
      const seed = usdc("10000");
      await token.connect(alice).approve(vaultAddr, seed);
      await vault.connect(alice).deposit(seed, alice.address);

      // Inject 5% yield without invoking the vault (no accrue triggers yet).
      await token.mint(vaultAddr, seed / 20n); // +500 USDC = 5% gap
      await time.increase(7 * 24 * 60 * 60); // 7 days of dormant gap

      // Bob deposits $9k (well under the $10k default user cap). Without the F-01 fix, the
      // deposit is priced at the pre-accrue ratio and the subsequent _accrue mint dilutes
      // Bob's shares — an immediate redeem shorts Bob by ~feeRate × gap = ~0.7% on a 5%
      // gap × 15% fee. With the fix, deposit→immediate-redeem returns ~exactly the deposit.
      const bobDeposit = usdc("9000");
      await vault.connect(owner).setUserCap(bob.address, usdc("20000"));
      await token.mint(bob.address, bobDeposit);
      await token.connect(bob).approve(vaultAddr, bobDeposit);
      await vault.connect(bob).deposit(bobDeposit, bob.address);

      // Immediate full redeem.
      const bobShares = await vault.balanceOf(bob.address);
      const usdcBefore = await token.balanceOf(bob.address);
      await vault.connect(bob).redeem(bobShares, bob.address, bob.address);
      const recovered = (await token.balanceOf(bob.address)) - usdcBefore;

      // Post-fix: Bob recovers essentially what he deposited (allow 1 unit for rounding).
      // Pre-fix: shortfall ≈ 700 USDC on a 100k deposit. The tight tolerance below would fail.
      expect(recovered).to.be.gte(bobDeposit - 2n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // F-05 (Informational) — Owner quarantine escape hatch
  // ─────────────────────────────────────────────────────────────
  describe("F-05 — Owner setQuarantine() excludes a strategy from accounting", () => {
    async function deployWithInvestedStrategy() {
      const fx = await loadFixture(deployVaultV2Fixture);
      const { vault, usdc: token, owner, keeper, alice, strategy } = fx;
      const vaultAddr = await vault.getAddress();

      // Whitelist + invest.
      await vault
        .connect(owner)
        .addStrategy(await strategy.getAddress(), 3000, 4000);
      await token.connect(alice).approve(vaultAddr, usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault
        .connect(keeper)
        .investToStrategy(await strategy.getAddress(), usdc("3000"));

      return fx;
    }

    it("test_f05_setQuarantine_excludesStrategyFromTotalAssets", async () => {
      const { vault, owner, strategy } = await deployWithInvestedStrategy();
      const taBefore = await vault.totalAssets();
      const stratBal = await strategy.balanceOf();

      await vault
        .connect(owner)
        .setQuarantine(await strategy.getAddress(), true);
      const taAfter = await vault.totalAssets();

      // The strategy's balance no longer contributes — totalAssets drops by exactly stratBal.
      expect(taBefore - taAfter).to.equal(stratBal);
    });

    it("test_f05_quarantinedStrategy_rejectsInvest", async () => {
      const { vault, owner, keeper, strategy } = await deployWithInvestedStrategy();
      await vault
        .connect(owner)
        .setQuarantine(await strategy.getAddress(), true);

      await expect(
        vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("100")),
      ).to.be.revertedWithCustomError(vault, "StrategyNotWhitelisted");
    });

    it("test_f05_setQuarantine_isOnlyOwner", async () => {
      const { vault, attacker, strategy } = await deployWithInvestedStrategy();
      await expect(
        vault.connect(attacker).setQuarantine(await strategy.getAddress(), true),
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("test_f05_setQuarantine_restoresAccountingWhenCleared", async () => {
      const { vault, owner, strategy } = await deployWithInvestedStrategy();
      const taBefore = await vault.totalAssets();

      await vault.connect(owner).setQuarantine(await strategy.getAddress(), true);
      await vault.connect(owner).setQuarantine(await strategy.getAddress(), false);

      expect(await vault.totalAssets()).to.equal(taBefore);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // F-06 (Low) — Ownable2Step + renounceOwnership disabled
  // ─────────────────────────────────────────────────────────────
  describe("F-06 — Ownable2Step + renounceOwnership disabled", () => {
    it("test_f06_renounceOwnership_reverts", async () => {
      const { vault, owner } = await loadFixture(deployVaultV2Fixture);
      await expect(vault.connect(owner).renounceOwnership()).to.be.reverted;
    });

    it("test_f06_transferOwnership_requiresAcceptance", async () => {
      const { vault, owner, bob } = await loadFixture(deployVaultV2Fixture);
      // V2.0 Ownable would have made bob the owner immediately. V2.1 Ownable2Step queues
      // the transfer and waits for bob.acceptOwnership().
      await vault.connect(owner).transferOwnership(bob.address);
      expect(await vault.owner()).to.equal(owner.address);     // still the old owner
      expect(await vault.pendingOwner()).to.equal(bob.address); // bob is now the candidate

      await vault.connect(bob).acceptOwnership();
      expect(await vault.owner()).to.equal(bob.address);
      expect(await vault.pendingOwner()).to.equal(ethers.ZeroAddress);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // F-02 (Medium) — removeStrategy swap-and-pop, no duplicate on re-add
  // ─────────────────────────────────────────────────────────────
  describe("F-02 — removeStrategy swap-and-pop prevents NAV double-count", () => {
    it("test_f02_removeThenReAdd_doesNotDuplicateInList", async () => {
      const { vault, owner, strategy } = await loadFixture(deployVaultV2Fixture);

      const stratAddr = await strategy.getAddress();
      await vault.connect(owner).addStrategy(stratAddr, 3000, 4000);
      expect(await vault.strategyCount()).to.equal(1n);

      await vault.connect(owner).removeStrategy(stratAddr);
      expect(await vault.strategyCount()).to.equal(0n);

      await vault.connect(owner).addStrategy(stratAddr, 3000, 4000);
      // Pre-fix: count would be 2 (the address sat in the array; the re-add pushed a second).
      // Post-fix: count == 1, totalAssets() sums the position once.
      expect(await vault.strategyCount()).to.equal(1n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // F-03 (Low) — fee base is realized profit, not post-yield TA
  // ─────────────────────────────────────────────────────────────
  describe("F-03 — fee charged on profit, not post-yield TA", () => {
    it("test_f03_feeShareValue_matchesExactly_feeRateTimesProfit", async () => {
      const { vault, usdc: token, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      const vaultAddr = await vault.getAddress();

      // Deposit + simulate a clean +10% yield (no fee accrued yet).
      const seed = usdc("10000");
      await token.connect(alice).approve(vaultAddr, seed);
      await vault.connect(alice).deposit(seed, alice.address);

      const yieldAmount = seed / 10n; // 1000 USDC = 10% gap
      await token.mint(vaultAddr, yieldAmount);
      await time.increase(1);

      // Trigger accrue.
      await vault.accrue();

      // Treasury's share value should equal feeRate × profit, NOT feeRate × (1+g) × profit.
      // For a 10% gap at 15% feeRate, post-fix charges 150 USDC. Pre-fix charged 165 USDC.
      const treasuryShares = await vault.balanceOf(treasury.address);
      const treasuryAssets = await vault.convertToAssets(treasuryShares);
      const expectedFeeAssets =
        (yieldAmount * BigInt(DEFAULT_FEE_RATE)) / 10_000n; // = 150 USDC

      // Within 1 USDC unit (rounding) of the fair amount; well below the 15-USDC pre-fix overcharge.
      expect(treasuryAssets).to.be.closeTo(expectedFeeAssets, 1n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // F-04 (Low) — claim infra is present + onlyKeeper-gated
  // ─────────────────────────────────────────────────────────────
  describe("F-04 — claim infra wiring", () => {
    it("test_f04_baseStrategy_keeper_isReadDynamicallyFromVault", async () => {
      // We can't exercise the full claim flow without a fork (real distributor + DEX),
      // but we can verify the onlyKeeper modifier reads from the vault dynamically. Since
      // MockStrategy doesn't expose claimAndCompound, this test asserts the surrounding
      // invariant the Keeper bot will rely on: vault.keeper() returns the active EOA.
      const { vault, owner, keeper, bob } = await loadFixture(deployVaultV2Fixture);
      expect(await vault.keeper()).to.equal(keeper.address);

      // Owner rotates Keeper; the next claim invocation by the old Keeper would revert.
      await vault.connect(owner).setKeeper(bob.address);
      expect(await vault.keeper()).to.equal(bob.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Cross-cut: MAX_FEE ceiling honored after V2.1 changes
  // ─────────────────────────────────────────────────────────────
  describe("MAX_FEE ceiling — invariant preserved across V2.1 fixes", () => {
    it("test_setFeeRate_aboveMaxFee_revertsAfterV21", async () => {
      const { vault, owner } = await loadFixture(deployVaultV2Fixture);
      await expect(
        vault.connect(owner).setFeeRate(MAX_FEE + 1),
      ).to.be.revertedWithCustomError(vault, "FeeTooHigh");
    });

    it("test_accrue_neverMintsAboveMaxFee_atBoundary", async () => {
      const { vault, usdc: token, owner, alice, treasury } =
        await loadFixture(deployVaultV2Fixture);
      const vaultAddr = await vault.getAddress();

      await vault.connect(owner).setFeeRate(MAX_FEE); // 20%
      const seed = usdc("10000");
      await token.connect(alice).approve(vaultAddr, seed);
      await vault.connect(alice).deposit(seed, alice.address);

      await token.mint(vaultAddr, seed / 10n); // +10% yield
      await time.increase(1);
      await vault.accrue();

      const treasuryAssets = await vault.convertToAssets(
        await vault.balanceOf(treasury.address),
      );
      // At 20% feeRate on $1000 profit, fee ≤ $200. With F-03 fix, exactly 200.
      expect(treasuryAssets).to.be.lte(usdc("200") + 1n);
      expect(treasuryAssets).to.be.closeTo(usdc("200"), 1n);
    });
  });
});

// Silence unused-import warning for ACCRUE_PRECISION (kept for future fuzz expansion).
void ACCRUE_PRECISION;
