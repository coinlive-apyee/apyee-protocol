import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployVaultV2Fixture,
  deployConservativeVault,
  deployAggressiveVault,
  V2_DEPOSIT_CAP,
  V2_DEFAULT_USER_CAP,
  DEFAULT_FEE_RATE,
  MAX_ALLOCATION_CEILING,
  ACCRUE_PRECISION,
  TIER_CONSERVATIVE_BPS,
  TIER_BALANCED_BPS,
  TIER_AGGRESSIVE_BPS,
  V2_VERSION_HASHES,
} from "../fixtures/deployVaultV2";

const usdc = (n: string) => ethers.parseUnits(n, 6);

// Helper: add MockStrategy to a vault with given target/max bps.
async function addMockStrategy(
  vault: any,
  owner: any,
  strategy: any,
  targetBps = 2000,
  maxBpsOverride?: number,
) {
  const maxBps = maxBpsOverride ?? Number(await vault.MAX_ALLOCATION_BPS_ABSOLUTE());
  await vault.connect(owner).addStrategy(await strategy.getAddress(), targetBps, maxBps);
}

// Helper: deposit USDC from a signer (handles approve + deposit).
async function deposit(vault: any, token: any, signer: any, amount: bigint) {
  await token.connect(signer).approve(await vault.getAddress(), amount);
  return vault.connect(signer).deposit(amount, signer.address);
}

// Raise per-user cap so depositCap is the binding limit (used by larger deposits).
async function raiseUserCap(vault: any, owner: any, user: any, cap: bigint) {
  await vault.connect(owner).setUserCap(user.address, cap);
}

