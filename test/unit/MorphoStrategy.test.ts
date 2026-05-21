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

describe("MorphoStrategy", () => {
  async function deployMorphoStack() {
    const [owner, keeper, guardian, treasury, alice] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const token = await MockUSDC.deploy();
    await token.waitForDeployment();

    // MetaMorpho is itself a plain ERC-4626. The mock just inherits OZ's ERC4626.
    const MockMetaMorpho = await ethers.getContractFactory("MockMetaMorphoVault");
    const morphoVault = await MockMetaMorpho.deploy(await token.getAddress());
    await morphoVault.waitForDeployment();

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

    const MorphoStrategy = await ethers.getContractFactory("MorphoStrategy");
    const morphoStrategy = await MorphoStrategy.deploy(
      await vault.getAddress(),
      await token.getAddress(),
      await morphoVault.getAddress(),
      TEST_STRATEGY_VERSION_HASH,
    );
    await morphoStrategy.waitForDeployment();

    await vault.connect(owner).addStrategy(
      await morphoStrategy.getAddress(),
      3000,
      4000,
    );

    await token.mint(alice.address, usdc("100000"));
    await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);

    return {
      vault,
      token,
      morphoVault,
      morphoStrategy,
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
      const { morphoStrategy, vault, token, morphoVault } =
        await loadFixture(deployMorphoStack);
      expect(await morphoStrategy.vault()).to.equal(await vault.getAddress());
      expect(await morphoStrategy.asset()).to.equal(await token.getAddress());
      expect(await morphoStrategy.morphoVault()).to.equal(await morphoVault.getAddress());
    });

    it("test_constructor_setsInfiniteApprovalToMorphoVault", async () => {
      const { morphoStrategy, token, morphoVault } = await loadFixture(deployMorphoStack);
      const allowance = await token.allowance(
        await morphoStrategy.getAddress(),
        await morphoVault.getAddress(),
      );
      expect(allowance).to.equal(ethers.MaxUint256);
    });

    it("test_constructor_zeroMorphoVault_reverts", async () => {
      const [owner] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();
      const Morpho = await ethers.getContractFactory("MorphoStrategy");
      await expect(
        Morpho.deploy(owner.address, await token.getAddress(), ethers.ZeroAddress, TEST_STRATEGY_VERSION_HASH),
      ).to.be.revertedWithCustomError(Morpho, "ZeroAddress");
    });

    it("test_constructor_assetMismatch_reverts", async () => {
      // MetaMorpho with a different underlying.
      const [owner] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdcA = await MockUSDC.deploy();
      const usdcB = await MockUSDC.deploy();

      const MockMetaMorpho = await ethers.getContractFactory("MockMetaMorphoVault");
      const wrongVault = await MockMetaMorpho.deploy(await usdcB.getAddress());

      const Morpho = await ethers.getContractFactory("MorphoStrategy");
      await expect(
        Morpho.deploy(owner.address, await usdcA.getAddress(), await wrongVault.getAddress(), TEST_STRATEGY_VERSION_HASH),
      ).to.be.revertedWithCustomError(Morpho, "AssetMismatch");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("deposit / withdraw / emergencyWithdraw via Vault", () => {
    it("test_invest_depositsIntoMetaMorphoAndReceivesShares", async () => {
      const { vault, keeper, morphoStrategy, morphoVault, token } =
        await loadFixture(deployMorphoStack);

      await vault.connect(keeper).investToStrategy(
        await morphoStrategy.getAddress(),
        usdc("3000"),
      );

      // MetaMorpho holds the USDC.
      expect(await token.balanceOf(await morphoVault.getAddress())).to.equal(usdc("3000"));
      // Strategy received MetaMorpho shares (initial deposit, share price ≈ 1).
      const stratShares = await morphoVault.balanceOf(await morphoStrategy.getAddress());
      expect(stratShares).to.be.gt(0);
      // IStrategy.balanceOf reflects underlying.
      expect(await morphoStrategy.balanceOf()).to.be.closeTo(usdc("3000"), 10n);
    });

    it("test_invest_byDirectCallToStrategy_reverts", async () => {
      const { morphoStrategy, alice } = await loadFixture(deployMorphoStack);
      await expect(
        morphoStrategy.connect(alice).deposit(usdc("100")),
      ).to.be.revertedWithCustomError(morphoStrategy, "NotVault");
    });

    it("test_withdraw_returnsUsdcToVault", async () => {
      const { vault, keeper, morphoStrategy, token } = await loadFixture(deployMorphoStack);

      await vault.connect(keeper).investToStrategy(
        await morphoStrategy.getAddress(),
        usdc("3000"),
      );
      await vault.connect(keeper).divestFromStrategy(
        await morphoStrategy.getAddress(),
        usdc("1000"),
      );

      expect(await morphoStrategy.balanceOf()).to.be.closeTo(usdc("2000"), 10n);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(usdc("8000"));
    });

    it("test_emergencyWithdraw_drainsAllAndBlacklists", async () => {
      const { vault, keeper, morphoStrategy, token } = await loadFixture(deployMorphoStack);

      await vault.connect(keeper).investToStrategy(
        await morphoStrategy.getAddress(),
        usdc("3000"),
      );

      await vault
        .connect(keeper)
        .emergencyWithdraw(await morphoStrategy.getAddress(), "test");

      expect(await morphoStrategy.balanceOf()).to.equal(0);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(usdc("10000"));

      const info = await vault.strategyInfo(await morphoStrategy.getAddress());
      expect(info.isBlacklisted).to.equal(true);
    });

    it("test_emergencyWithdraw_zeroBalance_returnsZero", async () => {
      const { vault, keeper, morphoStrategy } = await loadFixture(deployMorphoStack);
      await expect(
        vault.connect(keeper).emergencyWithdraw(await morphoStrategy.getAddress(), "empty"),
      ).to.emit(vault, "EmergencyWithdrawal");
      expect(await morphoStrategy.balanceOf()).to.equal(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("yield accrual + harvest", () => {
    it("test_balanceOf_increasesAfterYield", async () => {
      const { vault, keeper, morphoStrategy, morphoVault, token, alice } =
        await loadFixture(deployMorphoStack);

      await vault.connect(keeper).investToStrategy(
        await morphoStrategy.getAddress(),
        usdc("3000"),
      );
      const before = await morphoStrategy.balanceOf();

      // Inflate share price by transferring extra underlying into the MetaMorpho.
      // Alice donates $30 → MetaMorpho's totalAssets grows but totalSupply unchanged.
      await token.connect(alice).approve(await morphoVault.getAddress(), usdc("30"));
      await morphoVault.connect(alice).simulateYield(usdc("30"));

      const after = await morphoStrategy.balanceOf();
      // Strategy holds 100% of shares (alice didn't deposit), so all $30 is reflected.
      expect(after).to.be.closeTo(before + usdc("30"), 10n);
    });

    it("test_harvest_morphoYield_mintsFeeShares", async () => {
      const { vault, keeper, morphoStrategy, morphoVault, treasury, token, alice } =
        await loadFixture(deployMorphoStack);

      await vault.connect(keeper).investToStrategy(
        await morphoStrategy.getAddress(),
        usdc("3000"),
      );

      // $300 yield via share-price inflation.
      await token.connect(alice).approve(await morphoVault.getAddress(), usdc("300"));
      await morphoVault.connect(alice).simulateYield(usdc("300"));

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
      // MetaMorpho APR is computed off-chain (Keeper queries DeFiLlama / Morpho subgraph).
      const { morphoStrategy } = await loadFixture(deployMorphoStack);
      expect(await morphoStrategy.currentAPY()).to.equal(0);
    });

    it("test_harvestable_returnsZero", async () => {
      const { morphoStrategy } = await loadFixture(deployMorphoStack);
      expect(await morphoStrategy.harvestable()).to.equal(0);
    });

    it("test_withdrawalDelay_isZero", async () => {
      const { morphoStrategy } = await loadFixture(deployMorphoStack);
      expect(await morphoStrategy.withdrawalDelay()).to.equal(0);
    });
  });
});
