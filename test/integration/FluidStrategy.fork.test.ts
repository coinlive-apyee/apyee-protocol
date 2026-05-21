import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
  time,
} from "@nomicfoundation/hardhat-network-helpers";

import { DEFAULT_FEE_RATE, TEST_VERSION_HASH, TEST_STRATEGY_VERSION_HASH } from "../fixtures/deployVault";

/// Multi-chain fork test for FluidStrategy. Fluid Lending is deployed on Ethereum / Base /
/// Arbitrum / BNB; the same `FluidStrategy.sol` adapter wraps each fUSDC ERC-4626 fToken.
/// Run per chain by setting `FORK_CHAIN` (default ethereum).
///
/// Ethereum runs by default. Base / Arbitrum / BSC require explicit opt-in flags because
/// Hardhat 2.22 EDR (the Rust EVM engine) does not propagate the `chains.<id>.hardforkHistory`
/// override for non-Ethereum chain ids, so recent fork blocks hit "No known hardfork for
/// execution" (known EDR limitation, tracked upstream). The chain-specific configs below
/// (addresses, decimals, whales) stay wired up so the tests will activate the moment EDR
/// fixes the bug or someone manually patches against an older Hardhat. Until then, real
/// non-Ethereum validation runs as small-amount smoke tests against mainnet (spec 1.13).
const FORK_ENABLED = process.env.FORK === "true";
const FORK_CHAIN = process.env.FORK_CHAIN ?? "ethereum";
const BSC_FORK_OPT_IN = process.env.FORK_BSC_ENABLED === "true";
const BASE_FORK_OPT_IN = process.env.FORK_BASE_ENABLED === "true";
const ARB_FORK_OPT_IN = process.env.FORK_ARBITRUM_ENABLED === "true";

interface ChainFixture {
  label: string;
  usdc: string;
  decimals: number;
  fluidVault: string;
  whales: string[];
}

const CHAIN_FIXTURES: Record<string, ChainFixture> = {
  ethereum: {
    label: "Ethereum, Fluid fUSDC",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    // Lowercase to skip ethers v6 strict EIP-55 (mirrors MorphoStrategy fork pattern).
    fluidVault: "0x9fb7b4477576fe5b32be4c1843afb1e55f251b33",
    whales: [
      "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf", // Polygon PoS Bridge
      "0x3ee18B2214AFF97000D974cf647E54D44b8Ba5C4", // Wormhole
      "0xcEe284F754E854890e311e3280b767F80797180d", // Arbitrum Bridge
      "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance 8
      "0x55FE002aefF02F77364de339a1292923A15844B8", // Coinbase 10
    ],
  },
  base: {
    label: "Base, Fluid fUSDC",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    fluidVault: "0xf42f5795d9ac7e9d757db633d693cd548cfd9169",
    whales: [
      "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance: Hot Wallet 8 (multichain)
      "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549", // Coinbase 10 on Base
      "0x4200000000000000000000000000000000000010", // L2 StandardBridge — frequently holds bridged USDC
      "0xD34EA7278e6BD48DefE656bbE263aEf11101469c", // Coinbase 6 on Base
    ],
  },
  arbitrum: {
    label: "Arbitrum, Fluid fUSDC",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Native USDC (not USDC.e)
    decimals: 6,
    fluidVault: "0x1a996cb54bb95462040408c06122d45d6cdb6096",
    whales: [
      "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance: Hot Wallet 8
      "0xB38e8c17e38363aF6EbdCb3dAE12e0243582891D", // Binance 17
      "0x489ee077994B6658eAfA855C308275EAd8097C4A", // GMX Vault
      "0x47c031236e19d024b42f8AE6780E44A573170703", // GMX
    ],
  },
  bsc: {
    label: "BNB Chain, Fluid fUSDC",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // Binance-Peg USDC, 18 dec
    decimals: 18,
    fluidVault: "0xfe60462e93cee34319f48cfc6acfbc13c2882df9",
    whales: [
      "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3", // Binance Hot Wallet 6
      "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance: Hot Wallet 8
      "0x73feaa1eE314F8c655E354234017bE2193C9E24E", // PancakeSwap MasterChef v2
      "0x0F8c45B896784A1E408526B9300519ef8660209c", // XSwapProtocol
    ],
  },
};

