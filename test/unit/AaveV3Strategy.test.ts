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

/// Aave V3 Strategy unit tests using a mock Pool + mock aToken (no fork required).
/// Mainnet fork integration tests live separately in test/integration/.
describe("AaveV3Strategy", () => {
  async function deployAaveStack() {
    const [owner, keeper, guardian, treasury, alice] = await ethers.getSigners();

    // 1. Underlying (USDC mock).
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const token = await MockUSDC.deploy();
    await token.waitForDeployment();

    // 2. Mock Aave Pool + aToken (12 decimals = USDC 6 + offset 6 not relevant here;
    //    aToken should match underlying decimals = 6).
    const MockAavePool = await ethers.getContractFactory("MockAavePool");
    const aavePool = await MockAavePool.deploy();
    await aavePool.waitForDeployment();

    const MockAToken = await ethers.getContractFactory("MockAToken");
    const aToken = await MockAToken.deploy(
      "Mock aUSDC",
      "aUSDC",
      6,
      await aavePool.getAddress(),
    );
    await aToken.waitForDeployment();

    // Wire pool reserve: USDC → aUSDC, currentLiquidityRate = 5% APR in RAY (5e25).
    await aavePool.setReserve(
      await token.getAddress(),
      await aToken.getAddress(),
      ethers.parseUnits("5", 25), // 5e25 RAY = 5% APR
    );

    // 3. Vault.
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

    // 4. AaveV3Strategy.
    const AaveStrategy = await ethers.getContractFactory("AaveV3Strategy");
    const aaveStrategy = await AaveStrategy.deploy(
      await vault.getAddress(),
      await token.getAddress(),
      await aavePool.getAddress(),
      await aToken.getAddress(),
      TEST_STRATEGY_VERSION_HASH,
    );
    await aaveStrategy.waitForDeployment();

    // 5. Register strategy with vault (target 30%, cap 40%).
    await vault.connect(owner).addStrategy(
      await aaveStrategy.getAddress(),
      3000,
      4000,
    );

    // 6. Fund alice and have her deposit $10K.
    await token.mint(alice.address, usdc("100000"));
    await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);

    return {
      vault,
      token,
      aavePool,
      aToken,
      aaveStrategy,
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
      const { aaveStrategy, vault, token, aavePool, aToken } =
        await loadFixture(deployAaveStack);
      expect(await aaveStrategy.vault()).to.equal(await vault.getAddress());
      expect(await aaveStrategy.asset()).to.equal(await token.getAddress());
      expect(await aaveStrategy.aavePool()).to.equal(await aavePool.getAddress());
      expect(await aaveStrategy.aToken()).to.equal(await aToken.getAddress());
    });

    it("test_constructor_setsInfiniteApprovalToPool", async () => {
      const { aaveStrategy, token, aavePool } = await loadFixture(deployAaveStack);
      const allowance = await token.allowance(
        await aaveStrategy.getAddress(),
        await aavePool.getAddress(),
      );
      expect(allowance).to.equal(ethers.MaxUint256);
    });

    it("test_constructor_zeroPool_reverts", async () => {
      const [owner] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();
      const Aave = await ethers.getContractFactory("AaveV3Strategy");
      await expect(
        Aave.deploy(
          owner.address, // vault placeholder
          await token.getAddress(),
          ethers.ZeroAddress,
          owner.address, // aToken placeholder
          TEST_STRATEGY_VERSION_HASH,
        ),
      ).to.be.revertedWithCustomError(Aave, "ZeroAddress");
    });

    it("test_constructor_zeroAToken_reverts", async () => {
      const [owner] = await ethers.getSigners();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const token = await MockUSDC.deploy();
      const Aave = await ethers.getContractFactory("AaveV3Strategy");
      await expect(
        Aave.deploy(
          owner.address,
          await token.getAddress(),
          owner.address, // pool placeholder
          ethers.ZeroAddress,
          TEST_STRATEGY_VERSION_HASH,
        ),
      ).to.be.revertedWithCustomError(Aave, "ZeroAddress");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("deposit (via Vault.investToStrategy)", () => {
    it("test_invest_movesUsdcToAaveAndMintsAToken", async () => {
      const { vault, keeper, aaveStrategy, aToken, aavePool, token } =
        await loadFixture(deployAaveStack);

      await vault.connect(keeper).investToStrategy(
        await aaveStrategy.getAddress(),
        usdc("3000"),
      );

      // USDC moved: vault → strategy → pool.
      expect(await token.balanceOf(await aavePool.getAddress())).to.equal(usdc("3000"));
      // aToken minted to the strategy.
      expect(await aToken.balanceOf(await aaveStrategy.getAddress())).to.equal(usdc("3000"));
      // IStrategy.balanceOf reflects aToken balance.
      expect(await aaveStrategy.balanceOf()).to.equal(usdc("3000"));
    });

    it("test_invest_byDirectCallToStrategy_reverts", async () => {
      const { aaveStrategy, alice } = await loadFixture(deployAaveStack);
      // Bypass attempt: call deposit() directly on the strategy without going through Vault.
      await expect(
        aaveStrategy.connect(alice).deposit(usdc("100")),
      ).to.be.revertedWithCustomError(aaveStrategy, "NotVault");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("withdraw + emergencyWithdraw (via Vault)", () => {
    it("test_withdraw_returnsUsdcToVault", async () => {
      const { vault, keeper, aaveStrategy, token } = await loadFixture(deployAaveStack);

      await vault
        .connect(keeper)
        .investToStrategy(await aaveStrategy.getAddress(), usdc("3000"));

      await vault
        .connect(keeper)
        .divestFromStrategy(await aaveStrategy.getAddress(), usdc("1000"));

      expect(await aaveStrategy.balanceOf()).to.equal(usdc("2000"));
      // Vault idle should reflect the recovered $1K (was $7K idle before invest, then -3K, then +1K).
      expect(await token.balanceOf(await vault.getAddress())).to.equal(usdc("8000"));
    });

    it("test_emergencyWithdraw_drainsEntireAaveBalance", async () => {
      const { vault, keeper, aaveStrategy, aToken, token } =
        await loadFixture(deployAaveStack);

      await vault
        .connect(keeper)
        .investToStrategy(await aaveStrategy.getAddress(), usdc("3000"));

      // Trigger emergencyWithdraw (vault auto-blacklists the strategy too).
      await vault
        .connect(keeper)
        .emergencyWithdraw(await aaveStrategy.getAddress(), "test");

      expect(await aToken.balanceOf(await aaveStrategy.getAddress())).to.equal(0);
      expect(await aaveStrategy.balanceOf()).to.equal(0);
      // Funds back in the vault.
      expect(await token.balanceOf(await vault.getAddress())).to.equal(usdc("10000"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("yield accrual + harvest", () => {
    it("test_balanceOf_increasesAfterAaveYield", async () => {
      const { vault, keeper, aaveStrategy, aavePool, aToken, token } =
        await loadFixture(deployAaveStack);

      await vault
        .connect(keeper)
        .investToStrategy(await aaveStrategy.getAddress(), usdc("3000"));
      const before = await aaveStrategy.balanceOf();

      // Simulate Aave interest: pool gets $30 USDC (so withdrawals can settle) + strategy
      // receives $30 of aToken (matches Aave's auto-accrual).
      await token.mint(await aavePool.getAddress(), usdc("30"));
      await aavePool.simulateYield(
        await token.getAddress(),
        await aaveStrategy.getAddress(),
        usdc("30"),
      );

      expect(await aaveStrategy.balanceOf()).to.equal(before + usdc("30"));
      // aToken side mirrors.
      expect(await aToken.balanceOf(await aaveStrategy.getAddress())).to.equal(
        before + usdc("30"),
      );
    });

    it("test_harvest_aaveYield_mintsFeeShares", async () => {
      // Vault.harvest() should pick up the aToken balance growth and mint Treasury shares.
      const { vault, keeper, aaveStrategy, aavePool, treasury, token } =
        await loadFixture(deployAaveStack);

      await vault
        .connect(keeper)
        .investToStrategy(await aaveStrategy.getAddress(), usdc("3000"));

      // $300 yield → 15% fee = $45.
      await token.mint(await aavePool.getAddress(), usdc("300"));
      await aavePool.simulateYield(
        await token.getAddress(),
        await aaveStrategy.getAddress(),
        usdc("300"),
      );

      await vault.connect(keeper).harvest();

      const treasuryShares = await vault.balanceOf(treasury.address);
      const treasuryAssets = await vault.convertToAssets(treasuryShares);
      expect(treasuryAssets).to.be.closeTo(usdc("45"), usdc("1"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("currentAPY", () => {
    it("test_currentAPY_convertsRayToBps", async () => {
      const { aaveStrategy } = await loadFixture(deployAaveStack);
      // setReserve put 5e25 (= 5% APR in RAY) → 5e25 / 1e23 = 500 bps.
      expect(await aaveStrategy.currentAPY()).to.equal(500);
    });

    it("test_currentAPY_updatesWhenPoolRateChanges", async () => {
      const { aaveStrategy, aavePool, aToken, token } = await loadFixture(deployAaveStack);
      // Bump rate to 7.5% APR.
      await aavePool.setReserve(
        await token.getAddress(),
        await aToken.getAddress(),
        ethers.parseUnits("75", 24), // 7.5e25 = 7.5% APR in RAY
      );
      expect(await aaveStrategy.currentAPY()).to.equal(750);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("withdrawalDelay + harvestable defaults", () => {
    it("test_withdrawalDelay_isZero", async () => {
      const { aaveStrategy } = await loadFixture(deployAaveStack);
      // Aave V3 supplies are instant-exit (no cooldown).
      expect(await aaveStrategy.withdrawalDelay()).to.equal(0);
    });

    it("test_harvestable_returnsZero", async () => {
      const { aaveStrategy } = await loadFixture(deployAaveStack);
      // Aave auto-accrues; vault tracks profit via lastRecordedBalance, not strategy harvestable.
      expect(await aaveStrategy.harvestable()).to.equal(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("test_emergencyWithdraw_zeroBalance_returnsZero", async () => {
      // Strategy added but never invested → aToken balance is 0 → _emergencyWithdraw early-returns.
      const { vault, keeper, aaveStrategy } = await loadFixture(deployAaveStack);
      await expect(
        vault.connect(keeper).emergencyWithdraw(await aaveStrategy.getAddress(), "empty"),
      ).to.emit(vault, "EmergencyWithdrawal");
      expect(await aaveStrategy.balanceOf()).to.equal(0);
    });

    it("test_baseStrategy_directDeposit_byNonVault_reverts", async () => {
      const { aaveStrategy, alice } = await loadFixture(deployAaveStack);
      await expect(
        aaveStrategy.connect(alice).withdraw(usdc("100")),
      ).to.be.revertedWithCustomError(aaveStrategy, "NotVault");
    });

    it("test_baseStrategy_zeroAmountDeposit_reverts", async () => {
      // Bypass via vault is impossible (vault filters), but BaseStrategy itself enforces
      // ZeroAmount. We emulate by impersonating the vault address.
      const { vault, aaveStrategy } = await loadFixture(deployAaveStack);
      const vaultAddr = await vault.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
      await ethers.provider.send("hardhat_setBalance", [
        vaultAddr,
        "0x" + (10n ** 18n).toString(16),
      ]);
      const vaultSigner = await ethers.getSigner(vaultAddr);
      await expect(
        aaveStrategy.connect(vaultSigner).deposit(0),
      ).to.be.revertedWithCustomError(aaveStrategy, "ZeroAmount");
    });
  });
});
