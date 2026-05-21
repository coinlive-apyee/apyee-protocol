import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
  time,
} from "@nomicfoundation/hardhat-network-helpers";

import { DEFAULT_FEE_RATE, TEST_VERSION_HASH, TEST_STRATEGY_VERSION_HASH } from "../fixtures/deployVault";

/// Run only when `FORK=true` AND fork target is Ethereum (default).
/// `FORK_CHAIN=bsc` skips this suite — Aave V3 markets we test live on Ethereum mainnet.
const FORK_ENABLED = process.env.FORK === "true";
const FORK_CHAIN = process.env.FORK_CHAIN ?? "ethereum";
const describeFork =
  FORK_ENABLED && FORK_CHAIN === "ethereum" ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────
// Ethereum mainnet live addresses
// ─────────────────────────────────────────────────────────────
const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const A_USDC = "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c"; // aEthUSDC (Aave V3)

// Multiple USDC whale candidates — bridges and exchange custody addresses tend to hold
// large stable USDC balances. We pick whichever one has enough funds at fork time.
const USDC_WHALES = [
  "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf", // Polygon PoS Bridge
  "0x3ee18B2214AFF97000D974cf647E54D44b8Ba5C4", // Wormhole Token Bridge
  "0xcEe284F754E854890e311e3280b767F80797180d", // Arbitrum Bridge
  "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance 8
  "0x55FE002aefF02F77364de339a1292923A15844B8", // Coinbase 10
];

const usdc = (n: string) => ethers.parseUnits(n, 6);

/// Walk the whale list and fund `recipient` from the first one that has enough USDC.
/// Throws if none qualify — block state is what it is, no point retrying.
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

// $1M cap so the integration tests aren't constrained by Beta's $10K hard cap.
const INTEGRATION_DEPOSIT_CAP = usdc("1000000");