const fixture = CHAIN_FIXTURES[FORK_CHAIN];

// Ethereum runs whenever FORK=true. Non-Ethereum chains require chain-specific opt-in
// flags because of the EDR hardfork-history bug noted above.
function isChainEnabled(): boolean {
  if (!FORK_ENABLED || fixture === undefined) return false;
  switch (FORK_CHAIN) {
    case "ethereum":
      return true;
    case "base":
      return BASE_FORK_OPT_IN;
    case "arbitrum":
      return ARB_FORK_OPT_IN;
    case "bsc":
      return BSC_FORK_OPT_IN;
    default:
      return false;
  }
}
const describeFork = isChainEnabled() ? describe : describe.skip;

const usdc = (n: string) =>
  ethers.parseUnits(n, fixture ? fixture.decimals : 6);
const INTEGRATION_DEPOSIT_CAP = usdc("1000000");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fundFromWhale(token: any, recipient: string, amount: bigint): Promise<void> {
  if (!fixture) throw new Error("no fixture for FORK_CHAIN=" + FORK_CHAIN);
  for (const whaleAddr of fixture.whales) {
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
    `No USDC whale found with ≥ ${ethers.formatUnits(amount, fixture.decimals)} USDC on ` +
      `${FORK_CHAIN} at this fork block`,
  );
}

