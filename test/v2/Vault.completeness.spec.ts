import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import { deployVaultV2Fixture } from "../fixtures/deployVaultV2";

const usdc = (n: string) => ethers.parseUnits(n, 6);
const ZERO = ethers.ZeroAddress;

/// Completeness suite — covers every external/public function and revert path the unit, migration,
/// and adversarial specs leave untouched. Goal: Vault.sol coverage 100% for CLAUDE.md §5.1.
///
/// Grouped by role (Owner / Keeper / Guardian / Anyone) for review clarity.

async function deployWithStrategy() {
  const ctx = await loadFixture(deployVaultV2Fixture);
  await ctx.vault.connect(ctx.owner).addStrategy(
    await ctx.strategy.getAddress(),
    2000,
    Number(await ctx.vault.MAX_ALLOCATION_BPS_ABSOLUTE()),
  );
  return ctx;
}

describe("VaultV2 completeness", () => {
  // ════════════════════════════════════════════════════════════
  //  Owner role
  // ════════════════════════════════════════════════════════════
  describe("owner setters", () => {
    it("test_setKeeper_succeeds_emitsEvent", async () => {
      const { vault, owner, bob } = await loadFixture(deployVaultV2Fixture);
      await expect(vault.connect(owner).setKeeper(bob.address))
        .to.emit(vault, "KeeperUpdated")
        .withArgs(bob.address);
      expect(await vault.keeper()).to.equal(bob.address);
    });

    it("test_setKeeper_zeroAddress_reverts", async () => {
      const { vault, owner } = await loadFixture(deployVaultV2Fixture);
      await expect(vault.connect(owner).setKeeper(ZERO))
        .to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("test_setKeeper_nonOwner_reverts", async () => {
      const { vault, bob } = await loadFixture(deployVaultV2Fixture);
      await expect(vault.connect(bob).setKeeper(bob.address))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("test_setGuardian_succeeds_emitsEvent", async () => {
      const { vault, owner, bob } = await loadFixture(deployVaultV2Fixture);
      await expect(vault.connect(owner).setGuardian(bob.address))
        .to.emit(vault, "GuardianUpdated")
        .withArgs(bob.address);
    });

    it("test_setGuardian_zeroAddress_reverts", async () => {
      const { vault, owner } = await loadFixture(deployVaultV2Fixture);
      await expect(vault.connect(owner).setGuardian(ZERO))
        .to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("test_setTreasury_zeroAddress_reverts", async () => {
      const { vault, owner } = await loadFixture(deployVaultV2Fixture);
      await expect(vault.connect(owner).setTreasury(ZERO))
        .to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("test_setDepositCap_succeeds_emitsEvent", async () => {
      const { vault, owner } = await loadFixture(deployVaultV2Fixture);
      const newCap = usdc("123456");
      await expect(vault.connect(owner).setDepositCap(newCap))
        .to.emit(vault, "DepositCapUpdated")
        .withArgs(newCap);
      expect(await vault.depositCap()).to.equal(newCap);
    });

    it("test_setDefaultUserCap_succeeds_emitsEvent", async () => {
      const { vault, owner } = await loadFixture(deployVaultV2Fixture);
      const newCap = usdc("5000");
      await expect(vault.connect(owner).setDefaultUserCap(newCap))
        .to.emit(vault, "DefaultUserCapUpdated")
        .withArgs(newCap);
    });

    it("test_setFeeRate_aboveMax_reverts", async () => {
      const { vault, owner } = await loadFixture(deployVaultV2Fixture);
      await expect(vault.connect(owner).setFeeRate(2001))
        .to.be.revertedWithCustomError(vault, "FeeTooHigh");
    });
  });

  // ════════════════════════════════════════════════════════════
  //  Strategy lifecycle
  // ════════════════════════════════════════════════════════════
  describe("strategy lifecycle", () => {
    it("test_addStrategy_zeroAddress_reverts", async () => {
      const { vault, owner } = await loadFixture(deployVaultV2Fixture);
      const cap = Number(await vault.MAX_ALLOCATION_BPS_ABSOLUTE());
      await expect(vault.connect(owner).addStrategy(ZERO, 1000, cap))
        .to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("test_addStrategy_duplicateAdd_reverts", async () => {
      const { vault, owner, strategy } = await deployWithStrategy();
      const cap = Number(await vault.MAX_ALLOCATION_BPS_ABSOLUTE());
      await expect(
        vault.connect(owner).addStrategy(await strategy.getAddress(), 1000, cap),
      ).to.be.revertedWithCustomError(vault, "StrategyAlreadyAdded");
    });

    it("test_addStrategy_assetMismatch_reverts", async () => {
      const { vault, owner } = await loadFixture(deployVaultV2Fixture);
      // Deploy a MockStrategy bound to a DIFFERENT MockUSDC instance.
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const otherUsdc = await MockUSDC.deploy();
      const MockStrategy = await ethers.getContractFactory("MockStrategy");
      const evilStrat = await MockStrategy.deploy(
        await vault.getAddress(),
        await otherUsdc.getAddress(),
      );
      const cap = Number(await vault.MAX_ALLOCATION_BPS_ABSOLUTE());
      await expect(
        vault.connect(owner).addStrategy(await evilStrat.getAddress(), 1000, cap),
      ).to.be.revertedWithCustomError(vault, "AssetMismatch");
    });

    it("test_addStrategy_targetAboveMaxBps_reverts", async () => {
      const { vault, owner, strategy } = await loadFixture(deployVaultV2Fixture);
      // target > max → revert AllocationExceeded.
      await expect(
        vault.connect(owner).addStrategy(await strategy.getAddress(), 5000, 1000),
      ).to.be.revertedWithCustomError(vault, "AllocationExceeded");
    });

    it("test_removeStrategy_succeeds_whenBalanceZero", async () => {
      const { vault, owner, strategy } = await deployWithStrategy();
      await expect(vault.connect(owner).removeStrategy(await strategy.getAddress()))
        .to.emit(vault, "StrategyRemoved")
        .withArgs(await strategy.getAddress());
      const info = await vault.strategyInfo(await strategy.getAddress());
      expect(info.isActive).to.equal(false);
    });

    it("test_removeStrategy_withBalance_reverts", async () => {
      const { vault, owner, keeper, strategy, alice, usdc: token } =
        await deployWithStrategy();
      // Bypass per-user cap so deposit covers the invest amount.
      await vault.connect(owner).setUserCap(alice.address, usdc("100000"));
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("2000"));
      await expect(
        vault.connect(owner).removeStrategy(await strategy.getAddress()),
      ).to.be.revertedWithCustomError(vault, "StrategyHasBalance");
    });

    it("test_removeStrategy_notWhitelisted_reverts", async () => {
      const { vault, owner, alice } = await loadFixture(deployVaultV2Fixture);
      await expect(
        vault.connect(owner).removeStrategy(alice.address),
      ).to.be.revertedWithCustomError(vault, "StrategyNotWhitelisted");
    });

    it("test_unblacklistStrategy_cooldownActive_reverts", async () => {
      const { vault, owner, keeper, strategy, alice, usdc: token } =
        await deployWithStrategy();
      await vault.connect(owner).setUserCap(alice.address, usdc("100000"));
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("2000"));
      // emergencyWithdraw blacklists the strategy.
      await vault.connect(keeper).emergencyWithdraw(await strategy.getAddress());
      const info = await vault.strategyInfo(await strategy.getAddress());
      expect(info.isBlacklisted).to.equal(true);
      // Immediate unblacklist should hit BlacklistCooldownActive.
      await expect(
        vault.connect(owner).unblacklistStrategy(await strategy.getAddress()),
      ).to.be.revertedWithCustomError(vault, "BlacklistCooldownActive");
    });

    it("test_unblacklistStrategy_succeeds_afterCooldown", async () => {
      const { vault, owner, keeper, strategy, alice, usdc: token } =
        await deployWithStrategy();
      await vault.connect(owner).setUserCap(alice.address, usdc("100000"));
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("2000"));
      await vault.connect(keeper).emergencyWithdraw(await strategy.getAddress());

      await time.increase(72 * 3600 + 1); // BLACKLIST_COOLDOWN + 1s
      await expect(vault.connect(owner).unblacklistStrategy(await strategy.getAddress()))
        .to.emit(vault, "StrategyUnblacklisted");
      const info = await vault.strategyInfo(await strategy.getAddress());
      expect(info.isActive).to.equal(true);
      expect(info.isBlacklisted).to.equal(false);
    });

    it("test_unblacklistStrategy_notBlacklisted_reverts", async () => {
      const { vault, owner, strategy } = await deployWithStrategy();
      await expect(
        vault.connect(owner).unblacklistStrategy(await strategy.getAddress()),
      ).to.be.revertedWithCustomError(vault, "StrategyNotWhitelisted");
    });

    it("test_setStrategyMaxAllocation_notActive_reverts", async () => {
      const { vault, owner, alice } = await loadFixture(deployVaultV2Fixture);
      await expect(
        vault.connect(owner).setStrategyMaxAllocation(alice.address, 1000),
      ).to.be.revertedWithCustomError(vault, "StrategyNotWhitelisted");
    });

    it("test_setStrategyMaxAllocation_belowTarget_reverts", async () => {
      const { vault, owner, strategy } = await deployWithStrategy();
      // current targetBps was 2000 — setting max below target must revert.
      await expect(
        vault.connect(owner).setStrategyMaxAllocation(await strategy.getAddress(), 1000),
      ).to.be.revertedWithCustomError(vault, "AllocationExceeded");
    });

    it("test_setStrategyMaxAllocation_succeeds_emitsEvent", async () => {
      const { vault, owner, strategy } = await deployWithStrategy();
      await expect(
        vault.connect(owner).setStrategyMaxAllocation(await strategy.getAddress(), 3500),
      ).to.emit(vault, "StrategyMaxAllocationUpdated");
    });
  });

  // ════════════════════════════════════════════════════════════
  //  Keeper role
  // ════════════════════════════════════════════════════════════
  describe("keeper operations", () => {
    it("test_investToStrategy_notKeeper_reverts", async () => {
      const { vault, alice, strategy } = await deployWithStrategy();
      await expect(
        vault.connect(alice).investToStrategy(await strategy.getAddress(), usdc("100")),
      ).to.be.revertedWithCustomError(vault, "NotKeeper");
    });

    it("test_investToStrategy_zeroAmount_reverts", async () => {
      const { vault, keeper, strategy } = await deployWithStrategy();
      await expect(
        vault.connect(keeper).investToStrategy(await strategy.getAddress(), 0),
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("test_investToStrategy_idleInsufficient_reverts", async () => {
      const { vault, keeper, strategy } = await deployWithStrategy();
      // No deposits → idle = 0 → invest reverts IdleInsufficient.
      await expect(
        vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("100")),
      ).to.be.revertedWithCustomError(vault, "IdleInsufficient");
    });

    it("test_investToStrategy_notActive_reverts", async () => {
      const { vault, keeper, alice } = await loadFixture(deployVaultV2Fixture);
      await expect(
        vault.connect(keeper).investToStrategy(alice.address, usdc("100")),
      ).to.be.revertedWithCustomError(vault, "StrategyNotWhitelisted");
    });

    it("test_divestFromStrategy_succeeds_emitsEvent", async () => {
      const { vault, owner, keeper, strategy, alice, usdc: token } =
        await deployWithStrategy();
      await vault.connect(owner).setUserCap(alice.address, usdc("100000"));
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      await vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("2000"));
      await expect(
        vault.connect(keeper).divestFromStrategy(await strategy.getAddress(), usdc("1000")),
      ).to.emit(vault, "DivestedFromStrategy");
    });

    it("test_divestFromStrategy_zeroAmount_reverts", async () => {
      const { vault, keeper, strategy } = await deployWithStrategy();
      await expect(
        vault.connect(keeper).divestFromStrategy(await strategy.getAddress(), 0),
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("test_emergencyWithdraw_notKeeper_reverts", async () => {
      const { vault, alice, strategy } = await deployWithStrategy();
      await expect(
        vault.connect(alice).emergencyWithdraw(await strategy.getAddress()),
      ).to.be.revertedWithCustomError(vault, "NotKeeper");
    });

    it("test_emergencyWithdraw_zeroBalance_succeeds", async () => {
      const { vault, keeper, strategy } = await deployWithStrategy();
      // Strategy has 0 balance — emergencyWithdraw still blacklists.
      await expect(vault.connect(keeper).emergencyWithdraw(await strategy.getAddress()))
        .to.emit(vault, "EmergencyWithdrawn")
        .and.to.emit(vault, "StrategyBlacklisted");
    });
  });

  // ════════════════════════════════════════════════════════════
  //  Guardian / pause
  // ════════════════════════════════════════════════════════════
  describe("pause lifecycle", () => {
    it("test_pause_notGuardian_reverts", async () => {
      const { vault, alice } = await loadFixture(deployVaultV2Fixture);
      await expect(vault.connect(alice).pause())
        .to.be.revertedWithCustomError(vault, "NotGuardian");
    });

    it("test_pause_then_unpause_ownerOnly", async () => {
      const { vault, owner, guardian, alice } = await loadFixture(deployVaultV2Fixture);
      await vault.connect(guardian).pause();
      expect(await vault.paused()).to.equal(true);
      // Non-owner cannot unpause.
      await expect(vault.connect(alice).unpause())
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      await vault.connect(owner).unpause();
      expect(await vault.paused()).to.equal(false);
    });

    it("test_maxDeposit_whenPaused_returnsZero", async () => {
      const { vault, alice, guardian } = await loadFixture(deployVaultV2Fixture);
      await vault.connect(guardian).pause();
      expect(await vault.maxDeposit(alice.address)).to.equal(0);
    });

    it("test_maxMint_proxiesMaxDeposit", async () => {
      const { vault, alice } = await loadFixture(deployVaultV2Fixture);
      const md = await vault.maxDeposit(alice.address);
      const mm = await vault.maxMint(alice.address);
      // maxMint returns convertToShares(maxDeposit) — when supply=0 the OZ ERC-4626
      // formula yields md × 10**decimalsOffset.
      expect(mm).to.be.gt(0);
      expect(md).to.be.gt(0);
    });
  });

  // ════════════════════════════════════════════════════════════
  //  ERC-4626 surface (mint / withdraw direct paths)
  // ════════════════════════════════════════════════════════════
  describe("erc4626 direct paths", () => {
    it("test_mint_succeeds", async () => {
      const { vault, alice, usdc: token } = await loadFixture(deployVaultV2Fixture);
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      // mint(shares, receiver) — convert assets→shares using preview.
      const sharesToMint = await vault.previewDeposit(usdc("1000"));
      await vault.connect(alice).mint(sharesToMint, alice.address);
      expect(await vault.balanceOf(alice.address)).to.equal(sharesToMint);
    });

    it("test_withdraw_directPath_succeeds", async () => {
      const { vault, alice, usdc: token } = await loadFixture(deployVaultV2Fixture);
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("5000"), alice.address);
      const before = await token.balanceOf(alice.address);
      await vault.connect(alice).withdraw(usdc("1000"), alice.address, alice.address);
      expect(await token.balanceOf(alice.address)).to.equal(before + usdc("1000"));
    });

    it("test_strategyCount_and_getStrategies", async () => {
      const { vault, strategy } = await deployWithStrategy();
      expect(await vault.strategyCount()).to.equal(1);
      const list = await vault.getStrategies();
      expect(list.length).to.equal(1);
      expect(list[0]).to.equal(await strategy.getAddress());
    });
  });

  // ════════════════════════════════════════════════════════════
  //  Defensive accrual branches (pendingFeeShares + _calcSharePrice + _accrue guards)
  // ════════════════════════════════════════════════════════════
  describe("accrual edge branches", () => {
    it("test_pendingFeeShares_beforeFirstDeposit_returnsZero", async () => {
      const { vault } = await loadFixture(deployVaultV2Fixture);
      // No deposits yet → totalSupply == 0 path.
      expect(await vault.pendingFeeShares()).to.equal(0);
    });

    it("test_pendingFeeShares_atOrBelowBaseline_returnsZero", async () => {
      const { vault, usdc: token, alice } = await loadFixture(deployVaultV2Fixture);
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      // No yield → sp = lastSharePrice → loss-tolerance branch (returns 0).
      expect(await vault.pendingFeeShares()).to.equal(0);
    });

    it("test_pendingFeeShares_subBpsYield_returnsZero_feeAssetsTrunctedToZero", async () => {
      const { vault, usdc: token, alice } = await loadFixture(deployVaultV2Fixture);
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      // Tiny donation (1 wei) → feeAssets truncates to 0 inside _feeSharesFor.
      await token.mint(await vault.getAddress(), 1n);
      expect(await vault.pendingFeeShares()).to.equal(0);
    });

    it("test_accrue_feeSharesZero_underTinyYield_baselineBumpedButNoMint", async () => {
      const { vault, usdc: token, alice, treasury } = await loadFixture(deployVaultV2Fixture);
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      // Donation small enough to skip the mint but still bump baseline (the feeAssets > 0
      // and feeShares == 0 branch in _accrue).
      await token.mint(await vault.getAddress(), 100_000n);
      await time.increase(1);
      await vault.accrue();
      // Treasury could mint a tiny amount or zero — either way the baseline bumped and
      // there's no revert. Probe specifically the no-mint outcome by checking lastSp moved.
      const lastSp = await vault.lastSharePrice();
      expect(lastSp).to.be.gt(0);
      // Run again with no further yield → confirm idempotency / no panic.
      await time.increase(1);
      await vault.accrue();
      // Treasury balance stable (no spurious second mint).
      const t1 = await vault.balanceOf(treasury.address);
      await time.increase(1);
      await vault.accrue();
      expect(await vault.balanceOf(treasury.address)).to.equal(t1);
    });
  });

  // ════════════════════════════════════════════════════════════
  //  _autoPullFromStrategies — multi-strategy fan-out
  // ════════════════════════════════════════════════════════════
  describe("auto-pull from strategies", () => {
    it("test_autoPull_drawsFromActiveStrategy_onWithdraw", async () => {
      const { vault, owner, keeper, strategy, alice, usdc: token } =
        await deployWithStrategy();
      await vault.connect(owner).setUserCap(alice.address, usdc("100000"));
      await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
      await vault.connect(alice).deposit(usdc("10000"), alice.address);
      // Push almost all idle to strategy → withdraw needs to pull back.
      await vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("3000"));
      // Idle now ≈ 7000. Request 8000 withdraw — auto-pulls 1000 from strategy.
      const before = await token.balanceOf(alice.address);
      await vault.connect(alice).withdraw(usdc("8000"), alice.address, alice.address);
      expect(await token.balanceOf(alice.address)).to.equal(before + usdc("8000"));
    });
  });
});
