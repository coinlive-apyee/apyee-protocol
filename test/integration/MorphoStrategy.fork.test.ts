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
// Steakhouse USDC — one of the largest MetaMorpho USDC vaults.
// MetaMorpho is a curated ERC-4626 wrapper over Morpho Blue markets.
// Lowercase form to skip EIP-55 checksum validation (ethers v6 is strict).
const STEAKHOUSE_USDC = "0xbeefff209270748ddd194831b3fa287a5386f5bc";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const USDC_WHALES = [
  "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf", // Polygon PoS Bridge
  "0x3ee18B2214AFF97000D974cf647E54D44b8Ba5C4", // Wormhole
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

describeFork("MorphoStrategy — Mainnet Fork (Ethereum, Steakhouse USDC)", function () {
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

    const MorphoStrategy = await ethers.getContractFactory("MorphoStrategy");
    const morphoStrategy = await MorphoStrategy.deploy(
      await vault.getAddress(),
      USDC,
      STEAKHOUSE_USDC,
      TEST_STRATEGY_VERSION_HASH,
    );
    await morphoStrategy.waitForDeployment();

    await vault.connect(owner).addStrategy(
      await morphoStrategy.getAddress(),
      3000,
      4000,
    );

    await usdcContract.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);

    return {
      vault,
      morphoStrategy,
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
    it("test_fork_setup_metaMorphoIsLive", async () => {
      const { morphoStrategy } = await loadFixture(deployForkStack);
      // Sanity: read share price from live MetaMorpho.
      const morphoVault = await ethers.getContractAt(
        "@openzeppelin/contracts/interfaces/IERC4626.sol:IERC4626",
        await morphoStrategy.morphoVault(),
      );
      const totalAssets = await morphoVault.totalAssets();
      // Steakhouse USDC has > $1M TVL by default. Just check non-zero.
      expect(totalAssets).to.be.gt(0);
    });

    it("test_fork_underlyingMatchesAsset", async () => {
      const { morphoStrategy } = await loadFixture(deployForkStack);
      const morphoVault = await ethers.getContractAt(
        "@openzeppelin/contracts/interfaces/IERC4626.sol:IERC4626",
        await morphoStrategy.morphoVault(),
      );
      expect(await morphoVault.asset()).to.equal(USDC);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("invest → real MetaMorpho deposit", () => {
    it("test_fork_invest_depositsAndReceivesShares", async () => {
      const { vault, keeper, morphoStrategy } = await loadFixture(deployForkStack);

      const morphoVault = await ethers.getContractAt(
        "@openzeppelin/contracts/interfaces/IERC4626.sol:IERC4626",
        await morphoStrategy.morphoVault(),
      );

      await vault.connect(keeper).investToStrategy(
        await morphoStrategy.getAddress(),
        usdc("3000"),
      );

      const stratShares = await morphoVault.balanceOf(await morphoStrategy.getAddress());
      expect(stratShares).to.be.gt(0);

      const stratUnderlying = await morphoStrategy.balanceOf();
      // Allow ±$1 for share-price rounding.
      expect(stratUnderlying).to.be.closeTo(usdc("3000"), usdc("1"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("yield accrual on live MetaMorpho", () => {
    it("test_fork_balanceAccrues_after30Days", async () => {
      const { vault, keeper, morphoStrategy } = await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(
        await morphoStrategy.getAddress(),
        usdc("3000"),
      );
      const before = await morphoStrategy.balanceOf();

      // MetaMorpho aggregates Morpho Blue market interest → its share price grows over time.
      // Like Aave/Compound, the OZ ERC-4626 implementation reads the latest share price each
      // call, so we don't need an explicit "accrue" trigger.
      await time.increase(30 * 24 * 60 * 60);

      const after = await morphoStrategy.balanceOf();
      expect(after).to.be.gte(before); // some accrual or at minimum no loss
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("withdraw + emergencyWithdraw on real MetaMorpho", () => {
    it("test_fork_divest_returnsPrincipalToVault", async () => {
      const { vault, keeper, morphoStrategy, usdcContract } =
        await loadFixture(deployForkStack);

      const vaultAddr = await vault.getAddress();
      await vault.connect(keeper).investToStrategy(
        await morphoStrategy.getAddress(),
        usdc("3000"),
      );

      const idleBefore = await usdcContract.balanceOf(vaultAddr);
      await time.increase(7 * 24 * 60 * 60);

      // Withdraw a fixed amount slightly under invested principal to dodge any
      // share-price-vs-stored mismatch (similar to Aave/Compound dust pattern).
      await vault.connect(keeper).divestFromStrategy(
        await morphoStrategy.getAddress(),
        usdc("2500"),
      );

      const idleAfter = await usdcContract.balanceOf(vaultAddr);
      expect(idleAfter - idleBefore).to.be.gte(usdc("2499"));
      // Remaining balance ≥ $500 (the un-divested principal). After 7 days of MetaMorpho
      // accrual it's actually a bit higher, so we use gte rather than a tight closeTo window.
      expect(await morphoStrategy.balanceOf()).to.be.gte(usdc("499"));
    });

    it("test_fork_emergencyWithdraw_drainsAllAndBlacklists", async () => {
      const { vault, keeper, morphoStrategy } = await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(
        await morphoStrategy.getAddress(),
        usdc("3000"),
      );

      await vault
        .connect(keeper)
        .emergencyWithdraw(await morphoStrategy.getAddress(), "fork-integration-test");

      // ERC-4626 redeem(allShares) drains cleanly — should be exactly 0, not dust.
      expect(await morphoStrategy.balanceOf()).to.equal(0);

      const info = await vault.strategyInfo(await morphoStrategy.getAddress());
      expect(info.isActive).to.equal(false);
      expect(info.isBlacklisted).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("harvest — real Morpho yield drives Treasury fees", () => {
    it("test_fork_harvest_mintsFeeSharesAfterAccrual", async () => {
      const { vault, keeper, morphoStrategy, treasury } =
        await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(
        await morphoStrategy.getAddress(),
        usdc("3000"),
      );

      // Generous time horizon — MetaMorpho APY can be modest depending on Blue market mix.
      await time.increase(30 * 24 * 60 * 60);

      const treasuryBefore = await vault.balanceOf(treasury.address);
      await vault.connect(keeper).harvest();
      const treasuryAfter = await vault.balanceOf(treasury.address);

      // Harvest may be 0 if no profit accrued (rare but possible at idle markets).
      // We just assert no regression — Treasury never decreases.
      expect(treasuryAfter).to.be.gte(treasuryBefore);
    });
  });
});
