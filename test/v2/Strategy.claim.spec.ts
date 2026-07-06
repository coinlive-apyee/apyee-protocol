import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import {
  DEFAULT_FEE_RATE,
  V2_VERSION_HASHES,
  TIER_BALANCED_BPS,
} from "../fixtures/deployVaultV2";

/// V2.1 Soken F-04 — mock-distributor unit tests for the claim+swap+reinvest flow.
/// One real-fork pass (Compound on Ethereum, see Strategy.claim.fork.spec.ts) proves the
/// end-to-end wiring against live UniswapV3; the mocks here cover the other four
/// distributor shapes (Venus / Aave / Morpho URD / Fluid) with deterministic state.
///
/// Each block deploys a VaultV2 + the production strategy + mock distributor + mock
/// SwapRouter, pre-seeds a reward amount, then calls `claimAndCompound(swapPath, minOut)`
/// and asserts:
///   1. `RewardsCompounded` event emitted (claimed > 0, swapped > 0)
///   2. Reward-token balance on the strategy is drained to zero
///   3. Strategy balance + vault.totalAssets() grow by ≈ `swapped`
///   4. onlyKeeper revert from a non-keeper signer

const REWARD_AMOUNT = ethers.parseUnits("100", 18); // 100 reward tokens (18 dec)
const USDC_AMOUNT   = ethers.parseUnits("100", 6);  // mock router rate 1:1e-12 → 100 USDC
const MIN_OUT       = ethers.parseUnits("99", 6);   // 1 % slippage cap

/// V2.1.2 (Soken F-04-MEV.1): mocks use a 1:1e-12 router ratio → each reward token is
/// worth exactly $1 USDC. Chainlink convention is USD price × 1e8, so fallback price
/// = 1e8. Owner-set via `BaseStrategy.setRewardFallbackPrice` per reward token before
/// the first claim.
const FALLBACK_PRICE_E8 = 100_000_000n;

function buildSinglehopPath(tokenIn: string, tokenOut: string, fee: number = 500): string {
  const feeHex = fee.toString(16).padStart(6, "0");
  return "0x" + tokenIn.slice(2).toLowerCase() + feeHex + tokenOut.slice(2).toLowerCase();
}

async function baseFixture() {
  const [owner, keeper, guardian, treasury, alice, attacker] = await ethers.getSigners();

  const USDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await USDC.deploy();

  const RewardF = await ethers.getContractFactory("MockRewardToken");

  const Router = await ethers.getContractFactory("MockSwapRouter");
  const router = await Router.deploy();
  // Pre-fund router with USDC so it can pay swap outputs.
  await usdc.mint(await router.getAddress(), ethers.parseUnits("100000", 6));

  // Deploy VaultV2 (balanced tier).
  const VaultV2 = await ethers.getContractFactory("VaultV2");
  const vault = await VaultV2.deploy({
    asset: await usdc.getAddress(),
    name: "Apyee USDC Vault V2 (Mock)",
    symbol: "apUSDC-b-mock",
    initialOwner: owner.address,
    keeper: keeper.address,
    guardian: guardian.address,
    treasury: treasury.address,
    feeRate: DEFAULT_FEE_RATE,
    depositCap: ethers.parseUnits("1000000", 6),
    defaultUserCap: ethers.parseUnits("1000000", 6),
    maxAllocationAbsolute: TIER_BALANCED_BPS,
    versionHash: V2_VERSION_HASHES.devBalanced,
  });
  await vault.waitForDeployment();

  // Fund alice + deposit so the strategy has invest headroom.
  await usdc.mint(alice.address, ethers.parseUnits("100000", 6));

  return { owner, keeper, guardian, treasury, alice, attacker, usdc, RewardF, router, vault };
}