describe("VaultV2", () => {
  // ════════════════════════════════════════════════════════════
  //  Constructor — V2 new params (maxAllocationAbsolute_ + versionHash_)
  // ════════════════════════════════════════════════════════════
  describe("constructor", () => {
    it("test_constructor_setsImmutableTierAndVersionHash", async () => {
      const { vault, versionHash } = await loadFixture(deployVaultV2Fixture);
      expect(await vault.MAX_ALLOCATION_BPS_ABSOLUTE()).to.equal(TIER_BALANCED_BPS);
      expect(await vault.VERSION_HASH()).to.equal(versionHash);
    });

    it("test_constructor_zeroMaxAllocation_reverts", async () => {
      const [owner, keeper, guardian, treasury] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();
      const VaultV2 = await ethers.getContractFactory("VaultV2");
      await expect(
        VaultV2.deploy({
          asset: await token.getAddress(),
          name: "v",
          symbol: "v",
          initialOwner: owner.address,
          keeper: keeper.address,
          guardian: guardian.address,
          treasury: treasury.address,
          feeRate: DEFAULT_FEE_RATE,
          depositCap: V2_DEPOSIT_CAP,
          defaultUserCap: V2_DEFAULT_USER_CAP,
          maxAllocationAbsolute: 0, // <- zero maxAllocBps
          versionHash: V2_VERSION_HASHES.devBalanced,
        }),
      ).to.be.revertedWithCustomError(VaultV2, "AllocationExceeded");
    });

    it("test_constructor_maxAllocationAboveCeiling_reverts", async () => {
      const [owner, keeper, guardian, treasury] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();
      const VaultV2 = await ethers.getContractFactory("VaultV2");
      await expect(
        VaultV2.deploy({
          asset: await token.getAddress(),
          name: "v",
          symbol: "v",
          initialOwner: owner.address,
          keeper: keeper.address,
          guardian: guardian.address,
          treasury: treasury.address,
          feeRate: DEFAULT_FEE_RATE,
          depositCap: V2_DEPOSIT_CAP,
          defaultUserCap: V2_DEFAULT_USER_CAP,
          maxAllocationAbsolute: MAX_ALLOCATION_CEILING + 1, // <- exceeds 10000
          versionHash: V2_VERSION_HASHES.devBalanced,
        }),
      ).to.be.revertedWithCustomError(VaultV2, "AllocationExceeded");
    });

    it("test_constructor_lastSharePrice_zeroBeforeFirstDeposit", async () => {
      // Baseline is intentionally NOT pre-seeded — first super._deposit() snaps it to the
      // real share price (which depends on decimalsOffset, see constructor NatSpec).
      const { vault } = await loadFixture(deployVaultV2Fixture);
      expect(await vault.lastSharePrice()).to.equal(0);
      expect(await vault.lastAccruedAt()).to.be.gt(0);
    });

    it("test_firstDeposit_lazyInitsLastSharePrice", async () => {
      const { vault, usdc: token, alice } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));
      const lastSp = await vault.lastSharePrice();
      // sp = TA * 1e18 / TS. With USDC 6 decimals + decimalsOffset 6, sp ≈ 1e12 — not 1e18.
      expect(lastSp).to.be.gt(0);
      expect(lastSp).to.be.lt(ACCRUE_PRECISION);
    });

    it("test_constructor_decimalsOffsetIsSix", async () => {
      const { vault } = await loadFixture(deployVaultV2Fixture);
      expect(await vault.decimals()).to.equal(12);
    });
  });

  // ════════════════════════════════════════════════════════════
  //  7.1 Accrual core scenarios (15) — V2_VAULT.md §7.1
  // ════════════════════════════════════════════════════════════
  describe("accrual (streaming fee)", () => {
    // ─── Scenario 1 ───────────────────────────────────────
    it("test_accrue_freshDeployFirstDeposit_zeroFee", async () => {
      const { vault, usdc: token, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("1000"));
      // Pre-first-deposit branch + lazy baseline init: no fee can have accrued.
      expect(await vault.balanceOf(treasury.address)).to.equal(0);
      // Baseline lazy-initialized to actual sp (not the constructor pre-seed).
      expect(await vault.lastSharePrice()).to.be.gt(0);
    });

    // ─── Scenario 2 ───────────────────────────────────────
    it("test_accrue_steadyYieldThenRedeem_feeMatchesShareGrowth", async () => {
      const { vault, usdc: token, owner, alice, treasury, strategy } =
        await loadFixture(deployVaultV2Fixture);

      await addMockStrategy(vault, owner, strategy);
      await deposit(vault, token, alice, usdc("10000"));

      // Simulate 5% yield directly in vault idle (assets grow, supply same → sp ↑).
      await token.mint(await vault.getAddress(), usdc("500"));

      const taBefore = await vault.totalAssets();
      const tsBefore = await vault.totalSupply();
      const lastSp = await vault.lastSharePrice();
      // sp_now = TA * 1e18 / TS
      const spNow = (taBefore * ACCRUE_PRECISION) / tsBefore;

      // V2.1 (F-03 fix): fee base is realized profit (TS × Δsp / 1e18), not post-yield TA.
      //   feeAssets = TS * (sp_now - lastSp) * feeRate / (1e18 * 10_000)
      const feeAssetsExpected =
        (tsBefore * (spNow - lastSp) * BigInt(DEFAULT_FEE_RATE)) /
        (ACCRUE_PRECISION * 10_000n);

      // feeShares = feeAssets * TS / (TA - feeAssets)
      const feeSharesExpected =
        (feeAssetsExpected * tsBefore) / (taBefore - feeAssetsExpected);

      // Trigger accrual via redeem path (a state-changing action calls _accrue).
      await vault.connect(alice).redeem(usdc("100"), alice.address, alice.address);

      const treasuryShares = await vault.balanceOf(treasury.address);
      // Direct equality — math is deterministic on the chain.
      expect(treasuryShares).to.equal(feeSharesExpected);
    });

    // ─── Scenario 3 ───────────────────────────────────────
    it("test_accrue_lossBaseline_drifsDownAndNoFee", async () => {
      const { vault, usdc: token, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));

      // Bring sp up first (so we have a real lastSharePrice baseline > 1.0).
      await token.mint(await vault.getAddress(), usdc("500"));
      await vault.accrue();
      const spAfterGain = await vault.lastSharePrice();

      // Now simulate loss by burning USDC from vault.
      const vaultAddr = await vault.getAddress();
      const lossAmount = usdc("200");
      await token.burnFrom(vaultAddr, lossAmount);

      const treasurySharesBefore = await vault.balanceOf(treasury.address);
      await vault.accrue();
      const treasurySharesAfter = await vault.balanceOf(treasury.address);
      expect(treasurySharesAfter).to.equal(treasurySharesBefore); // no new fee

      const lastSpAfter = await vault.lastSharePrice();
      expect(lastSpAfter).to.be.lt(spAfterGain); // baseline drifted DOWN
    });

    // ─── Scenario 4 ───────────────────────────────────────
    it("test_accrue_lossRecovery_feeOnRecovery_noHwm", async () => {
      const { vault, usdc: token, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));
      const vaultAddr = await vault.getAddress();

      // Gain → loss → fully recovered. With HWM, no fee on recovery to baseline.
      // Without HWM (V2 choice [[1]]), fee charged on every upward move from current baseline.
      await token.mint(vaultAddr, usdc("500"));        // +5%
      await vault.accrue();
      const sp1 = await vault.lastSharePrice();

      await token.burnFrom(vaultAddr, usdc("200"));    // -2%
      await vault.accrue();
      const sp2 = await vault.lastSharePrice();
      expect(sp2).to.be.lt(sp1);
      const treasury1 = await vault.balanceOf(treasury.address);

      // Now recover above the dip — V2 charges fee on (sp3 - sp2), not (sp3 - sp1).
      await token.mint(vaultAddr, usdc("250"));        // back up & past sp1
      await vault.accrue();
      const treasury2 = await vault.balanceOf(treasury.address);
      expect(treasury2).to.be.gt(treasury1); // <-- the "no HWM" smoking gun
    });

    // ─── Scenario 5 ───────────────────────────────────────
    it("test_accrue_sameBlockGuard_singleAccrue", async () => {
      const { vault, usdc: token, alice, bob, treasury } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("1000"));
      await token.mint(await vault.getAddress(), usdc("100"));
      await vault.accrue();
      const lastTs = await vault.lastAccruedAt();
      const treasurySharesBefore = await vault.balanceOf(treasury.address);

      // Two deposits in the same block (auto-mine off so manual mine controls timing).
      await ethers.provider.send("evm_setAutomine", [false]);
      try {
        await token.connect(bob).approve(await vault.getAddress(), usdc("2000"));
        await vault.connect(bob).deposit(usdc("1000"), bob.address);
        await vault.connect(bob).deposit(usdc("1000"), bob.address);
        await mine(1);
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }

      // Same-block guard: `lastAccruedAt` not bumped twice within one block — but the
      // initial accrue() already ran, so the first deposit's _accrue is a no-op (timestamp match).
      // Verify treasury supply increased by at most ONE fee mint amount, not two.
      const treasurySharesAfter = await vault.balanceOf(treasury.address);
      // Single accrual already happened pre-block; in-block deposits add no more fee.
      expect(treasurySharesAfter).to.equal(treasurySharesBefore);
      // Timestamp may equal lastTs (no profit since) or be higher; both legal.
      expect(await vault.lastAccruedAt()).to.be.gte(lastTs);
    });

    // ─── Scenario 6 ───────────────────────────────────────
    it("test_accrue_setFeeRate_locksOldRateBeforeNew", async () => {
      const { vault, usdc: token, owner, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));
      await token.mint(await vault.getAddress(), usdc("500")); // +5%

      // BEFORE rate change: fee charged at old rate (1500 bps).
      const expectedAtOldRate = await vault.pendingFeeShares();
      expect(expectedAtOldRate).to.be.gt(0);

      // setFeeRate calls _accrue() FIRST (locks old rate), then changes rate.
      await vault.connect(owner).setFeeRate(500); // 5%
      const treasuryAfter = await vault.balanceOf(treasury.address);
      expect(treasuryAfter).to.equal(expectedAtOldRate);

      // New rate now applies to FUTURE yield only — no retroactive tax.
      expect(await vault.feeRate()).to.equal(500);
    });

    // ─── Scenario 7 ───────────────────────────────────────
    it("test_accrue_dustProfit_feeZero_baselineBumped", async () => {
      const { vault, usdc: token, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));
      const lastSpBefore = await vault.lastSharePrice();
      const lastTsBefore = await vault.lastAccruedAt();

      // Add 1 wei of USDC — sub-bps yield → fee math truncates to 0.
      await token.mint(await vault.getAddress(), 1n);
      await time.increase(1); // ensure block.timestamp moves
      await vault.accrue();

      expect(await vault.balanceOf(treasury.address)).to.equal(0);
      expect(await vault.lastAccruedAt()).to.be.gt(lastTsBefore);
      // sp bumped (even if minutely) — baseline tracks reality, not stuck at old value.
      expect(await vault.lastSharePrice()).to.be.gte(lastSpBefore);
    });

    // ─── Scenario 8 ───────────────────────────────────────
    it("test_accrue_largeYield_precisionPreserved", async () => {
      const { vault, usdc: token, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));

      // 100% yield — TA doubles. sp = 2.0 * 1e18.
      await token.mint(await vault.getAddress(), usdc("10000"));
      const tsBefore = await vault.totalSupply();
      const taBefore = await vault.totalAssets();
      const lastSp = await vault.lastSharePrice();
      const spNow = (taBefore * ACCRUE_PRECISION) / tsBefore;
      // V2.1 (F-03 fix): fee base is realized profit (TS × Δsp / 1e18), not post-yield TA.
      const feeAssetsExpected =
        (tsBefore * (spNow - lastSp) * BigInt(DEFAULT_FEE_RATE)) /
        (ACCRUE_PRECISION * 10_000n);
      const feeSharesExpected =
        (feeAssetsExpected * tsBefore) / (taBefore - feeAssetsExpected);

      await vault.accrue();
      expect(await vault.balanceOf(treasury.address)).to.equal(feeSharesExpected);
    });

    // ─── Scenario 9 ───────────────────────────────────────
    it("test_accrue_postMintBaseline_isPreMintSp_noDoubleTax", async () => {
      const { vault, usdc: token, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));
      const vaultAddr = await vault.getAddress();

      // Yield → accrue → baseline should EQUAL pre-mint sp (= sp at time of accrue call).
      await token.mint(vaultAddr, usdc("500"));
      const ts1 = await vault.totalSupply();
      const ta1 = await vault.totalAssets();
      const preMintSp = (ta1 * ACCRUE_PRECISION) / ts1;

      await vault.accrue();
      expect(await vault.lastSharePrice()).to.equal(preMintSp); // exact pre-mint sp

      // Next accrual with NO new yield should mint 0 fees (baseline already at current sp).
      const treasuryAfter = await vault.balanceOf(treasury.address);
      await time.increase(1);
      await vault.accrue();
      expect(await vault.balanceOf(treasury.address)).to.equal(treasuryAfter);
    });

    // ─── Scenario 10 ──────────────────────────────────────
    it("test_accrue_publicCall_isIdempotent", async () => {
      const { vault, usdc: token, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));
      await token.mint(await vault.getAddress(), usdc("500"));

      await vault.accrue();
      const firstSnapshot = await vault.balanceOf(treasury.address);
      await vault.accrue(); // call again immediately
      expect(await vault.balanceOf(treasury.address)).to.equal(firstSnapshot);
    });

    // ─── Scenario 11 ──────────────────────────────────────
    it("test_accrue_withdrawWhenPaused_stillRuns", async () => {
      const { vault, usdc: token, alice, guardian, treasury } =
        await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));
      await token.mint(await vault.getAddress(), usdc("500"));
      await vault.connect(guardian).pause();

      // pause MUST NOT block withdraw (CLAUDE.md invariant 2.4).
      const aliceShares = await vault.balanceOf(alice.address);
      await vault.connect(alice).redeem(aliceShares / 10n, alice.address, alice.address);

      // _accrue ran inside _withdraw → treasury received fee.
      expect(await vault.balanceOf(treasury.address)).to.be.gt(0);
    });

    // ─── Scenario 12 ──────────────────────────────────────
    it("test_pendingFeeShares_matchesActualMint", async () => {
      const { vault, usdc: token, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));
      await token.mint(await vault.getAddress(), usdc("500"));

      const pending = await vault.pendingFeeShares();
      expect(pending).to.be.gt(0);

      await vault.accrue();
      expect(await vault.balanceOf(treasury.address)).to.equal(pending);
    });

    // ─── Scenario 13 ──────────────────────────────────────
    it("test_treasuryRedeem_nextCycleBaselineStillTracksSp", async () => {
      const { vault, usdc: token, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));
      await token.mint(await vault.getAddress(), usdc("500"));
      await vault.accrue();

      const treasuryShares = await vault.balanceOf(treasury.address);
      expect(treasuryShares).to.be.gt(0);

      // Treasury redeems all → triggers _withdraw → _accrue. With no new yield, the loss-tolerance
      // branch may drift baseline downward (sp post-mint < sp pre-mint, fix [[4]] only prevented
      // double-tax on the SAME mint cycle — subsequent cycles see real dilution). That's fine:
      // critical invariant is that the next REAL yield still produces correct fee.
      await vault.connect(treasury).redeem(treasuryShares, treasury.address, treasury.address);
      expect(await vault.balanceOf(treasury.address)).to.equal(0);

      // Future yield → coherent baseline → new fee mints normally.
      await token.mint(await vault.getAddress(), usdc("100"));
      await time.increase(60);
      await vault.accrue();
      expect(await vault.balanceOf(treasury.address)).to.be.gt(0);
    });

    // ─── Scenario 14 ──────────────────────────────────────
    it("test_setTreasury_settlesOldTreasuryFirst", async () => {
      const { vault, usdc: token, owner, alice, treasury, bob } =
        await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));
      await token.mint(await vault.getAddress(), usdc("500"));

      // Switch treasury to bob — must accrue PENDING fees to OLD treasury first.
      const pending = await vault.pendingFeeShares();
      await vault.connect(owner).setTreasury(bob.address);

      expect(await vault.balanceOf(treasury.address)).to.equal(pending);
      expect(await vault.balanceOf(bob.address)).to.equal(0);
      expect(await vault.treasury()).to.equal(bob.address);
    });

    // ─── Scenario 15 ──────────────────────────────────────
    it("test_treasuryMaxRedeem_returnsActualBalance", async () => {
      const { vault, usdc: token, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      await deposit(vault, token, alice, usdc("10000"));
      await token.mint(await vault.getAddress(), usdc("500"));
      await vault.accrue();

      const treasuryShares = await vault.balanceOf(treasury.address);
      const maxRedeem = await vault.maxRedeem(treasury.address);
      expect(maxRedeem).to.equal(treasuryShares);

      // Treasury can in fact redeem exactly maxRedeem (no revert).
      await vault.connect(treasury).redeem(maxRedeem, treasury.address, treasury.address);
      expect(await vault.balanceOf(treasury.address)).to.equal(0);
    });
  });

  // ════════════════════════════════════════════════════════════
  //  7.2 Cap Parametrization (5) — V2_VAULT.md §7.2
  // ════════════════════════════════════════════════════════════
  describe("cap parametrization (per-tier immutable)", () => {
    // ─── Scenario 16 ──────────────────────────────────────
    it("test_conservativeTier_invest30Percent_revertsAllocationExceeded", async () => {
      const { vault, usdc: token, owner, keeper, strategy, alice } =
        await loadFixture(deployConservativeVault);
      // Conservative cap = 2500 (25%). Add strategy with maxAllocBps = 2500.
      await addMockStrategy(vault, owner, strategy, 2000, TIER_CONSERVATIVE_BPS);
      // Raise per-user cap so the deposit isn't blocked by user cap.
      await raiseUserCap(vault, owner, alice, usdc("100000"));
      await deposit(vault, token, alice, usdc("10000"));

      // Try to invest 30% (= 3000 USDC > 2500 USDC cap) → revert.
      await expect(
        vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("3000")),
      ).to.be.revertedWithCustomError(vault, "AllocationExceeded");
    });

    // ─── Scenario 17 ──────────────────────────────────────
    it("test_aggressiveTier_invest50Percent_succeeds", async () => {
      const { vault, usdc: token, owner, keeper, strategy, alice } =
        await loadFixture(deployAggressiveVault);
      // Aggressive cap = 6000 (60%).
      await addMockStrategy(vault, owner, strategy, 5000, TIER_AGGRESSIVE_BPS);
      await raiseUserCap(vault, owner, alice, usdc("100000"));
      await deposit(vault, token, alice, usdc("10000"));

      // 50% (= 5000 USDC) is below the 60% cap → succeeds.
      await vault
        .connect(keeper)
        .investToStrategy(await strategy.getAddress(), usdc("5000"));
      expect(await strategy.balanceOf()).to.equal(usdc("5000"));
    });

    // ─── Scenario 18 ──────────────────────────────────────
    it("test_threeTiersDeployed_differentRuntimeBytecode", async () => {
      const [owner, keeper, guardian, treasury] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();
      const VaultV2 = await ethers.getContractFactory("VaultV2");

      const tiers = [
        { cap: TIER_CONSERVATIVE_BPS, vh: V2_VERSION_HASHES.devConservative },
        { cap: TIER_BALANCED_BPS,     vh: V2_VERSION_HASHES.devBalanced },
        { cap: TIER_AGGRESSIVE_BPS,   vh: V2_VERSION_HASHES.devAggressive },
      ];

      const addrs: string[] = [];
      const onChainCaps: bigint[] = [];
      const onChainHashes: string[] = [];
      for (const t of tiers) {
        const v = await VaultV2.deploy({
          asset: await token.getAddress(),
          name: "v",
          symbol: "v",
          initialOwner: owner.address,
          keeper: keeper.address,
          guardian: guardian.address,
          treasury: treasury.address,
          feeRate: DEFAULT_FEE_RATE,
          depositCap: V2_DEPOSIT_CAP,
          defaultUserCap: V2_DEFAULT_USER_CAP,
          maxAllocationAbsolute: t.cap,
          versionHash: t.vh,
        });
        addrs.push(await v.getAddress());
        onChainCaps.push(await v.MAX_ALLOCATION_BPS_ABSOLUTE());
        onChainHashes.push(await v.VERSION_HASH());
      }

      // All 3 addresses differ.
      expect(new Set(addrs).size).to.equal(3);
      // Caps differ (immutable correctly embedded).
      expect(onChainCaps).to.deep.equal([
        BigInt(TIER_CONSERVATIVE_BPS),
        BigInt(TIER_BALANCED_BPS),
        BigInt(TIER_AGGRESSIVE_BPS),
      ]);
      // Version hashes differ.
      expect(new Set(onChainHashes).size).to.equal(3);
    });

    // ─── Scenario 19 ──────────────────────────────────────
    it("test_setStrategyMaxAllocation_aboveImmutableCap_reverts", async () => {
      const { vault, owner, strategy } = await loadFixture(deployConservativeVault);
      await addMockStrategy(vault, owner, strategy, 2000, TIER_CONSERVATIVE_BPS);

      // Try to raise per-strategy max above immutable tier cap (2500) → revert.
      await expect(
        vault
          .connect(owner)
          .setStrategyMaxAllocation(await strategy.getAddress(), TIER_CONSERVATIVE_BPS + 1),
      ).to.be.revertedWithCustomError(vault, "AllocationExceeded");
    });

    // ─── Scenario 20 ──────────────────────────────────────
    it("test_tierImmutableValue_matchesDeployConfig", async () => {
      // Direct deploys in a single chain state — loadFixture restores between calls and would
      // leave earlier deployments at addresses no longer holding code.
      const [owner, keeper, guardian, treasury] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();
      const VaultV2 = await ethers.getContractFactory("VaultV2");

      const cases = [
        { bps: TIER_CONSERVATIVE_BPS, vh: V2_VERSION_HASHES.devConservative },
        { bps: TIER_BALANCED_BPS,     vh: V2_VERSION_HASHES.devBalanced     },
        { bps: TIER_AGGRESSIVE_BPS,   vh: V2_VERSION_HASHES.devAggressive   },
      ];
      for (const c of cases) {
        const v = await VaultV2.deploy({
          asset: await token.getAddress(),
          name: "v",
          symbol: "v",
          initialOwner: owner.address,
          keeper: keeper.address,
          guardian: guardian.address,
          treasury: treasury.address,
          feeRate: DEFAULT_FEE_RATE,
          depositCap: V2_DEPOSIT_CAP,
          defaultUserCap: V2_DEFAULT_USER_CAP,
          maxAllocationAbsolute: c.bps,
          versionHash: c.vh,
        });
        expect(await v.MAX_ALLOCATION_BPS_ABSOLUTE()).to.equal(c.bps);
        expect(await v.VERSION_HASH()).to.equal(c.vh);
      }
    });
  });
});
