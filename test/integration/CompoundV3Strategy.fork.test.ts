import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
  time,
} from "@nomicfoundation/hardhat-network-helpers";

import { DEFAULT_FEE_RATE, TEST_VERSION_HASH, TEST_STRATEGY_VERSION_HASH } from "../fixtures/deployVault";

const FORK_ENABLED = process.env.FORK === "true";
const FORK_CHAIN = process.env.FORK_CHAIN ?? "ethereum";
const describeFork =
  FORK_ENABLED && FORK_CHAIN === "ethereum" ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────
// Ethereum mainnet live addresses
// ─────────────────────────────────────────────────────────────
const COMET_USDC = "0xc3d688B66703497DAA19211EEdff47f25384cdc3"; // cUSDCv3
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const USDC_WHALES = [
  "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf", // Polygon PoS Bridge
  "0x3ee18B2214AFF97000D974cf647E54D44b8Ba5C4", // Wormhole Token Bridge
  "0xcEe284F754E854890e311e3280b767F80797180d", // Arbitrum Bridge
  "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance 8
  "0x55FE002aefF02F77364de339a1292923A15844B8", // Coinbase 10
];

const usdc = (n: string) => ethers.parseUnits(n, 6);
const INTEGRATION_DEPOSIT_CAP = usdc("1000000");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fundFromWhale(token: any, recipient: string, amount: bigint): Promise<void> {
  for (const whaleAddr of USDC_WHALES) {
    const bal: bigint = await token.balanceOf(whaleAddr);
    if (bal >= amount) {
      await impersonateAccount(whaleAddr);
      const whale = await ethers.getSigner(whaleAddr);
      await setBalance(whaleAddr, ethers.parseEther("10"));
      await token.connect(whale).transfer(recipient, amount);
      return;
    }
  }
  throw new Error(
    `No USDC whale found with ≥ ${ethers.formatUnits(amount, 6)} USDC at this fork block`,
  );
}