async function depositAndInvest(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fx: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  strat: any,
) {
  const { vault, usdc, alice, keeper } = fx;
  const depositAmt = ethers.parseUnits("50000", 6);
  await usdc.connect(alice).approve(await vault.getAddress(), depositAmt);
  await vault.connect(alice).deposit(depositAmt, alice.address);
  const investAmt = (depositAmt * BigInt(TIER_BALANCED_BPS)) / 10_000n;
  await vault.connect(keeper).investToStrategy(await strat.getAddress(), investAmt);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assertClaimedSwappedReinvested(strat: any, vault: any, rewardToken: any) {
  const taBefore = await vault.totalAssets();
  const stratBalBefore = await strat.balanceOf();

  // Trigger via Keeper; assertions read events / balances.
  const tx = await strat.claimAndCompound.staticCall ? null : null;  // no-op (kept for tooling)
  void tx;

  return { taBefore, stratBalBefore, rewardToken };
}

describe("Strategy.claimAndCompound — mock distributor unit suite", () => {
  // ─────────────────────────────────────────────────────────────
  // CompoundV3Strategy
  // ─────────────────────────────────────────────────────────────
  describe("CompoundV3Strategy (Mock CometRewards)", () => {
    async function deployStack() {
      const fx = await loadFixture(baseFixture);
      const { owner, RewardF, usdc, router, vault } = fx;

      const Comet = await ethers.getContractFactory("MockComet");
      const comet = await Comet.deploy(await usdc.getAddress(), 0, 0);

      const Rewards = await ethers.getContractFactory("MockCometRewards");
      const rewards = await Rewards.deploy();

      const comp = await RewardF.deploy("Compound", "COMP");
      await rewards.setRewardConfig(await comet.getAddress(), await comp.getAddress());

      const Strat = await ethers.getContractFactory("CompoundV3Strategy");
      const strat = await Strat.deploy(
        await vault.getAddress(),
        await usdc.getAddress(),
        await comet.getAddress(),
        await rewards.getAddress(),
        await router.getAddress(),
        V2_VERSION_HASHES.devBalanced,
      );
      await vault.connect(owner).addStrategy(await strat.getAddress(), 3000, TIER_BALANCED_BPS);
      await depositAndInvest(fx, strat);

      // Pre-fund distributor + queue the reward.
      await comp.mint(await rewards.getAddress(), REWARD_AMOUNT);
      await rewards.setOwed(await comet.getAddress(), await strat.getAddress(), REWARD_AMOUNT);

      await strat.connect(fx.owner).setRewardFallbackPrice(await comp.getAddress(), FALLBACK_PRICE_E8);
      const swapPath = buildSinglehopPath(await comp.getAddress(), await usdc.getAddress());
      return { ...fx, strat, comp, swapPath };
    }

    it("test_compound_mock_claimsSwapsReinvests", async () => {
      const { vault, strat, comp, keeper, swapPath } = await deployStack();
      const stratBalBefore = await strat.balanceOf();
      const taBefore = await vault.totalAssets();

      await expect(strat.connect(keeper).claimAndCompound(swapPath, MIN_OUT))
        .to.emit(strat, "RewardsCompounded");

      expect(await comp.balanceOf(await strat.getAddress())).to.equal(0n);
      expect((await strat.balanceOf()) - stratBalBefore).to.be.closeTo(USDC_AMOUNT, 5n);
      expect((await vault.totalAssets()) - taBefore).to.be.closeTo(USDC_AMOUNT, 5n);
    });

    it("test_compound_mock_revertsWhenNotKeeper", async () => {
      const { strat, attacker, swapPath } = await deployStack();
      await expect(
        strat.connect(attacker).claimAndCompound(swapPath, 0n),
      ).to.be.revertedWithCustomError(strat, "NotKeeper");
    });

    it("test_compound_mock_revertsOnInvalidPath", async () => {
      // Wrong destination — path ends at rewardToken instead of USDC.
      const { strat, comp, keeper } = await deployStack();
      const badPath =
        "0x" + (await comp.getAddress()).slice(2).toLowerCase() + "0001f4" +
        (await comp.getAddress()).slice(2).toLowerCase();
      await expect(
        strat.connect(keeper).claimAndCompound(badPath, 0n),
      ).to.be.revertedWithCustomError(strat, "InvalidPath");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // VenusStrategy
  // ─────────────────────────────────────────────────────────────
  describe("VenusStrategy (Mock Comptroller)", () => {
    async function deployStack() {
      const fx = await loadFixture(baseFixture);
      const { owner, RewardF, usdc, router, vault } = fx;

      const VToken = await ethers.getContractFactory("MockVToken");
      // exchangeRate = 1e16 → 1 vUSDC ≈ 1 USDC at 6-dec scale; supplyRate=0 (no auto-yield).
      const vToken = await VToken.deploy(await usdc.getAddress(), ethers.parseUnits("1", 16), 0);

      const Comptroller = await ethers.getContractFactory("MockVenusComptroller");
      const comptroller = await Comptroller.deploy();

      const xvs = await RewardF.deploy("Venus", "XVS");
      await comptroller.setXvs(await xvs.getAddress());

      const Strat = await ethers.getContractFactory("VenusStrategy");
      const strat = await Strat.deploy(
        await vault.getAddress(),
        await usdc.getAddress(),
        await vToken.getAddress(),
        await comptroller.getAddress(),
        await xvs.getAddress(),
        await router.getAddress(),
        V2_VERSION_HASHES.devBalanced,
      );
      await vault.connect(owner).addStrategy(await strat.getAddress(), 3000, TIER_BALANCED_BPS);
      await depositAndInvest(fx, strat);

      await xvs.mint(await comptroller.getAddress(), REWARD_AMOUNT);
      await comptroller.setOwed(await strat.getAddress(), REWARD_AMOUNT);

      await strat.connect(fx.owner).setRewardFallbackPrice(await xvs.getAddress(), FALLBACK_PRICE_E8);
      const swapPath = buildSinglehopPath(await xvs.getAddress(), await usdc.getAddress());
      return { ...fx, strat, xvs, swapPath };
    }

    it("test_venus_mock_claimsSwapsReinvests", async () => {
      const { vault, strat, xvs, keeper, swapPath } = await deployStack();
      const taBefore = await vault.totalAssets();
      const stratBalBefore = await strat.balanceOf();

      await expect(strat.connect(keeper).claimAndCompound(swapPath, MIN_OUT))
        .to.emit(strat, "RewardsCompounded");

      expect(await xvs.balanceOf(await strat.getAddress())).to.equal(0n);
      expect((await strat.balanceOf()) - stratBalBefore).to.be.closeTo(USDC_AMOUNT, 5n);
      expect((await vault.totalAssets()) - taBefore).to.be.closeTo(USDC_AMOUNT, 5n);
    });

    it("test_venus_mock_revertsWhenNotKeeper", async () => {
      const { strat, attacker, swapPath } = await deployStack();
      await expect(
        strat.connect(attacker).claimAndCompound(swapPath, 0n),
      ).to.be.revertedWithCustomError(strat, "NotKeeper");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // AaveV3Strategy
  // ─────────────────────────────────────────────────────────────
  describe("AaveV3Strategy (Mock RewardsController)", () => {
    async function deployStack() {
      const fx = await loadFixture(baseFixture);
      const { owner, RewardF, usdc, router, vault } = fx;

      const Pool = await ethers.getContractFactory("MockAavePool");
      const pool = await Pool.deploy();
      const AToken = await ethers.getContractFactory("MockAToken");
      const aToken = await AToken.deploy("Mock aUSDC", "aUSDC", 6, await pool.getAddress());
      const aTokenAddr = await aToken.getAddress();
      await pool.setReserve(await usdc.getAddress(), aTokenAddr, 0);

      const Controller = await ethers.getContractFactory("MockAaveRewardsController");
      const controller = await Controller.deploy();

      const spk = await RewardF.deploy("Spark", "SPK");

      const Strat = await ethers.getContractFactory("AaveV3Strategy");
      const strat = await Strat.deploy(
        await vault.getAddress(),
        await usdc.getAddress(),
        await pool.getAddress(),
        aTokenAddr,
        await controller.getAddress(),
        await spk.getAddress(),
        await router.getAddress(),
        V2_VERSION_HASHES.devBalanced,
      );
      await vault.connect(owner).addStrategy(await strat.getAddress(), 3000, TIER_BALANCED_BPS);
      await depositAndInvest(fx, strat);

      await spk.mint(await controller.getAddress(), REWARD_AMOUNT);
      await controller.setOwed(await strat.getAddress(), await spk.getAddress(), REWARD_AMOUNT);

      await strat.connect(fx.owner).setRewardFallbackPrice(await spk.getAddress(), FALLBACK_PRICE_E8);
      const swapPath = buildSinglehopPath(await spk.getAddress(), await usdc.getAddress());
      return { ...fx, strat, spk, swapPath };
    }

    it("test_aave_mock_claimsSwapsReinvests", async () => {
      const { vault, strat, spk, keeper, swapPath } = await deployStack();
      const taBefore = await vault.totalAssets();
      const stratBalBefore = await strat.balanceOf();

      await expect(strat.connect(keeper).claimAndCompound(swapPath, MIN_OUT))
        .to.emit(strat, "RewardsCompounded");

      expect(await spk.balanceOf(await strat.getAddress())).to.equal(0n);
      expect((await strat.balanceOf()) - stratBalBefore).to.be.closeTo(USDC_AMOUNT, 5n);
      expect((await vault.totalAssets()) - taBefore).to.be.closeTo(USDC_AMOUNT, 5n);
    });

    it("test_aave_mock_revertsWhenNotKeeper", async () => {
      const { strat, attacker, swapPath } = await deployStack();
      await expect(
        strat.connect(attacker).claimAndCompound(swapPath, 0n),
      ).to.be.revertedWithCustomError(strat, "NotKeeper");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // MorphoStrategy
  // ─────────────────────────────────────────────────────────────
  describe("MorphoStrategy (Mock URD)", () => {
    async function deployStack() {
      const fx = await loadFixture(baseFixture);
      const { owner, RewardF, usdc, router, vault } = fx;

      const MM = await ethers.getContractFactory("MockMetaMorphoVault");
      const morphoVault = await MM.deploy(await usdc.getAddress());

      const URD = await ethers.getContractFactory("MockUniversalRewardsDistributor");
      const urd = await URD.deploy();

      const morpho = await RewardF.deploy("Morpho", "MORPHO");

      const Strat = await ethers.getContractFactory("MorphoStrategy");
      const strat = await Strat.deploy(
        await vault.getAddress(),
        await usdc.getAddress(),
        await morphoVault.getAddress(),
        await urd.getAddress(),
        await router.getAddress(),
        V2_VERSION_HASHES.devBalanced,
      );
      await vault.connect(owner).addStrategy(await strat.getAddress(), 3000, TIER_BALANCED_BPS);
      await depositAndInvest(fx, strat);

      await morpho.mint(await urd.getAddress(), REWARD_AMOUNT);
      await urd.setClaimable(await strat.getAddress(), await morpho.getAddress(), REWARD_AMOUNT);

      await strat.connect(fx.owner).setRewardFallbackPrice(await morpho.getAddress(), FALLBACK_PRICE_E8);
      const swapPath = buildSinglehopPath(await morpho.getAddress(), await usdc.getAddress());
      return { ...fx, strat, morpho, swapPath };
    }

    it("test_morpho_mock_claimsSwapsReinvests", async () => {
      const { vault, strat, morpho, keeper, swapPath } = await deployStack();
      const taBefore = await vault.totalAssets();
      const stratBalBefore = await strat.balanceOf();
      const morphoAddr = await morpho.getAddress();

      const proof: string[] = [];
      await expect(
        strat.connect(keeper).claimAndCompound(morphoAddr, REWARD_AMOUNT, proof, swapPath, MIN_OUT),
      ).to.emit(strat, "RewardsCompounded");

      expect(await morpho.balanceOf(await strat.getAddress())).to.equal(0n);
      expect((await strat.balanceOf()) - stratBalBefore).to.be.closeTo(USDC_AMOUNT, 5n);
      expect((await vault.totalAssets()) - taBefore).to.be.closeTo(USDC_AMOUNT, 5n);
    });

    it("test_morpho_mock_revertsWhenNotKeeper", async () => {
      const { strat, attacker, morpho, swapPath } = await deployStack();
      const morphoAddr = await morpho.getAddress();
      const proof: string[] = [];
      await expect(
        strat.connect(attacker).claimAndCompound(morphoAddr, REWARD_AMOUNT, proof, swapPath, 0n),
      ).to.be.revertedWithCustomError(strat, "NotKeeper");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // FluidStrategy
  // ─────────────────────────────────────────────────────────────
  describe("FluidStrategy (Mock Merkle Distributor)", () => {
    async function deployStack() {
      const fx = await loadFixture(baseFixture);
      const { owner, RewardF, usdc, router, vault } = fx;

      // Reuse MetaMorpho mock as a generic ERC4626 underlying vault.
      const FV = await ethers.getContractFactory("MockMetaMorphoVault");
      const fluidVault = await FV.deploy(await usdc.getAddress());

      const Dist = await ethers.getContractFactory("MockFluidMerkleDistributor");
      const dist = await Dist.deploy();

      const fluid = await RewardF.deploy("Fluid", "FLUID");
      await dist.setReward(await fluid.getAddress());

      const Strat = await ethers.getContractFactory("FluidStrategy");
      const strat = await Strat.deploy(
        await vault.getAddress(),
        await usdc.getAddress(),
        await fluidVault.getAddress(),
        await dist.getAddress(),
        await fluid.getAddress(),
        await router.getAddress(),
        V2_VERSION_HASHES.devBalanced,
      );
      await vault.connect(owner).addStrategy(await strat.getAddress(), 3000, TIER_BALANCED_BPS);
      await depositAndInvest(fx, strat);

      await fluid.mint(await dist.getAddress(), REWARD_AMOUNT);
      await dist.setOwed(await strat.getAddress(), REWARD_AMOUNT);

      await strat.connect(fx.owner).setRewardFallbackPrice(await fluid.getAddress(), FALLBACK_PRICE_E8);
      const swapPath = buildSinglehopPath(await fluid.getAddress(), await usdc.getAddress());
      return { ...fx, strat, fluid, swapPath };
    }

    it("test_fluid_mock_claimsSwapsReinvests", async () => {
      const { vault, strat, fluid, keeper, swapPath } = await deployStack();
      const taBefore = await vault.totalAssets();
      const stratBalBefore = await strat.balanceOf();

      const cumulativeAmount = REWARD_AMOUNT;
      const positionType = 0;
      const positionId = "0x" + "00".repeat(32);
      const cycle = 1;
      const merkleProof: string[] = [];
      const metadata = "0x";

      await expect(
        strat
          .connect(keeper)
          .claimAndCompound(
            cumulativeAmount,
            positionType,
            positionId,
            cycle,
            merkleProof,
            metadata,
            swapPath,
            MIN_OUT,
          ),
      ).to.emit(strat, "RewardsCompounded");

      expect(await fluid.balanceOf(await strat.getAddress())).to.equal(0n);
      expect((await strat.balanceOf()) - stratBalBefore).to.be.closeTo(USDC_AMOUNT, 5n);
      expect((await vault.totalAssets()) - taBefore).to.be.closeTo(USDC_AMOUNT, 5n);
    });

    it("test_fluid_mock_revertsWhenNotKeeper", async () => {
      const { strat, attacker, swapPath } = await deployStack();
      await expect(
        strat
          .connect(attacker)
          .claimAndCompound(REWARD_AMOUNT, 0, "0x" + "00".repeat(32), 1, [], "0x", swapPath, 0n),
      ).to.be.revertedWithCustomError(strat, "NotKeeper");
    });
  });
});

// Silence unused-helper warnings (kept for future fuzz/integration extensions).
void assertClaimedSwappedReinvested;
