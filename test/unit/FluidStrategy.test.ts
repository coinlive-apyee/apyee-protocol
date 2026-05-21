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

describe("FluidStrategy", () => {
  async function deployFluidStack() {
    const [owner, keeper, guardian, treasury, alice] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const token = await MockUSDC.deploy();
    await token.waitForDeployment();

    // Fluid fToken is a plain ERC-4626 vault — same shape as MetaMorpho, so we reuse
    // MockMetaMorphoVault as a generic ERC-4626 stand-in for fUSDC.
    const MockERC4626 = await ethers.getContractFactory("MockMetaMorphoVault");
    const fluidVault = await MockERC4626.deploy(await token.getAddress());
    await fluidVault.waitForDeployment();

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

    const FluidStrategy = await ethers.getContractFactory("FluidStrategy");
    const fluidStrategy = await FluidStrategy.deploy(
      await vault.getAddress(),
      await token.getAddress(),
      await fluidVault.getAddress(),
      TEST_STRATEGY_VERSION_HASH,
    );
    await fluidStrategy.waitForDeployment();

    await vault.connect(owner).addStrategy(
      await fluidStrategy.getAddress(),
      3000,
      4000,
    );

    await token.mint(alice.address, usdc("100000"));
    await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);

    return {
      vault,
      token,
      fluidVault,
      fluidStrategy,
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
      const { fluidStrategy, vault, token, fluidVault } = await loadFixture(deployFluidStack);
      expect(await fluidStrategy.vault()).to.equal(await vault.getAddress());
      expect(await fluidStrategy.asset()).to.equal(await token.getAddress());
      expect(await fluidStrategy.fluidVault()).to.equal(await fluidVault.getAddress());
    });

    it("test_constructor_setsInfiniteApprovalToFluidVault", async () => {
      const { fluidStrategy, token, fluidVault } = await loadFixture(deployFluidStack);
      const allowance = await token.allowance(
        await fluidStrategy.getAddress(),
        await fluidVault.getAddress(),
      );
      expect(allowance).to.equal(ethers.MaxUint256);
    });

    it("test_constructor_zeroFluidVault_reverts", async () => {
      const [owner] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();
      const Fluid = await ethers.getContractFactory("FluidStrategy");
      await expect(
        Fluid.deploy(owner.address, await token.getAddress(), ethers.ZeroAddress, TEST_STRATEGY_VERSION_HASH),
      ).to.be.revertedWithCustomError(Fluid, "ZeroAddress");
    });

    it("test_constructor_assetMismatch_reverts", async () => {
      // fToken with a different underlying.
      const [owner] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdcA = await MockUSDC.deploy();
      const usdcB = await MockUSDC.deploy();

      const MockERC4626 = await ethers.getContractFactory("MockMetaMorphoVault");
      const wrongVault = await MockERC4626.deploy(await usdcB.getAddress());

      const Fluid = await ethers.getContractFactory("FluidStrategy");
      await expect(
        Fluid.deploy(owner.address, await usdcA.getAddress(), await wrongVault.getAddress(), TEST_STRATEGY_VERSION_HASH),
      ).to.be.revertedWithCustomError(Fluid, "AssetMismatch");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("deposit / withdraw / emergencyWithdraw via Vault", () => {
    it("test_invest_depositsIntoFluidAndReceivesShares", async () => {
      const { vault, keeper, fluidStrategy, fluidVault, token } =
        await loadFixture(deployFluidStack);

      await vault.connect(keeper).investToStrategy(
        await fluidStrategy.getAddress(),
        usdc("3000"),
      );

      // fToken holds the USDC.
      expect(await token.balanceOf(await fluidVault.getAddress())).to.equal(usdc("3000"));
      // Strategy received fToken shares (initial deposit, share price ≈ 1).
      const stratShares = await fluidVault.balanceOf(await fluidStrategy.getAddress());
      expect(stratShares).to.be.gt(0);
      // IStrategy.balanceOf reflects underlying.
      expect(await fluidStrategy.balanceOf()).to.be.closeTo(usdc("3000"), 10n);
    });

    it("test_invest_byDirectCallToStrategy_reverts", async () => {
      const { fluidStrategy, alice } = await loadFixture(deployFluidStack);
      await expect(
        fluidStrategy.connect(alice).deposit(usdc("100")),
      ).to.be.revertedWithCustomError(fluidStrategy, "NotVault");
    });

    it("test_withdraw_returnsUsdcToVault", async () => {
      const { vault, keeper, fluidStrategy, token } = await loadFixture(deployFluidStack);

      await vault.connect(keeper).investToStrategy(
        await fluidStrategy.getAddress(),
        usdc("3000"),
      );
      await vault.connect(keeper).divestFromStrategy(
        await fluidStrategy.getAddress(),
        usdc("1000"),
      );

      expect(await fluidStrategy.balanceOf()).to.be.closeTo(usdc("2000"), 10n);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(usdc("8000"));
    });

    it("test_emergencyWithdraw_drainsAllAndBlacklists", async () => {
      const { vault, keeper, fluidStrategy, token } = await loadFixture(deployFluidStack);

      await vault.connect(keeper).investToStrategy(
        await fluidStrategy.getAddress(),
        usdc("3000"),
      );

      await vault
        .connect(keeper)
        .emergencyWithdraw(await fluidStrategy.getAddress(), "test");

      expect(await fluidStrategy.balanceOf()).to.equal(0);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(usdc("10000"));

      const info = await vault.strategyInfo(await fluidStrategy.getAddress());
      expect(info.isBlacklisted).to.equal(true);
    });

    it("test_emergencyWithdraw_zeroBalance_returnsZero", async () => {
      const { vault, keeper, fluidStrategy } = await loadFixture(deployFluidStack);
      await expect(
        vault.connect(keeper).emergencyWithdraw(await fluidStrategy.getAddress(), "empty"),
      ).to.emit(vault, "EmergencyWithdrawal");
      expect(await fluidStrategy.balanceOf()).to.equal(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("yield accrual + harvest", () => {
    it("test_balanceOf_increasesAfterYield", async () => {
      const { vault, keeper, fluidStrategy, fluidVault, token, alice } =
        await loadFixture(deployFluidStack);

      await vault.connect(keeper).investToStrategy(
        await fluidStrategy.getAddress(),
        usdc("3000"),
      );
      const before = await fluidStrategy.balanceOf();

      // Inflate share price by transferring extra underlying into the fToken vault.
      // Alice donates $30 → vault's totalAssets grows but totalSupply unchanged.
      await token.connect(alice).approve(await fluidVault.getAddress(), usdc("30"));
      await fluidVault.connect(alice).simulateYield(usdc("30"));

      const after = await fluidStrategy.balanceOf();
      // Strategy holds 100% of shares (alice didn't deposit), so all $30 is reflected.
      expect(after).to.be.closeTo(before + usdc("30"), 10n);
    });

    it("test_harvest_fluidYield_mintsFeeShares", async () => {
      const { vault, keeper, fluidStrategy, fluidVault, treasury, token, alice } =
        await loadFixture(deployFluidStack);

      await vault.connect(keeper).investToStrategy(
        await fluidStrategy.getAddress(),
        usdc("3000"),
      );

      // $300 yield via share-price inflation.
      await token.connect(alice).approve(await fluidVault.getAddress(), usdc("300"));
      await fluidVault.connect(alice).simulateYield(usdc("300"));

      await vault.connect(keeper).harvest();

      const treasuryShares = await vault.balanceOf(treasury.address);
      const treasuryAssets = await vault.convertToAssets(treasuryShares);
      // 15% fee on $300 ≈ $45 (±$1 for rounding).
      expect(treasuryAssets).to.be.closeTo(usdc("45"), usdc("1"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("currentAPY + harvestable + withdrawalDelay", () => {
    it("test_currentAPY_returnsZero", async () => {
      // Fluid supply rate is computed off-chain (Keeper queries Fluid resolver / DeFiLlama).
      const { fluidStrategy } = await loadFixture(deployFluidStack);
      expect(await fluidStrategy.currentAPY()).to.equal(0);
    });

    it("test_harvestable_returnsZero", async () => {
      const { fluidStrategy } = await loadFixture(deployFluidStack);
      expect(await fluidStrategy.harvestable()).to.equal(0);
    });

    it("test_withdrawalDelay_isZero", async () => {
      const { fluidStrategy } = await loadFixture(deployFluidStack);
      expect(await fluidStrategy.withdrawalDelay()).to.equal(0);
    });
  });
});
