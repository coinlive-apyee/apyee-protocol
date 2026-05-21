import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import {
  BETA_DEPOSIT_CAP,
  BETA_DEFAULT_USER_CAP,
  DEFAULT_FEE_RATE,
  TEST_VERSION_HASH,
  TEST_STRATEGY_VERSION_HASH,
} from "../fixtures/deployVault";

const usdc = (n: string) => ethers.parseUnits(n, 6);

const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
const RATE_SCALE_TO_BPS = 10n ** 14n;

/// Helper: convert "5% APR" to per-second rate scaled 1e18 (Compound V3 convention).
/// 5% APR / SECONDS_PER_YEAR → fraction per second; × 1e18 to scale.
function aprBpsToPerSecondRate(aprBps: bigint): bigint {
  // perSecond * SECONDS_PER_YEAR / 1e14 = aprBps
  // → perSecond = aprBps * 1e14 / SECONDS_PER_YEAR
  return (aprBps * RATE_SCALE_TO_BPS) / SECONDS_PER_YEAR;
}

describe("CompoundV3Strategy", () => {
  async function deployCompoundStack() {
    const [owner, keeper, guardian, treasury, alice] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const token = await MockUSDC.deploy();
    await token.waitForDeployment();

    // 5% APR, 50% utilization defaults
    const MockComet = await ethers.getContractFactory("MockComet");
    const comet = await MockComet.deploy(
      await token.getAddress(),
      aprBpsToPerSecondRate(500n), // 5% APR per-second
      ethers.parseUnits("5", 17), // 50% utilization (5e17, since 1e18 = 100%)
    );
    await comet.waitForDeployment();

    const Vault = await ethers.getContractFactory("Vault");
    const vault = await Vault.deploy(
      await token.getAddress(),
      "Apyee USDC Vault",
      "apUSDC",
      owner.address,
      keeper.address,
      guardian.address,
      treasury.address,
      DEFAULT_FEE_RATE,
      BETA_DEPOSIT_CAP,
      BETA_DEFAULT_USER_CAP,
      TEST_VERSION_HASH,
    );
    await vault.waitForDeployment();

    const CompStrategy = await ethers.getContractFactory("CompoundV3Strategy");
    const compStrategy = await CompStrategy.deploy(
      await vault.getAddress(),
      await token.getAddress(),
      await comet.getAddress(),
      TEST_STRATEGY_VERSION_HASH,
    );
    await compStrategy.waitForDeployment();

    await vault.connect(owner).addStrategy(
      await compStrategy.getAddress(),
      3000,
      4000,
    );

    await token.mint(alice.address, usdc("100000"));
    await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);

    return {
      vault,
      token,
      comet,
      compStrategy,
      owner,
      keeper,
      guardian,
      treasury,
      alice,
    };
  }

  // ─────────────────────────────────────────────────────────────
  describe("constructor + immutables", () => {
    it("test_constructor_setsImmutables", async () => {
      const { compStrategy, vault, token, comet } = await loadFixture(deployCompoundStack);
      expect(await compStrategy.vault()).to.equal(await vault.getAddress());
      expect(await compStrategy.asset()).to.equal(await token.getAddress());
      expect(await compStrategy.comet()).to.equal(await comet.getAddress());
    });

    it("test_constructor_setsInfiniteApprovalToComet", async () => {
      const { compStrategy, token, comet } = await loadFixture(deployCompoundStack);
      const allowance = await token.allowance(
        await compStrategy.getAddress(),
        await comet.getAddress(),
      );
      expect(allowance).to.equal(ethers.MaxUint256);
    });

    it("test_constructor_zeroComet_reverts", async () => {
      const [owner] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();
      const Comp = await ethers.getContractFactory("CompoundV3Strategy");
      await expect(
        Comp.deploy(owner.address, await token.getAddress(), ethers.ZeroAddress, TEST_STRATEGY_VERSION_HASH),
      ).to.be.revertedWithCustomError(Comp, "ZeroAddress");
    });

    it("test_constructor_baseTokenMismatch_reverts", async () => {
      // Deploy a Comet with a DIFFERENT base token, then try to wire it as a USDC strategy.
      const [owner] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdcA = await MockUSDC.deploy();
      const usdcB = await MockUSDC.deploy(); // pretend a different stablecoin

      const MockComet = await ethers.getContractFactory("MockComet");
      const wrongComet = await MockComet.deploy(
        await usdcB.getAddress(),
        0n,
        0n,
      );

      const Comp = await ethers.getContractFactory("CompoundV3Strategy");
      await expect(
        Comp.deploy(owner.address, await usdcA.getAddress(), await wrongComet.getAddress(), TEST_STRATEGY_VERSION_HASH),
      ).to.be.revertedWithCustomError(Comp, "AssetMismatch");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("deposit / withdraw / emergencyWithdraw via Vault", () => {
    it("test_invest_suppliesUsdcAndIncreasesBalance", async () => {
      const { vault, keeper, compStrategy, comet, token } =
        await loadFixture(deployCompoundStack);

      await vault
        .connect(keeper)
        .investToStrategy(await compStrategy.getAddress(), usdc("3000"));

      expect(await token.balanceOf(await comet.getAddress())).to.equal(usdc("3000"));
      expect(await compStrategy.balanceOf()).to.equal(usdc("3000"));
    });

    it("test_invest_byDirectCallToStrategy_reverts", async () => {
      const { compStrategy, alice } = await loadFixture(deployCompoundStack);
      await expect(
        compStrategy.connect(alice).deposit(usdc("100")),
      ).to.be.revertedWithCustomError(compStrategy, "NotVault");
    });

    it("test_withdraw_returnsUsdcToVault", async () => {
      const { vault, keeper, compStrategy, token } = await loadFixture(deployCompoundStack);

      await vault
        .connect(keeper)
        .investToStrategy(await compStrategy.getAddress(), usdc("3000"));
      await vault
        .connect(keeper)
        .divestFromStrategy(await compStrategy.getAddress(), usdc("1000"));

      expect(await compStrategy.balanceOf()).to.equal(usdc("2000"));
      expect(await token.balanceOf(await vault.getAddress())).to.equal(usdc("8000"));
    });

    it("test_emergencyWithdraw_drainsAllAndBlacklists", async () => {
      const { vault, keeper, compStrategy, token } = await loadFixture(deployCompoundStack);

      await vault
        .connect(keeper)
        .investToStrategy(await compStrategy.getAddress(), usdc("3000"));

      await vault
        .connect(keeper)
        .emergencyWithdraw(await compStrategy.getAddress(), "test");

      expect(await compStrategy.balanceOf()).to.equal(0);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(usdc("10000"));

      const info = await vault.strategyInfo(await compStrategy.getAddress());
      expect(info.isBlacklisted).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("yield accrual + harvest", () => {
    it("test_balanceOf_increasesAfterYield", async () => {
      const { vault, keeper, compStrategy, comet, token } =
        await loadFixture(deployCompoundStack);

      await vault
        .connect(keeper)
        .investToStrategy(await compStrategy.getAddress(), usdc("3000"));
      const before = await compStrategy.balanceOf();

      // Mock interest: top up Comet's USDC cash + bump strategy's recorded balance.
      await token.mint(await comet.getAddress(), usdc("30"));
      await comet.simulateYield(await compStrategy.getAddress(), usdc("30"));

      expect(await compStrategy.balanceOf()).to.equal(before + usdc("30"));
    });

    it("test_harvest_compoundYield_mintsFeeShares", async () => {
      const { vault, keeper, compStrategy, comet, treasury, token } =
        await loadFixture(deployCompoundStack);

      await vault
        .connect(keeper)
        .investToStrategy(await compStrategy.getAddress(), usdc("3000"));

      await token.mint(await comet.getAddress(), usdc("300"));
      await comet.simulateYield(await compStrategy.getAddress(), usdc("300"));

      await vault.connect(keeper).harvest();

      const treasuryShares = await vault.balanceOf(treasury.address);
      const treasuryAssets = await vault.convertToAssets(treasuryShares);
      // 15% of $300 yield = $45 (±$1 rounding).
      expect(treasuryAssets).to.be.closeTo(usdc("45"), usdc("1"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("currentAPY", () => {
    it("test_currentAPY_returns500BpsForFivePercent", async () => {
      const { compStrategy } = await loadFixture(deployCompoundStack);
      // Default fixture seeds 5% APR. Verify the per-second × SECONDS_PER_YEAR / 1e14 conversion.
      // Allow ±1 bp drift from integer truncation in `aprBpsToPerSecondRate`.
      const apy = await compStrategy.currentAPY();
      expect(apy).to.be.closeTo(500n, 1n);
    });

    it("test_currentAPY_updatesWhenSupplyRateChanges", async () => {
      const { compStrategy, comet } = await loadFixture(deployCompoundStack);
      // Bump to 7.5% APR.
      await comet.setSupplyRate(aprBpsToPerSecondRate(750n));
      const apy = await compStrategy.currentAPY();
      expect(apy).to.be.closeTo(750n, 1n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("withdrawalDelay + harvestable defaults", () => {
    it("test_withdrawalDelay_isZero", async () => {
      const { compStrategy } = await loadFixture(deployCompoundStack);
      expect(await compStrategy.withdrawalDelay()).to.equal(0);
    });

    it("test_harvestable_returnsZero", async () => {
      const { compStrategy } = await loadFixture(deployCompoundStack);
      expect(await compStrategy.harvestable()).to.equal(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("test_emergencyWithdraw_zeroBalance_returnsZero", async () => {
      const { vault, keeper, compStrategy } = await loadFixture(deployCompoundStack);
      // Strategy added but no invest → comet balance 0 → early-return inside _emergencyWithdraw.
      await expect(
        vault.connect(keeper).emergencyWithdraw(await compStrategy.getAddress(), "empty"),
      ).to.emit(vault, "EmergencyWithdrawal");
      expect(await compStrategy.balanceOf()).to.equal(0);
    });
  });
});
