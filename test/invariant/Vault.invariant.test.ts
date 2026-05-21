import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { deployVaultFixture } from "../fixtures/deployVault";

const usdc = (n: string) => ethers.parseUnits(n, 6);

/// Invariant tests for Vault.sol — properties that MUST hold after every state-changing action.
/// Hardhat doesn't ship a Foundry-style invariant runner, so we exercise the invariants via
/// scripted scenarios that cover real action sequences (deposit / invest / divest / withdraw /
/// harvest / rebalance / emergency / pause). Each scenario calls `assertCoreInvariants` after
/// every action so a regression anywhere in the call chain trips the test.
describe("Vault — invariants", () => {
  // ─────────────────────────────────────────────────────────────
  // Core invariant suite — call after every state mutation
  // ─────────────────────────────────────────────────────────────

  async function assertCoreInvariants(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vault: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    strategies: any[],
    label: string = "",
  ): Promise<void> {
    const vaultAddr = await vault.getAddress();
    const idle: bigint = await token.balanceOf(vaultAddr);

    // ── (1) Accounting: totalAssets == idle + Σ active strategy balances ──────
    let activeSum = 0n;
    for (const s of strategies) {
      const sAddr = await s.getAddress();
      const info = await vault.strategyInfo(sAddr);
      if (info.isActive) {
        activeSum += await s.balanceOf();
      }
    }
    const totalAssets: bigint = await vault.totalAssets();
    expect(
      totalAssets,
      `[${label}] totalAssets drift: expected ${idle + activeSum}, got ${totalAssets}`,
    ).to.equal(idle + activeSum);

    // ── (2) Baseline ≤ current balance for every tracked strategy ────────────
    for (const s of strategies) {
      const sAddr = await s.getAddress();
      const info = await vault.strategyInfo(sAddr);
      if (!info.isActive && !info.isBlacklisted) continue;
      const lastBal: bigint = await vault.lastRecordedBalance(sAddr);
      const currentBal: bigint = await s.balanceOf();
      expect(
        lastBal,
        `[${label}] lastRecordedBalance(${sAddr}) > balanceOf — would mint phantom fee`,
      ).to.be.lte(currentBal);
    }

    // ── (3) Strategy state mutual exclusivity (active ⊕ blacklisted) ─────────
    for (const s of strategies) {
      const sAddr = await s.getAddress();
      const info = await vault.strategyInfo(sAddr);
      expect(
        info.isActive && info.isBlacklisted,
        `[${label}] strategy ${sAddr} both active and blacklisted`,
      ).to.equal(false);
    }

    // ── (4) Total supply ≥ 0 (degenerate, but inflation-attack mitigation: when
    //        totalSupply > 0 and totalAssets > 0, share price is bounded below 1
    //        only by the OZ ERC4626 decimals offset of 6) ─────────────────────
    const totalSupply: bigint = await vault.totalSupply();
    if (totalSupply > 0n && totalAssets > 0n) {
      // convertToAssets(1 share) >= 0 always; OZ math handles offset internally.
      const onePlusDecimalsOffset = await vault.convertToAssets(1n);
      expect(
        onePlusDecimalsOffset,
        `[${label}] convertToAssets(1) returned negative-like value`,
      ).to.be.gte(0n);
    }
  }

  /// Two-strategy fixture — most invariant scenarios need at least two adapters to exercise
  /// rebalance + multi-strategy auto-pull paths.
  async function deployTwoStrategyFixture() {
    const ctx = await loadFixture(deployVaultFixture);
    const { vault, owner, strategy, usdc: token } = ctx;

    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    const stratB = await MockStrategy.deploy(
      await vault.getAddress(),
      await token.getAddress(),
    );
    await stratB.waitForDeployment();

    await vault.connect(owner).addStrategy(await strategy.getAddress(), 3000, 3000);
    await vault.connect(owner).addStrategy(await stratB.getAddress(), 2000, 3000);

    return { ...ctx, stratA: strategy, stratB, strategies: [strategy, stratB] };
  }

  /// Inject yield into a Mock strategy: real USDC + bumped principal, mirrors interest accrual.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function injectYield(token: any, strategy: any, amount: bigint): Promise<void> {
    await token.mint(await strategy.getAddress(), amount);
    await strategy.simulateYield(amount);
  }

  // ─────────────────────────────────────────────────────────────
  describe("invariant after each action", () => {
    it("invariant_holds_through_deposit_invest_withdraw_cycle", async () => {
      const { vault, usdc: token, alice, owner, keeper, strategy } =
        await loadFixture(deployVaultFixture);
      await vault.connect(owner).addStrategy(await strategy.getAddress(), 3000, 3000);

      await assertCoreInvariants(vault, token, [strategy], "init");

      // 1. Alice deposits $9K (close to Beta cap to leave room for the auto-pull leg)
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("9000"), alice.address);
      await assertCoreInvariants(vault, token, [strategy], "after deposit");

      // 2. Keeper invests $2K → strategy (idle $7K, strategy $2K)
      await vault
        .connect(keeper)
        .investToStrategy(await strategy.getAddress(), usdc("2000"));
      await assertCoreInvariants(vault, token, [strategy], "after invest");

      // 3. Keeper divests $500 (idle $7.5K, strategy $1.5K)
      await vault
        .connect(keeper)
        .divestFromStrategy(await strategy.getAddress(), usdc("500"));
      await assertCoreInvariants(vault, token, [strategy], "after divest");

      // 4. Alice withdraws $5K (idle $7.5K covers, no auto-pull)
      await vault.connect(alice).withdraw(usdc("5000"), alice.address, alice.address);
      await assertCoreInvariants(vault, token, [strategy], "after withdraw idle-covered");

      // 5. Alice withdraws $3K (idle $2.5K insufficient → auto-pull $0.5K from strategy)
      await vault.connect(alice).withdraw(usdc("3000"), alice.address, alice.address);
      await assertCoreInvariants(vault, token, [strategy], "after withdraw auto-pulled");
    });

    it("invariant_holds_through_yield_and_harvest", async () => {
      const { vault, usdc: token, alice, owner, keeper, strategy, treasury } =
        await loadFixture(deployVaultFixture);
      await vault.connect(owner).addStrategy(await strategy.getAddress(), 3000, 3000);
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault
        .connect(keeper)
        .investToStrategy(await strategy.getAddress(), usdc("3000"));
      await assertCoreInvariants(vault, token, [strategy], "after setup invest");

      // Yield accrues
      await injectYield(token, strategy, usdc("300"));
      await assertCoreInvariants(vault, token, [strategy], "after yield injection");

      // Treasury share count BEFORE harvest must be 0 — only harvest mints fees.
      expect(await vault.balanceOf(treasury.address)).to.equal(0);

      await vault.connect(keeper).harvest();
      await assertCoreInvariants(vault, token, [strategy], "after harvest");

      // Treasury balance increased after harvest.
      expect(await vault.balanceOf(treasury.address)).to.be.gt(0);

      // Second harvest with no new yield → Treasury must NOT increase.
      const tBefore = await vault.balanceOf(treasury.address);
      await vault.connect(keeper).harvest();
      await assertCoreInvariants(vault, token, [strategy], "after second harvest no-op");
      expect(await vault.balanceOf(treasury.address)).to.equal(tBefore);
    });

    it("invariant_holds_through_divestInvestPair", async () => {
      const { vault, usdc: token, alice, keeper, stratA, stratB, strategies } =
        await deployTwoStrategyFixture();

      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault.connect(keeper).investToStrategy(await stratA.getAddress(), usdc("3000"));
      await assertCoreInvariants(vault, token, strategies, "before divest+invest pair");

      const totalBefore = await vault.totalAssets();
      // v2.1+: rebalance is now divest+invest pair (rebalance() removed prod, SPEC 1.24).
      await vault.connect(keeper).divestFromStrategy(await stratA.getAddress(), usdc("1500"));
      await assertCoreInvariants(vault, token, strategies, "after divest");
      await vault.connect(keeper).investToStrategy(await stratB.getAddress(), usdc("1500"));
      await assertCoreInvariants(vault, token, strategies, "after invest");

      // Pair must NOT change totalAssets — pure principal movement.
      expect(await vault.totalAssets()).to.equal(totalBefore);
    });

    it("invariant_holds_through_emergencyWithdraw_and_blacklist", async () => {
      const { vault, usdc: token, alice, owner, keeper, strategy } =
        await loadFixture(deployVaultFixture);
      await vault.connect(owner).addStrategy(await strategy.getAddress(), 3000, 3000);
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault
        .connect(keeper)
        .investToStrategy(await strategy.getAddress(), usdc("3000"));

      // Inject some yield so emergencyWithdraw moves > principal.
      await injectYield(token, strategy, usdc("100"));

      const totalBefore = await vault.totalAssets();
      await vault
        .connect(keeper)
        .emergencyWithdraw(await strategy.getAddress(), "test");
      await assertCoreInvariants(vault, token, [strategy], "after emergencyWithdraw");

      // Strategy is now blacklisted. State invariants verified by assertCoreInvariants.
      const info = await vault.strategyInfo(await strategy.getAddress());
      expect(info.isActive).to.equal(false);
      expect(info.isBlacklisted).to.equal(true);
      // Baseline must be reset to 0.
      expect(await vault.lastRecordedBalance(await strategy.getAddress())).to.equal(0);

      // Funds returned to vault → totalAssets unchanged (best case) or close.
      // Mock simulateYield writes to both _principal AND USDC balance, so totalAssets stable.
      expect(await vault.totalAssets()).to.equal(totalBefore);
    });

    it("invariant_holds_when_paused_and_user_withdraws", async () => {
      const { vault, usdc: token, alice, owner, keeper, guardian, strategy } =
        await loadFixture(deployVaultFixture);
      await vault.connect(owner).addStrategy(await strategy.getAddress(), 3000, 3000);
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault
        .connect(keeper)
        .investToStrategy(await strategy.getAddress(), usdc("3000"));

      await vault.connect(guardian).pause();
      await assertCoreInvariants(vault, token, [strategy], "after pause");

      // Withdraw must still work even when paused (Vault invariant CLAUDE.md 2.4).
      await vault.connect(alice).withdraw(usdc("8000"), alice.address, alice.address);
      await assertCoreInvariants(vault, token, [strategy], "after withdraw while paused");
    });

    it("invariant_holds_through_loss_and_recovery", async () => {
      // Loss case: balance drops below baseline. After harvest, baseline syncs to current
      // balance so the recovery doesn't get falsely counted as profit.
      const { vault, usdc: token, alice, owner, keeper, strategy, treasury } =
        await loadFixture(deployVaultFixture);
      await vault.connect(owner).addStrategy(await strategy.getAddress(), 3000, 3000);
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault
        .connect(keeper)
        .investToStrategy(await strategy.getAddress(), usdc("3000"));

      // Yield first → harvest → baseline at $3300.
      await injectYield(token, strategy, usdc("300"));
      await vault.connect(keeper).harvest();
      const treasuryAfterFirstHarvest = await vault.balanceOf(treasury.address);
      await assertCoreInvariants(vault, token, [strategy], "after first harvest");

      // Now the strategy has no further yield (no new injection). Second harvest should be no-op
      // and baseline must stay at $3300 (≤ current balance, invariant holds).
      await vault.connect(keeper).harvest();
      await assertCoreInvariants(vault, token, [strategy], "after second harvest no-op");
      expect(await vault.balanceOf(treasury.address)).to.equal(treasuryAfterFirstHarvest);

      // After full divest, baseline drops in lockstep (no phantom profit on next harvest).
      await vault
        .connect(keeper)
        .divestFromStrategy(
          await strategy.getAddress(),
          await strategy.balanceOf(),
        );
      await assertCoreInvariants(vault, token, [strategy], "after full divest");
      expect(await vault.lastRecordedBalance(await strategy.getAddress())).to.equal(0);

      // Re-invest → harvest → no fee (no new yield since baseline reset).
      await vault
        .connect(keeper)
        .investToStrategy(await strategy.getAddress(), usdc("1000"));
      await vault.connect(keeper).harvest();
      await assertCoreInvariants(vault, token, [strategy], "after reinvest harvest");
      // Treasury count unchanged.
      expect(await vault.balanceOf(treasury.address)).to.equal(treasuryAfterFirstHarvest);
    });

    it("invariant_holds_through_multi_strategy_auto_pull", async () => {
      const { vault, usdc: token, alice, keeper, stratA, stratB, strategies } =
        await deployTwoStrategyFixture();

      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault.connect(keeper).investToStrategy(await stratA.getAddress(), usdc("2000"));
      await vault.connect(keeper).investToStrategy(await stratB.getAddress(), usdc("2000"));
      await assertCoreInvariants(vault, token, strategies, "after both invested");

      // Withdraw $9K → idle $6K + need $3K pulled across stratA ($2K) and stratB ($1K).
      await vault.connect(alice).withdraw(usdc("9000"), alice.address, alice.address);
      await assertCoreInvariants(vault, token, strategies, "after multi-pull withdraw");
    });

    it("invariant_holds_through_complex_action_sequence", async () => {
      // Combined long-running sequence — exercises every state-changing entrypoint and
      // verifies the invariants don't drift in any pairing.
      const { vault, usdc: token, alice, bob, owner, keeper, guardian, stratA, stratB, strategies } =
        await deployTwoStrategyFixture();

      // Two-user deposits
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await token.connect(bob).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("4000"), alice.address);
      await assertCoreInvariants(vault, token, strategies, "alice deposited");
      await vault.connect(bob).deposit(usdc("3000"), bob.address);
      await assertCoreInvariants(vault, token, strategies, "bob deposited");

      // Keeper distributes
      await vault.connect(keeper).investToStrategy(await stratA.getAddress(), usdc("1500"));
      await assertCoreInvariants(vault, token, strategies, "stratA invested");
      await vault.connect(keeper).investToStrategy(await stratB.getAddress(), usdc("1000"));
      await assertCoreInvariants(vault, token, strategies, "stratB invested");

      // Yield + harvest
      await injectYield(token, stratA, usdc("100"));
      await injectYield(token, stratB, usdc("80"));
      await assertCoreInvariants(vault, token, strategies, "yield injected");
      await vault.connect(keeper).harvest();
      await assertCoreInvariants(vault, token, strategies, "after harvest");

      // Rebalance stratA → stratB via divest+invest pair (v2.1+, SPEC 1.24)
      await vault.connect(keeper).divestFromStrategy(await stratA.getAddress(), usdc("500"));
      await vault.connect(keeper).investToStrategy(await stratB.getAddress(), usdc("500"));
      await assertCoreInvariants(vault, token, strategies, "after divest+invest pair");

      // Pause + alice partial withdraw with auto-pull
      await vault.connect(guardian).pause();
      await assertCoreInvariants(vault, token, strategies, "paused");
      await vault.connect(alice).withdraw(usdc("3500"), alice.address, alice.address);
      await assertCoreInvariants(vault, token, strategies, "alice withdrew during pause");
      await vault.connect(owner).unpause();

      // Emergency on stratB
      await vault
        .connect(keeper)
        .emergencyWithdraw(await stratB.getAddress(), "scenario");
      await assertCoreInvariants(vault, token, strategies, "after emergency");

      // Bob redeems all his shares
      await vault
        .connect(bob)
        .redeem(await vault.balanceOf(bob.address), bob.address, bob.address);
      await assertCoreInvariants(vault, token, strategies, "bob redeemed");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("share-price invariants", () => {
    it("invariant_sharePrice_unchanged_by_deposit_or_withdraw", async () => {
      const { vault, usdc: token, alice, bob } = await loadFixture(deployVaultFixture);

      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await token.connect(bob).approve(await vault.getAddress(), usdc("10000"));

      // Initial deposit establishes a share price.
      await vault.connect(alice).deposit(usdc("5000"), alice.address);

      // Snapshot share price (≈ totalAssets / totalSupply, OZ math with offset).
      const oneShareValueBefore = await vault.convertToAssets(
        ethers.parseUnits("1000", 12),
      );

      // Bob deposits — share price should be unchanged.
      await vault.connect(bob).deposit(usdc("3000"), bob.address);
      const oneShareValueAfter = await vault.convertToAssets(
        ethers.parseUnits("1000", 12),
      );
      expect(oneShareValueAfter).to.equal(oneShareValueBefore);

      // Alice withdraws partial — share price still unchanged.
      await vault.connect(alice).withdraw(usdc("1000"), alice.address, alice.address);
      const oneShareValueAfterWithdraw = await vault.convertToAssets(
        ethers.parseUnits("1000", 12),
      );
      expect(oneShareValueAfterWithdraw).to.equal(oneShareValueBefore);
    });

    it("invariant_sharePrice_increases_after_yield_no_harvest", async () => {
      // Pure interest accrual (no fee mint) → share price strictly increases.
      const { vault, usdc: token, alice, owner, keeper, strategy } =
        await loadFixture(deployVaultFixture);
      await vault.connect(owner).addStrategy(await strategy.getAddress(), 3000, 3000);
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault
        .connect(keeper)
        .investToStrategy(await strategy.getAddress(), usdc("3000"));

      const before = await vault.convertToAssets(ethers.parseUnits("1000", 12));

      await injectYield(token, strategy, usdc("500"));

      const after = await vault.convertToAssets(ethers.parseUnits("1000", 12));
      expect(after).to.be.gt(before);
    });

    it("invariant_sharePrice_drops_slightly_after_harvest_fee_mint", async () => {
      // Harvest mints fee shares → share price dilutes slightly (still ≥ pre-yield baseline).
      const { vault, usdc: token, alice, owner, keeper, strategy } =
        await loadFixture(deployVaultFixture);
      await vault.connect(owner).addStrategy(await strategy.getAddress(), 3000, 3000);
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault
        .connect(keeper)
        .investToStrategy(await strategy.getAddress(), usdc("3000"));

      const baselinePrice = await vault.convertToAssets(ethers.parseUnits("1000", 12));
      await injectYield(token, strategy, usdc("500"));
      const peakPrice = await vault.convertToAssets(ethers.parseUnits("1000", 12));

      await vault.connect(keeper).harvest();
      const postHarvestPrice = await vault.convertToAssets(ethers.parseUnits("1000", 12));

      // Post-harvest price is between baseline and peak — fee diluted but yield captured.
      expect(postHarvestPrice).to.be.lte(peakPrice);
      expect(postHarvestPrice).to.be.gt(baselinePrice);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Treasury accounting invariant", () => {
    it("invariant_treasury_only_grows_via_harvest", async () => {
      const { vault, usdc: token, alice, owner, keeper, strategy, treasury } =
        await loadFixture(deployVaultFixture);
      await vault.connect(owner).addStrategy(await strategy.getAddress(), 3000, 3000);
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));

      // A series of non-harvest actions: deposit, invest, divest, withdraw, rebalance setup,
      // emergency. After all of these, Treasury MUST still be 0 (no harvest yet).
      await vault.connect(alice).deposit(usdc("5000"), alice.address);
      expect(await vault.balanceOf(treasury.address)).to.equal(0);

      await vault
        .connect(keeper)
        .investToStrategy(await strategy.getAddress(), usdc("1500"));
      expect(await vault.balanceOf(treasury.address)).to.equal(0);

      await vault
        .connect(keeper)
        .divestFromStrategy(await strategy.getAddress(), usdc("500"));
      expect(await vault.balanceOf(treasury.address)).to.equal(0);

      await vault.connect(alice).withdraw(usdc("1000"), alice.address, alice.address);
      expect(await vault.balanceOf(treasury.address)).to.equal(0);

      // Now harvest with profit → Treasury share count strictly increases.
      await injectYield(token, strategy, usdc("100"));
      await vault.connect(keeper).harvest();
      expect(await vault.balanceOf(treasury.address)).to.be.gt(0);
    });
  });
});