describeFork("CompoundV3Strategy — Mainnet Fork (Ethereum)", function () {
  this.timeout(180_000);

  async function deployForkStack() {
    const [owner, keeper, guardian, treasury, alice] = await ethers.getSigners();

    const usdcContract = await ethers.getContractAt("IERC20", USDC);
    await fundFromWhale(usdcContract, alice.address, usdc("50000"));

    const Vault = await ethers.getContractFactory("Vault");
    const vault = await Vault.deploy(
      USDC,
      "Apyee USDC Vault",
      "apUSDC",
      owner.address,
      keeper.address,
      guardian.address,
      treasury.address,
      DEFAULT_FEE_RATE,
      INTEGRATION_DEPOSIT_CAP,
      INTEGRATION_DEPOSIT_CAP, // defaultUserCap
      TEST_VERSION_HASH,
    );
    await vault.waitForDeployment();

    const CompStrategy = await ethers.getContractFactory("CompoundV3Strategy");
    const compStrategy = await CompStrategy.deploy(
      await vault.getAddress(),
      USDC,
      COMET_USDC,
      TEST_STRATEGY_VERSION_HASH,
    );
    await compStrategy.waitForDeployment();

    await vault.connect(owner).addStrategy(
      await compStrategy.getAddress(),
      3000,
      4000,
    );

    await usdcContract.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);

    return {
      vault,
      compStrategy,
      usdcContract,
      owner,
      keeper,
      guardian,
      treasury,
      alice,
    };
  }

  // ─────────────────────────────────────────────────────────────
  describe("setup", () => {
    it("test_fork_setup_cometIsLive", async () => {
      const { compStrategy } = await loadFixture(deployForkStack);
      const apy = await compStrategy.currentAPY();
      expect(apy).to.be.gt(0);
      // Realistic Compound V3 USDC APR: 1bp ~ 2000bp.
      expect(apy).to.be.lt(2000);
    });

    it("test_fork_baseTokenIsUsdc", async () => {
      const { compStrategy } = await loadFixture(deployForkStack);
      const comet = await ethers.getContractAt("IComet", await compStrategy.comet());
      expect(await comet.baseToken()).to.equal(USDC);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("invest → real Comet supply", () => {
    it("test_fork_invest_suppliesUsdcAndCometBalanceMatches", async () => {
      const { vault, keeper, compStrategy } = await loadFixture(deployForkStack);

      await vault
        .connect(keeper)
        .investToStrategy(await compStrategy.getAddress(), usdc("3000"));

      // Comet.balanceOf reads the strategy's base-asset position.
      // Allow ±$1 to account for any same-block accrual rounding.
      const stratBal = await compStrategy.balanceOf();
      expect(stratBal).to.be.closeTo(usdc("3000"), usdc("1"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("yield accrual on live Comet", () => {
    it("test_fork_balanceAccrues_after30Days", async () => {
      const { vault, keeper, compStrategy } = await loadFixture(deployForkStack);

      await vault
        .connect(keeper)
        .investToStrategy(await compStrategy.getAddress(), usdc("3000"));
      const before = await compStrategy.balanceOf();

      await time.increase(30 * 24 * 60 * 60);

      const after = await compStrategy.balanceOf();
      expect(after).to.be.gt(before);
    });

    it("test_fork_balanceAccrues_significantlyAfter1Year", async () => {
      const { vault, keeper, compStrategy } = await loadFixture(deployForkStack);

      await vault
        .connect(keeper)
        .investToStrategy(await compStrategy.getAddress(), usdc("3000"));
      const before = await compStrategy.balanceOf();

      await time.increase(365 * 24 * 60 * 60);

      const after = await compStrategy.balanceOf();
      // Even at < 1% APR, $3K over a year grows by > $5.
      expect(after - before).to.be.gt(usdc("5"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("withdraw + emergencyWithdraw on real Comet", () => {
    it("test_fork_divest_returnsPrincipalPlusInterestToVault", async () => {
      const { vault, keeper, compStrategy, usdcContract } =
        await loadFixture(deployForkStack);

      const vaultAddr = await vault.getAddress();
      await vault
        .connect(keeper)
        .investToStrategy(await compStrategy.getAddress(), usdc("3000"));

      const idleBefore = await usdcContract.balanceOf(vaultAddr);
      await time.increase(30 * 24 * 60 * 60);

      const stratBal = await compStrategy.balanceOf();
      await vault
        .connect(keeper)
        .divestFromStrategy(await compStrategy.getAddress(), stratBal);

      const idleAfter = await usdcContract.balanceOf(vaultAddr);
      expect(idleAfter - idleBefore).to.be.gte(usdc("3000"));
      // Compound V3 may also leave a few wei of dust between read and tx; tolerate < $0.01.
      expect(await compStrategy.balanceOf()).to.be.lt(usdc("0.01"));
    });

    it("test_fork_emergencyWithdraw_drainsAllAndBlacklists", async () => {
      const { vault, keeper, compStrategy } = await loadFixture(deployForkStack);

      await vault
        .connect(keeper)
        .investToStrategy(await compStrategy.getAddress(), usdc("3000"));

      await vault
        .connect(keeper)
        .emergencyWithdraw(await compStrategy.getAddress(), "fork-integration-test");

      expect(await compStrategy.balanceOf()).to.equal(0);

      const info = await vault.strategyInfo(await compStrategy.getAddress());
      expect(info.isActive).to.equal(false);
      expect(info.isBlacklisted).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("harvest — real Compound yield drives Treasury fees", () => {
    it("test_fork_harvest_mintsFeeSharesFrom7DaysOfAccrual", async () => {
      const { vault, keeper, compStrategy, treasury } =
        await loadFixture(deployForkStack);

      await vault
        .connect(keeper)
        .investToStrategy(await compStrategy.getAddress(), usdc("3000"));

      await time.increase(7 * 24 * 60 * 60);

      const treasuryBefore = await vault.balanceOf(treasury.address);
      await vault.connect(keeper).harvest();
      const treasuryAfter = await vault.balanceOf(treasury.address);

      expect(treasuryAfter).to.be.gt(treasuryBefore);
    });
  });
});