describeFork("AaveV3Strategy — Mainnet Fork (Ethereum)", function () {
  // Fork tests do real RPC reads at deploy time → bump the timeout.
  this.timeout(180_000);

  async function deployForkStack() {
    const [owner, keeper, guardian, treasury, alice] = await ethers.getSigners();

    // Real USDC handle on the fork.
    const usdcContract = await ethers.getContractAt("IERC20", USDC);

    // Pull $50K USDC into alice from whichever whale has enough at this fork block.
    await fundFromWhale(usdcContract, alice.address, usdc("50000"));

    // Deploy Vault pointing at real USDC.
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

    // Deploy strategy pointing at real Aave V3 Pool + aUSDC.
    const AaveStrategy = await ethers.getContractFactory("AaveV3Strategy");
    const aaveStrategy = await AaveStrategy.deploy(
      await vault.getAddress(),
      USDC,
      AAVE_V3_POOL,
      A_USDC,
      TEST_STRATEGY_VERSION_HASH,
    );
    await aaveStrategy.waitForDeployment();

    // Register strategy: target 30%, cap 40%.
    await vault.connect(owner).addStrategy(
      await aaveStrategy.getAddress(),
      3000,
      4000,
    );

    // Alice deposits $10K so the vault has working capital.
    await usdcContract.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);

    return {
      vault,
      aaveStrategy,
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
    it("test_fork_setup_aaveAddressesAreLive", async () => {
      const { aaveStrategy } = await loadFixture(deployForkStack);
      // A non-zero APY proves we successfully read currentLiquidityRate from live Aave V3.
      const apy = await aaveStrategy.currentAPY();
      expect(apy).to.be.gt(0);
      // Sanity: USDC supply APR on Aave is realistically between 1bp and 2000bp (0.01%–20%).
      expect(apy).to.be.lt(2000);
    });

    it("test_fork_strategyAsset_matchesVaultAsset", async () => {
      const { aaveStrategy, vault } = await loadFixture(deployForkStack);
      expect(await aaveStrategy.asset()).to.equal(await vault.asset());
      expect(await aaveStrategy.asset()).to.equal(USDC);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("invest → real Aave V3 supply", () => {
    it("test_fork_invest_suppliesUsdcAndReceivesAToken", async () => {
      const { vault, keeper, aaveStrategy } = await loadFixture(deployForkStack);

      const aUsdc = await ethers.getContractAt("IERC20", A_USDC);

      await vault
        .connect(keeper)
        .investToStrategy(await aaveStrategy.getAddress(), usdc("3000"));

      // aUSDC is 1:1 with USDC at supply time. Allow ±$1 tolerance for index math.
      const aTokenBal = await aUsdc.balanceOf(await aaveStrategy.getAddress());
      expect(aTokenBal).to.be.closeTo(usdc("3000"), usdc("1"));

      // IStrategy.balanceOf mirrors aToken.balanceOf.
      expect(await aaveStrategy.balanceOf()).to.be.closeTo(usdc("3000"), usdc("1"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("yield accrual on live Aave V3", () => {
    it("test_fork_balanceAccrues_after30Days", async () => {
      const { vault, keeper, aaveStrategy } = await loadFixture(deployForkStack);

      await vault
        .connect(keeper)
        .investToStrategy(await aaveStrategy.getAddress(), usdc("3000"));
      const before = await aaveStrategy.balanceOf();

      // Aave V3 computes `getReserveNormalizedIncome` linearly off block.timestamp →
      // a view call after `time.increase` returns the accrued value with no extra interaction.
      await time.increase(30 * 24 * 60 * 60); // 30 days

      const after = await aaveStrategy.balanceOf();
      // Even at very low rates, 30 days on $3K should produce > $0.10 of interest.
      expect(after).to.be.gt(before);
    });

    it("test_fork_balanceAccrues_significantlyAfter1Year", async () => {
      const { vault, keeper, aaveStrategy } = await loadFixture(deployForkStack);

      await vault
        .connect(keeper)
        .investToStrategy(await aaveStrategy.getAddress(), usdc("3000"));
      const before = await aaveStrategy.balanceOf();

      await time.increase(365 * 24 * 60 * 60); // 1 year

      const after = await aaveStrategy.balanceOf();
      // At a conservative 1% APR on $3K → ~$30/year. Test accepts anything ≥ $5
      // to stay robust across volatile rate environments.
      expect(after - before).to.be.gt(usdc("5"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("withdraw + emergencyWithdraw on real Aave", () => {
    it("test_fork_divest_returnsPrincipalPlusInterestToVault", async () => {
      const { vault, keeper, aaveStrategy, usdcContract } =
        await loadFixture(deployForkStack);

      const vaultAddr = await vault.getAddress();
      await vault
        .connect(keeper)
        .investToStrategy(await aaveStrategy.getAddress(), usdc("3000"));

      const idleBefore = await usdcContract.balanceOf(vaultAddr);
      await time.increase(30 * 24 * 60 * 60);

      // Withdraw the full strategy balance (principal + accrued).
      const stratBal = await aaveStrategy.balanceOf();
      await vault
        .connect(keeper)
        .divestFromStrategy(await aaveStrategy.getAddress(), stratBal);

      const idleAfter = await usdcContract.balanceOf(vaultAddr);
      // Vault gained at least the original $3K back (interest is bonus).
      expect(idleAfter - idleBefore).to.be.gte(usdc("3000"));
      // Strategy is "drained" — Aave's normalized income index ticks every block, so
      // withdrawing the read balance can leave a few wei of dust behind. Treat anything
      // below 1 cent as fully exited (use emergencyWithdraw with type(uint256).max for true zero).
      expect(await aaveStrategy.balanceOf()).to.be.lt(usdc("0.01"));
    });

    it("test_fork_emergencyWithdraw_drainsAllAndBlacklists", async () => {
      const { vault, keeper, aaveStrategy } = await loadFixture(deployForkStack);

      await vault
        .connect(keeper)
        .investToStrategy(await aaveStrategy.getAddress(), usdc("3000"));

      await vault
        .connect(keeper)
        .emergencyWithdraw(await aaveStrategy.getAddress(), "fork-integration-test");

      expect(await aaveStrategy.balanceOf()).to.equal(0);

      const info = await vault.strategyInfo(await aaveStrategy.getAddress());
      expect(info.isActive).to.equal(false);
      expect(info.isBlacklisted).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("harvest — real Aave yield drives Treasury fees", () => {
    it("test_fork_harvest_mintsFeeSharesFrom7DaysOfAccrual", async () => {
      const { vault, keeper, aaveStrategy, treasury } =
        await loadFixture(deployForkStack);

      await vault
        .connect(keeper)
        .investToStrategy(await aaveStrategy.getAddress(), usdc("3000"));

      await time.increase(7 * 24 * 60 * 60); // 7 days

      const treasuryBefore = await vault.balanceOf(treasury.address);
      await vault.connect(keeper).harvest();
      const treasuryAfter = await vault.balanceOf(treasury.address);

      // Even modest weekly yield on $3K should mint a non-zero share count to Treasury.
      expect(treasuryAfter).to.be.gt(treasuryBefore);
    });
  });
});
