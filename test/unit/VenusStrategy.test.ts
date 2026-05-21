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

const BLOCKS_PER_YEAR = 10_512_000n;
const RATE_SCALE_TO_BPS = 10n ** 14n;

/// Helper: convert APR (in bps) to per-block rate scaled 1e18 (Venus convention).
/// perBlockRate * BLOCKS_PER_YEAR / 1e14 = APR_bps
/// → perBlockRate = APR_bps × 1e14 / BLOCKS_PER_YEAR
function aprBpsToPerBlockRate(aprBps: bigint): bigint {
  return (aprBps * RATE_SCALE_TO_BPS) / BLOCKS_PER_YEAR;
}

describe("VenusStrategy", () => {
  async function deployVenusStack() {
    const [owner, keeper, guardian, treasury, alice] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const token = await MockUSDC.deploy();
    await token.waitForDeployment();

    // exchangeRate = 1e18 (1:1 vToken ↔ underlying), supplyRate = 5% APR.
    const MockVToken = await ethers.getContractFactory("MockVToken");
    const vToken = await MockVToken.deploy(
      await token.getAddress(),
      ethers.parseUnits("1", 18),
      aprBpsToPerBlockRate(500n),
    );
    await vToken.waitForDeployment();

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

    const VenusStrategy = await ethers.getContractFactory("VenusStrategy");
    const venusStrategy = await VenusStrategy.deploy(
      await vault.getAddress(),
      await token.getAddress(),
      await vToken.getAddress(),
      TEST_STRATEGY_VERSION_HASH,
    );
    await venusStrategy.waitForDeployment();

    await vault.connect(owner).addStrategy(
      await venusStrategy.getAddress(),
      3000,
      4000,
    );

    await token.mint(alice.address, usdc("100000"));
    await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);

    return {
      vault,
      token,
      vToken,
      venusStrategy,
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
      const { venusStrategy, vault, token, vToken } = await loadFixture(deployVenusStack);
      expect(await venusStrategy.vault()).to.equal(await vault.getAddress());
      expect(await venusStrategy.asset()).to.equal(await token.getAddress());
      expect(await venusStrategy.vToken()).to.equal(await vToken.getAddress());
    });

    it("test_constructor_setsInfiniteApprovalToVToken", async () => {
      const { venusStrategy, token, vToken } = await loadFixture(deployVenusStack);
      const allowance = await token.allowance(
        await venusStrategy.getAddress(),
        await vToken.getAddress(),
      );
      expect(allowance).to.equal(ethers.MaxUint256);
    });

    it("test_constructor_zeroVToken_reverts", async () => {
      const [owner] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();
      const Venus = await ethers.getContractFactory("VenusStrategy");
      await expect(
        Venus.deploy(owner.address, await token.getAddress(), ethers.ZeroAddress, TEST_STRATEGY_VERSION_HASH),
      ).to.be.revertedWithCustomError(Venus, "ZeroAddress");
    });

    it("test_constructor_assetMismatch_reverts", async () => {
      // vToken with a different underlying → adapter must reject at deploy.
      const [owner] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdcA = await MockUSDC.deploy();
      const usdcB = await MockUSDC.deploy();

      const MockVToken = await ethers.getContractFactory("MockVToken");
      const wrongVToken = await MockVToken.deploy(
        await usdcB.getAddress(),
        ethers.parseUnits("1", 18),
        0n,
      );

      const Venus = await ethers.getContractFactory("VenusStrategy");
      await expect(
        Venus.deploy(owner.address, await usdcA.getAddress(), await wrongVToken.getAddress(), TEST_STRATEGY_VERSION_HASH),
      ).to.be.revertedWithCustomError(Venus, "AssetMismatch");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("deposit / withdraw / emergencyWithdraw via Vault", () => {
    it("test_invest_suppliesUsdcAndIncreasesBalance", async () => {
      const { vault, keeper, venusStrategy, vToken, token } =
        await loadFixture(deployVenusStack);

      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdc("3000"),
      );

      // exchangeRate = 1e18 → 1:1, so vToken balance == underlying balance.
      expect(await token.balanceOf(await vToken.getAddress())).to.equal(usdc("3000"));
      expect(await venusStrategy.balanceOf()).to.equal(usdc("3000"));
    });

    it("test_invest_byDirectCallToStrategy_reverts", async () => {
      const { venusStrategy, alice } = await loadFixture(deployVenusStack);
      await expect(
        venusStrategy.connect(alice).deposit(usdc("100")),
      ).to.be.revertedWithCustomError(venusStrategy, "NotVault");
    });

    it("test_invest_whenVTokenMintFails_revertsWithProtocolCallFailed", async () => {
      const { vault, keeper, venusStrategy, vToken } = await loadFixture(deployVenusStack);
      // Force the mock vToken's mint to return a non-zero error code.
      await vToken.setMintFails(true);
      await expect(
        vault.connect(keeper).investToStrategy(
          await venusStrategy.getAddress(),
          usdc("100"),
        ),
      ).to.be.revertedWithCustomError(venusStrategy, "ProtocolCallFailed");
    });

    it("test_withdraw_returnsUsdcToVault", async () => {
      const { vault, keeper, venusStrategy, token } = await loadFixture(deployVenusStack);

      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdc("3000"),
      );
      await vault.connect(keeper).divestFromStrategy(
        await venusStrategy.getAddress(),
        usdc("1000"),
      );

      expect(await venusStrategy.balanceOf()).to.equal(usdc("2000"));
      expect(await token.balanceOf(await vault.getAddress())).to.equal(usdc("8000"));
    });

    it("test_emergencyWithdraw_drainsAllAndBlacklists", async () => {
      const { vault, keeper, venusStrategy, token } = await loadFixture(deployVenusStack);

      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdc("3000"),
      );

      await vault
        .connect(keeper)
        .emergencyWithdraw(await venusStrategy.getAddress(), "test");

      expect(await venusStrategy.balanceOf()).to.equal(0);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(usdc("10000"));

      const info = await vault.strategyInfo(await venusStrategy.getAddress());
      expect(info.isBlacklisted).to.equal(true);
    });

    it("test_emergencyWithdraw_zeroBalance_returnsZero", async () => {
      const { vault, keeper, venusStrategy } = await loadFixture(deployVenusStack);
      // Strategy added but never invested → vToken balance is 0 → early return.
      await expect(
        vault.connect(keeper).emergencyWithdraw(await venusStrategy.getAddress(), "empty"),
      ).to.emit(vault, "EmergencyWithdrawal");
      expect(await venusStrategy.balanceOf()).to.equal(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("yield accrual + harvest", () => {
    it("test_balanceOf_increasesAfterYield", async () => {
      const { vault, keeper, venusStrategy, vToken, token } =
        await loadFixture(deployVenusStack);

      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdc("3000"),
      );
      const before = await venusStrategy.balanceOf();

      // Yield: bump vToken balance + fund pool with USDC so future redeem can settle.
      await token.mint(await vToken.getAddress(), usdc("30"));
      await vToken.simulateYield(await venusStrategy.getAddress(), usdc("30"));

      expect(await venusStrategy.balanceOf()).to.equal(before + usdc("30"));
    });

    it("test_balanceOf_reflectsExchangeRateChange", async () => {
      // Compound V2 fork interest model: as the pool earns, exchangeRate grows.
      // vBalance unchanged but underlying balance grows pro rata.
      const { vault, keeper, venusStrategy, vToken } = await loadFixture(deployVenusStack);

      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdc("3000"),
      );
      const before = await venusStrategy.balanceOf(); // 3000e6

      // Bump exchange rate by 1% — strategy's underlying balance grows by 1%.
      await vToken.setExchangeRate(ethers.parseUnits("1.01", 18));

      const after = await venusStrategy.balanceOf();
      // 3000 × 1.01 = 3030
      expect(after).to.be.closeTo(usdc("3030"), 100n); // ±0.01% tolerance
    });

    it("test_harvest_venusYield_mintsFeeShares", async () => {
      const { vault, keeper, venusStrategy, vToken, treasury, token } =
        await loadFixture(deployVenusStack);

      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdc("3000"),
      );

      // $300 yield → 15% fee = $45.
      await token.mint(await vToken.getAddress(), usdc("300"));
      await vToken.simulateYield(await venusStrategy.getAddress(), usdc("300"));

      await vault.connect(keeper).harvest();

      const treasuryShares = await vault.balanceOf(treasury.address);
      const treasuryAssets = await vault.convertToAssets(treasuryShares);
      expect(treasuryAssets).to.be.closeTo(usdc("45"), usdc("1"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("currentAPY", () => {
    it("test_currentAPY_returns500BpsForFivePercent", async () => {
      const { venusStrategy } = await loadFixture(deployVenusStack);
      // Default fixture seeds 5% APR. Verify per-block × BLOCKS_PER_YEAR / 1e14 conversion.
      const apy = await venusStrategy.currentAPY();
      expect(apy).to.be.closeTo(500n, 1n);
    });

    it("test_currentAPY_updatesWhenSupplyRateChanges", async () => {
      const { venusStrategy, vToken } = await loadFixture(deployVenusStack);
      await vToken.setSupplyRatePerBlock(aprBpsToPerBlockRate(800n));
      const apy = await venusStrategy.currentAPY();
      expect(apy).to.be.closeTo(800n, 1n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("withdrawalDelay + harvestable defaults", () => {
    it("test_withdrawalDelay_isZero", async () => {
      const { venusStrategy } = await loadFixture(deployVenusStack);
      expect(await venusStrategy.withdrawalDelay()).to.equal(0);
    });

    it("test_harvestable_returnsZero", async () => {
      const { venusStrategy } = await loadFixture(deployVenusStack);
      expect(await venusStrategy.harvestable()).to.equal(0);
    });
  });
});