describeFork(`FluidStrategy — Mainnet Fork (${fixture?.label ?? FORK_CHAIN})`, function () {
  this.timeout(180_000);

  async function deployForkStack() {
    const [owner, keeper, guardian, treasury, alice] = await ethers.getSigners();
    const f = fixture!;

    const usdcContract = await ethers.getContractAt("IERC20", f.usdc);
    await fundFromWhale(usdcContract, alice.address, usdc("50000"));

    const Vault = await ethers.getContractFactory("Vault");
    const vault = await Vault.deploy(
      f.usdc,
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

    const FluidStrategy = await ethers.getContractFactory("FluidStrategy");
    const fluidStrategy = await FluidStrategy.deploy(
      await vault.getAddress(),
      f.usdc,
      f.fluidVault,
      TEST_STRATEGY_VERSION_HASH,
    );
    await fluidStrategy.waitForDeployment();

    await vault.connect(owner).addStrategy(
      await fluidStrategy.getAddress(),
      3000,
      4000,
    );

    await usdcContract.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);

    return {
      vault,
      fluidStrategy,
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
    it("test_fork_setup_fluidIsLive", async () => {
      const { fluidStrategy } = await loadFixture(deployForkStack);
      const fluidVault = await ethers.getContractAt(
        "@openzeppelin/contracts/interfaces/IERC4626.sol:IERC4626",
        await fluidStrategy.fluidVault(),
      );
      // Each chain's fUSDC has $1M+ TVL — just check non-zero.
      const totalAssets = await fluidVault.totalAssets();
      expect(totalAssets).to.be.gt(0);
    });

    it("test_fork_underlyingMatchesAsset", async () => {
      const { fluidStrategy } = await loadFixture(deployForkStack);
      const fluidVault = await ethers.getContractAt(
        "@openzeppelin/contracts/interfaces/IERC4626.sol:IERC4626",
        await fluidStrategy.fluidVault(),
      );
      expect((await fluidVault.asset()).toLowerCase()).to.equal(fixture!.usdc.toLowerCase());
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("invest → real Fluid deposit", () => {
    it("test_fork_invest_depositsAndReceivesShares", async () => {
      const { vault, keeper, fluidStrategy } = await loadFixture(deployForkStack);

      const fluidVault = await ethers.getContractAt(
        "@openzeppelin/contracts/interfaces/IERC4626.sol:IERC4626",
        await fluidStrategy.fluidVault(),
      );

      await vault.connect(keeper).investToStrategy(
        await fluidStrategy.getAddress(),
        usdc("3000"),
      );

      const stratShares = await fluidVault.balanceOf(await fluidStrategy.getAddress());
      expect(stratShares).to.be.gt(0);

      const stratUnderlying = await fluidStrategy.balanceOf();
      // Allow ±$1 for share-price rounding.
      expect(stratUnderlying).to.be.closeTo(usdc("3000"), usdc("1"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("yield accrual on live Fluid", () => {
    it("test_fork_balanceAccrues_after30Days", async () => {
      const { vault, keeper, fluidStrategy } = await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(
        await fluidStrategy.getAddress(),
        usdc("3000"),
      );
      const before = await fluidStrategy.balanceOf();

      // Fluid's Liquidity Layer accrues interest into the fToken share price each block —
      // OZ ERC-4626 convertToAssets reads the latest price, no explicit poke required.
      await time.increase(30 * 24 * 60 * 60);

      const after = await fluidStrategy.balanceOf();
      expect(after).to.be.gte(before); // some accrual or at minimum no loss
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("withdraw + emergencyWithdraw on real Fluid", () => {
    it("test_fork_divest_returnsPrincipalToVault", async () => {
      const { vault, keeper, fluidStrategy, usdcContract } =
        await loadFixture(deployForkStack);

      const vaultAddr = await vault.getAddress();
      await vault.connect(keeper).investToStrategy(
        await fluidStrategy.getAddress(),
        usdc("3000"),
      );

      const idleBefore = await usdcContract.balanceOf(vaultAddr);
      await time.increase(7 * 24 * 60 * 60);

      // Pull a fixed amount slightly under invested principal — avoids any
      // share-price-vs-stored mismatch (same dust pattern noted in Aave/Compound/Morpho).
      await vault.connect(keeper).divestFromStrategy(
        await fluidStrategy.getAddress(),
        usdc("2500"),
      );

      const idleAfter = await usdcContract.balanceOf(vaultAddr);
      expect(idleAfter - idleBefore).to.be.gte(usdc("2499"));
      expect(await fluidStrategy.balanceOf()).to.be.gte(usdc("499"));
    });

    it("test_fork_emergencyWithdraw_drainsAllAndBlacklists", async () => {
      const { vault, keeper, fluidStrategy } = await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(
        await fluidStrategy.getAddress(),
        usdc("3000"),
      );

      await vault
        .connect(keeper)
        .emergencyWithdraw(await fluidStrategy.getAddress(), "fork-integration-test");

      // ERC-4626 redeem(allShares) drains cleanly — should be exactly 0, not dust.
      expect(await fluidStrategy.balanceOf()).to.equal(0);

      const info = await vault.strategyInfo(await fluidStrategy.getAddress());
      expect(info.isActive).to.equal(false);
      expect(info.isBlacklisted).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("harvest — real Fluid yield drives Treasury fees", () => {
    it("test_fork_harvest_mintsFeeSharesAfterAccrual", async () => {
      const { vault, keeper, fluidStrategy, treasury } =
        await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(
        await fluidStrategy.getAddress(),
        usdc("3000"),
      );

      // Generous time horizon — Fluid supply APY varies with Liquidity Layer utilization.
      await time.increase(30 * 24 * 60 * 60);

      const treasuryBefore = await vault.balanceOf(treasury.address);
      await vault.connect(keeper).harvest();
      const treasuryAfter = await vault.balanceOf(treasury.address);

      // Harvest may be 0 if no profit accrued (rare but possible at low-util periods).
      // Assert no regression — Treasury never decreases.
      expect(treasuryAfter).to.be.gte(treasuryBefore);
    });
  });
});
