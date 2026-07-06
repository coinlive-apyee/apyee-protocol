import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-network-helpers";

import { deployVaultV2Fixture, TIER_BALANCED_BPS } from "../fixtures/deployVaultV2";

/// V2.1.3 — Soken APY-2026-06-002 remediation review residuals.
///
/// F-902 (Low): fix #9 override's stated "no-op on the transactional path" invariant
///              is not strictly bit-identical under a same-block accrue-latch
///              (accrue → donate → deposit in one block). The V2.1.3 fix gates the
///              pending term on `lastAccruedAt == block.timestamp`, mirroring the
///              same latch that governs _accrue() itself.
///
/// F-901 (Info, pre-existing): investToStrategy now carries whenNotPaused so a
///                             Guardian pause closes the last principal-in path.

describe("V2.1.3 remediation — Soken residuals", () => {
  describe("F-902 — Fix #9 override bit-identical under same-block accrue-latch", () => {
    /// Base fixture used by both direction tests. Deposit → invest → yield so
    /// share price is above lastSharePrice, then the *first* action of a block
    /// snaps lastSharePrice via _accrue(). Subsequent actions in the same block
    /// hit the same-block guard.
    async function primedFixture() {
      const fx = await deployVaultV2Fixture("balanced");
      const depositAmt = ethers.parseUnits("5000", 6);
      await fx.usdc.connect(fx.alice).approve(await fx.vault.getAddress(), depositAmt);
      await fx.vault.connect(fx.alice).deposit(depositAmt, fx.alice.address);
      await fx.vault
        .connect(fx.owner)
        .addStrategy(await fx.strategy.getAddress(), 3000, TIER_BALANCED_BPS);
      const investAmt = (depositAmt * BigInt(TIER_BALANCED_BPS)) / 10_000n;
      await fx.vault
        .connect(fx.keeper)
        .investToStrategy(await fx.strategy.getAddress(), investAmt);
      // First accrue-priming yield so lastSharePrice is set to something
      // meaningful, not 0 lazy-init.
      const initialYield = ethers.parseUnits("100", 6);
      await fx.usdc.mint(await fx.strategy.getAddress(), initialYield);
      await fx.strategy.simulateYield(initialYield);
      // Force an accrue so lastSharePrice snaps to the pre-donation sp.
      await fx.vault.connect(fx.alice).accrue();
      return fx;
    }

    it("test_f902_sameBlockAccrueLatch_pendingIsZeroInsidePreview", async () => {
      // The primary invariant restoration. Reproduce Soken's PoC scenario in one block:
      //   1. accrue()               → lastAccruedAt = block.timestamp, lastSharePrice snapped
      //   2. donate underlying      → totalAssets() rises (sp climbs above lastSharePrice)
      //   3. read convertToShares   → override reads _pendingFeeShares.
      // Pre-fix (V2.1.2): step 3 sees non-zero pending → shares over-minted vs base OZ.
      // Post-fix (V2.1.3): `lastAccruedAt == block.timestamp` gate forces pending term
      // to 0 inside the same block → bit-identical to base OZ.
      const fx = await loadFixture(primedFixture);

      // Batch accrue + donate into the same block using automine off. `hardhat-network-
      // helpers` doesn't export a wrapper for this — go direct via the provider RPC.
      await ethers.provider.send("evm_setAutomine", [false]);
      try {
        await fx.vault.connect(fx.alice).accrue();
        const donation = ethers.parseUnits("500", 6);
        await fx.usdc.connect(fx.alice).transfer(await fx.vault.getAddress(), donation);
        await mine();
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }

      // At this point:
      //   - lastAccruedAt equals the block just mined.
      //   - totalAssets() has risen post-accrue via the donation (F-10 class).
      //   - The naive _pendingFeeShares() would be non-zero (share price grew after
      //     the latched accrue). The V2.1.3 gate must return 0 inside the override.
      // We can't assert the gated read directly (helper is internal), so we
      // observe the effect: convertToShares must equal base OZ math (which uses
      // totalSupply without any pending-fee contribution).

      // Sanity: the ungated pending view is > 0 — otherwise the test setup is stale
      // and we're not actually reproducing the F-902 window.
      const pendingUngated = await fx.vault.pendingFeeShares();
      expect(pendingUngated, "sanity: ungated pending > 0 after latched donation").to.be.gt(0n);

      // Invariant: same-block window → convertToShares equals base-OZ formula.
      const ts = await fx.vault.totalSupply();
      const ta = await fx.vault.totalAssets();
      const offset = 10n ** 6n; // _decimalsOffset = 6
      const assets = ethers.parseUnits("100", 6);
      const baseOZ = (assets * (ts + offset)) / (ta + 1n); // Math.Rounding.Floor
      const actual = await fx.vault.convertToShares(assets);
      expect(actual, "V2.1.3: convertToShares must be bit-identical to base OZ inside the same-block accrue-latch").to.equal(baseOZ);
    });

    it("test_f902_multiBlock_pendingContinuesToBeReflectedInViews", async () => {
      // Outside the same-block window (external view queries in a later block),
      // the pending term MUST still be reflected — that's the whole point of fix #9.
      // This is a regression guard against overcorrecting F-902.
      const fx = await loadFixture(primedFixture);

      // Yield grows share price above lastSharePrice.
      const donation = ethers.parseUnits("500", 6);
      await fx.usdc.connect(fx.alice).transfer(await fx.vault.getAddress(), donation);
      // Advance a few blocks so `lastAccruedAt != block.timestamp` when the view runs.
      await mine(3);

      const pendingRaw = await fx.vault.pendingFeeShares();
      expect(pendingRaw, "sanity: pending > 0 after yield").to.be.gt(0n);

      const ts = await fx.vault.totalSupply();
      const ta = await fx.vault.totalAssets();
      const offset = 10n ** 6n;
      const assets = ethers.parseUnits("100", 6);
      const baseOZ = (assets * (ts + offset)) / (ta + 1n);
      const withPending = (assets * (ts + pendingRaw + offset)) / (ta + 1n);
      const actual = await fx.vault.convertToShares(assets);
      // Outside the gate window, override must include pending → strictly greater than base OZ.
      expect(actual, "convertToShares must include pending term in a later block").to.equal(withPending);
      expect(actual, "and be strictly greater than base OZ").to.be.gt(baseOZ);
    });
  });

  describe("F-901 — investToStrategy pause-gated", () => {
    async function withStrategyFixture() {
      const fx = await deployVaultV2Fixture("balanced");
      const depositAmt = ethers.parseUnits("5000", 6);
      await fx.usdc.connect(fx.alice).approve(await fx.vault.getAddress(), depositAmt);
      await fx.vault.connect(fx.alice).deposit(depositAmt, fx.alice.address);
      await fx.vault
        .connect(fx.owner)
        .addStrategy(await fx.strategy.getAddress(), 3000, TIER_BALANCED_BPS);
      return fx;
    }

    it("test_f901_investToStrategy_whenPaused_reverts", async () => {
      // Guardian pauses the vault → Keeper's autonomous investToStrategy must revert
      // (previously succeeded — pre-existing gap Soken F-901).
      const fx = await loadFixture(withStrategyFixture);
      await fx.vault.connect(fx.guardian).pause();

      const investAmt = ethers.parseUnits("1000", 6);
      await expect(
        fx.vault.connect(fx.keeper).investToStrategy(await fx.strategy.getAddress(), investAmt),
      ).to.be.revertedWithCustomError(fx.vault, "EnforcedPause");
    });

    it("test_f901_investToStrategy_whenUnpaused_succeeds", async () => {
      // Baseline: same call under normal (unpaused) state still works.
      const fx = await loadFixture(withStrategyFixture);
      const investAmt = ethers.parseUnits("1000", 6);
      await expect(
        fx.vault.connect(fx.keeper).investToStrategy(await fx.strategy.getAddress(), investAmt),
      ).to.not.be.reverted;
    });

    it("test_f901_divestFromStrategy_whenPaused_stillSucceeds", async () => {
      // Recovery-direction paths must remain pause-free (per the Soken F-901
      // recommendation). Confirm divestFromStrategy still works while paused.
      const fx = await loadFixture(withStrategyFixture);
      // Seed a strategy balance first (before pause).
      const investAmt = ethers.parseUnits("1000", 6);
      await fx.vault.connect(fx.keeper).investToStrategy(await fx.strategy.getAddress(), investAmt);
      // Pause and try to divest.
      await fx.vault.connect(fx.guardian).pause();
      await expect(
        fx.vault.connect(fx.keeper).divestFromStrategy(await fx.strategy.getAddress(), investAmt),
      ).to.not.be.reverted;
    });

    it("test_f901_userWithdraw_whenPaused_stillSucceeds", async () => {
      // The core invariant: pause() cannot block user withdraw. Regression check.
      const fx = await loadFixture(withStrategyFixture);
      await fx.vault.connect(fx.guardian).pause();
      const shares = await fx.vault.balanceOf(fx.alice.address);
      await expect(
        fx.vault.connect(fx.alice).redeem(shares, fx.alice.address, fx.alice.address),
      ).to.not.be.reverted;
    });
  });
});
