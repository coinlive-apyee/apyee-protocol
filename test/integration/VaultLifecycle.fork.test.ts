import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
  time,
} from "@nomicfoundation/hardhat-network-helpers";

import { DEFAULT_FEE_RATE, TEST_VERSION_HASH, TEST_STRATEGY_VERSION_HASH } from "../fixtures/deployVault";

/// Vault-level full-lifecycle test against real mainnet protocols.
/// Exercises Vault + 3 live strategies (Aave V3, Compound V3, Morpho/Steakhouse) together —
/// confirms deposit / invest / harvest / rebalance / withdraw / emergencyWithdraw all work
/// against the real protocol contracts that the Phase 1 Beta will deploy against.

const FORK_ENABLED = process.env.FORK === "true";
const FORK_CHAIN = process.env.FORK_CHAIN ?? "ethereum";
const describeFork =
  FORK_ENABLED && FORK_CHAIN === "ethereum" ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────
// Ethereum mainnet live addresses
// ─────────────────────────────────────────────────────────────
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const A_USDC = "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c";
const COMET_USDC = "0xc3d688B66703497DAA19211EEdff47f25384cdc3";
const STEAKHOUSE_USDC = "0xbeefff209270748ddd194831b3fa287a5386f5bc";

const USDC_WHALES = [
  "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
  "0x3ee18B2214AFF97000D974cf647E54D44b8Ba5C4",
  "0xcEe284F754E854890e311e3280b767F80797180d",
  "0xF977814e90dA44bFA03b6295A0616a897441aceC",
  "0x55FE002aefF02F77364de339a1292923A15844B8",
];

const usdc = (n: string) => ethers.parseUnits(n, 6);

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

// $1M cap to bypass Beta's $10K hard cap during integration scenarios.
const INTEGRATION_DEPOSIT_CAP = usdc("1000000");

// Initial allocation matches scripts/deploy/00-config.ts mainnet entry — keeps the integration
// test in lock-step with what 03-register-strategies actually deploys to mainnet.
const AAVE_TARGET_BPS = 3000;
const AAVE_MAX_BPS = 4000;
const COMPOUND_TARGET_BPS = 2500;
const COMPOUND_MAX_BPS = 3500;
const MORPHO_TARGET_BPS = 2000;
const MORPHO_MAX_BPS = 3000;

describeFork("VaultLifecycle — Mainnet Fork (Ethereum, 3 strategies)", function () {
  this.timeout(300_000);

  async function deployForkStack() {
    const [owner, keeper, guardian, treasury, alice, bob] = await ethers.getSigners();

    const usdcContract = await ethers.getContractAt("IERC20", USDC);

    // alice $20K, bob $10K — total $30K so each strategy gets a meaningful slice on invest.
    await fundFromWhale(usdcContract, alice.address, usdc("20000"));
    await fundFromWhale(usdcContract, bob.address, usdc("10000"));

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
      INTEGRATION_DEPOSIT_CAP, // defaultUserCap — match vault total for integration tests
      TEST_VERSION_HASH,
    );
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();

    const Aave = await ethers.getContractFactory("AaveV3Strategy");
    const aave = await Aave.deploy(vaultAddr, USDC, AAVE_V3_POOL, A_USDC, TEST_STRATEGY_VERSION_HASH);
    await aave.waitForDeployment();

    const Compound = await ethers.getContractFactory("CompoundV3Strategy");
    const compound = await Compound.deploy(vaultAddr, USDC, COMET_USDC, TEST_STRATEGY_VERSION_HASH);
    await compound.waitForDeployment();

    const Morpho = await ethers.getContractFactory("MorphoStrategy");
    const morpho = await Morpho.deploy(vaultAddr, USDC, STEAKHOUSE_USDC, TEST_STRATEGY_VERSION_HASH);
    await morpho.waitForDeployment();

    await vault
      .connect(owner)
      .addStrategy(await aave.getAddress(), AAVE_TARGET_BPS, AAVE_MAX_BPS);
    await vault
      .connect(owner)
      .addStrategy(await compound.getAddress(), COMPOUND_TARGET_BPS, COMPOUND_MAX_BPS);
    await vault
      .connect(owner)
      .addStrategy(await morpho.getAddress(), MORPHO_TARGET_BPS, MORPHO_MAX_BPS);

    // alice deposits $20K, bob deposits $10K.
    await usdcContract.connect(alice).approve(vaultAddr, usdc("20000"));
    await vault.connect(alice).deposit(usdc("20000"), alice.address);
    await usdcContract.connect(bob).approve(vaultAddr, usdc("10000"));
    await vault.connect(bob).deposit(usdc("10000"), bob.address);

    return {
      vault,
      aave,
      compound,
      morpho,
      usdcContract,
      owner,
      keeper,
      guardian,
      treasury,
      alice,
      bob,
    };
  }

  // ─── 1. Setup sanity ─────────────────────────────────────────
  describe("setup", () => {
    it("test_fork_lifecycle_threeStrategiesRegisteredAndLive", async () => {
      const { vault, aave, compound, morpho } = await loadFixture(deployForkStack);
      expect(await vault.strategyCount()).to.equal(3);

      // currentAPY > 0 confirms each adapter reads from the right live protocol contract.
      // Morpho returns 0 by design (off-chain queried) so we only check Aave + Compound.
      expect(await aave.currentAPY()).to.be.gt(0);
      expect(await compound.currentAPY()).to.be.gt(0);
      expect(await morpho.currentAPY()).to.equal(0);
    });

    it("test_fork_lifecycle_totalAssets_equalsDeposits_atIdle", async () => {
      const { vault } = await loadFixture(deployForkStack);
      // Before any invest, totalAssets should equal sum of deposits (all idle).
      expect(await vault.totalAssets()).to.equal(usdc("30000"));
    });
  });

  // ─── 2. Multi-strategy invest ────────────────────────────────
  describe("invest into all 3 strategies", () => {
    it("test_fork_invest_distributesAcrossThreeStrategies_invariantHolds", async () => {
      const { vault, keeper, aave, compound, morpho, usdcContract } =
        await loadFixture(deployForkStack);
      const vaultAddr = await vault.getAddress();

      // Allocate per targets: 30% / 25% / 20% of $30K = $9K / $7.5K / $6K.
      await vault.connect(keeper).investToStrategy(await aave.getAddress(), usdc("9000"));
      await vault
        .connect(keeper)
        .investToStrategy(await compound.getAddress(), usdc("7500"));
      await vault.connect(keeper).investToStrategy(await morpho.getAddress(), usdc("6000"));

      const idle = await usdcContract.balanceOf(vaultAddr);
      const aaveBal = await aave.balanceOf();
      const compBal = await compound.balanceOf();
      const morphoBal = await morpho.balanceOf();

      // Core ERC-4626 invariant: totalAssets == idle + sum(strategy.balanceOf).
      // Allow $3 tolerance — Morpho conversion + Compound rounding leave dust on entry.
      const reported = await vault.totalAssets();
      const reconstructed = idle + aaveBal + compBal + morphoBal;
      expect(reported).to.be.closeTo(reconstructed, usdc("3"));

      // $7.5K should remain idle (= 25% — the unallocated portion).
      expect(idle).to.be.closeTo(usdc("7500"), usdc("1"));
    });
  });

  // ─── 3. Yield accrual + harvest ──────────────────────────────
  describe("yield accrual + harvest", () => {
    it("test_fork_harvest_after30Days_mintsFeeSharesToTreasury", async () => {
      const { vault, keeper, aave, compound, morpho, treasury } =
        await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(await aave.getAddress(), usdc("9000"));
      await vault
        .connect(keeper)
        .investToStrategy(await compound.getAddress(), usdc("7500"));
      await vault.connect(keeper).investToStrategy(await morpho.getAddress(), usdc("6000"));

      const totalAssetsBefore = await vault.totalAssets();
      const treasuryBefore = await vault.balanceOf(treasury.address);

      await time.increase(30 * 24 * 60 * 60);

      // After 30 days, totalAssets should be > totalAssets pre-time-travel due to interest.
      const totalAssetsAfter = await vault.totalAssets();
      expect(totalAssetsAfter).to.be.gt(totalAssetsBefore);

      await vault.connect(keeper).harvest();

      // Treasury received non-zero shares (=15% of 30-day yield across 3 strategies).
      const treasuryAfter = await vault.balanceOf(treasury.address);
      expect(treasuryAfter).to.be.gt(treasuryBefore);
    });

    it("test_fork_sharePrice_increasesAfterHarvest", async () => {
      const { vault, keeper, aave, compound, morpho, alice } =
        await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(await aave.getAddress(), usdc("9000"));
      await vault
        .connect(keeper)
        .investToStrategy(await compound.getAddress(), usdc("7500"));
      await vault.connect(keeper).investToStrategy(await morpho.getAddress(), usdc("6000"));

      // Share price = totalAssets / totalSupply. convertToAssets(1 share) is the canonical
      // way to read it. Track alice's per-share value through 30 days + harvest.
      const aliceShares = await vault.balanceOf(alice.address);
      const before = await vault.convertToAssets(aliceShares);

      await time.increase(30 * 24 * 60 * 60);
      await vault.connect(keeper).harvest();

      const after = await vault.convertToAssets(aliceShares);
      // Even after Treasury skim (15%), alice's share value is up — net 85% of yield is hers.
      expect(after).to.be.gt(before);
    });
  });

  // ─── 4. Rebalance via divest+invest pair (v2.1+, rebalance() 제거 후) ──
  describe("rebalance via divest+invest pair (Aave → Compound)", () => {
    it("test_fork_divestInvestPair_movesUsdcBetweenLiveProtocols", async () => {
      const { vault, keeper, aave, compound, morpho } =
        await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(await aave.getAddress(), usdc("9000"));
      await vault
        .connect(keeper)
        .investToStrategy(await compound.getAddress(), usdc("7500"));
      await vault.connect(keeper).investToStrategy(await morpho.getAddress(), usdc("6000"));

      const aaveBefore = await aave.balanceOf();
      const compBefore = await compound.balanceOf();

      // v2.1+: Keeper rebalances via divest(over) → invest(under). No contract-level
      // cooldown / 30% cap — Keeper off-chain gates control. SPEC 1.24.
      await vault.connect(keeper).divestFromStrategy(await aave.getAddress(), usdc("1000"));
      // Realized withdraw may be marginally < requested due to aToken index rounding.
      const idle = await (await ethers.getContractAt(
        ["function balanceOf(address) view returns (uint256)"],
        await vault.asset(),
      )).balanceOf(await vault.getAddress());
      const investAmount = idle >= usdc("1000") ? usdc("1000") : idle;
      await vault.connect(keeper).investToStrategy(await compound.getAddress(), investAmount);

      const aaveAfter = await aave.balanceOf();
      const compAfter = await compound.balanceOf();

      // Aave dropped ~$1K, Compound gained ~$1K. ±$3 tolerance for index/conversion drift.
      expect(aaveBefore - aaveAfter).to.be.closeTo(usdc("1000"), usdc("3"));
      expect(compAfter - compBefore).to.be.closeTo(usdc("1000"), usdc("3"));

      // Morpho untouched.
      expect(await morpho.balanceOf()).to.be.closeTo(usdc("6000"), usdc("3"));
    });
  });

  // ─── 5. Withdraw with auto-pull (Pattern B) ─────────────────
  describe("withdraw with auto-pull from strategies", () => {
    it("test_fork_aliceWithdraws_pullsFromIdleAndStrategies", async () => {
      const { vault, keeper, aave, compound, morpho, alice, usdcContract } =
        await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(await aave.getAddress(), usdc("9000"));
      await vault
        .connect(keeper)
        .investToStrategy(await compound.getAddress(), usdc("7500"));
      await vault.connect(keeper).investToStrategy(await morpho.getAddress(), usdc("6000"));

      // After investing $22.5K, only $7.5K idle. alice withdraws $15K → Vault must pull $7.5K
      // from strategies (Pattern B auto-pull).
      const aliceUsdcBefore = await usdcContract.balanceOf(alice.address);
      await vault.connect(alice).withdraw(usdc("15000"), alice.address, alice.address);
      const aliceUsdcAfter = await usdcContract.balanceOf(alice.address);

      expect(aliceUsdcAfter - aliceUsdcBefore).to.equal(usdc("15000"));

      // Total assets dropped by $15K (within $5 dust window — multi-strategy pull = multi
      // dust accumulation across Aave normalized income + Compound rounding + Morpho convert).
      const total = await vault.totalAssets();
      expect(total).to.be.closeTo(usdc("15000"), usdc("5"));
    });

    it("test_fork_pause_userWithdrawStillSucceeds", async () => {
      const { vault, keeper, guardian, aave, alice, usdcContract } =
        await loadFixture(deployForkStack);

      // Half-deposit a strategy then pause via Guardian.
      await vault.connect(keeper).investToStrategy(await aave.getAddress(), usdc("9000"));
      await vault.connect(guardian).pause();

      // alice can still exit even though Vault is paused (spec 2.4 invariant).
      const beforeBal = await usdcContract.balanceOf(alice.address);
      await vault.connect(alice).withdraw(usdc("5000"), alice.address, alice.address);
      const afterBal = await usdcContract.balanceOf(alice.address);
      expect(afterBal - beforeBal).to.equal(usdc("5000"));
    });
  });

  // ─── 6. Emergency exit ─────────────────────────────────────
  describe("emergencyWithdraw across live strategies", () => {
    it("test_fork_emergencyWithdraw_drainsAllAndBlacklists_perStrategy", async () => {
      const { vault, keeper, aave, compound, morpho } =
        await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(await aave.getAddress(), usdc("9000"));
      await vault
        .connect(keeper)
        .investToStrategy(await compound.getAddress(), usdc("7500"));
      await vault.connect(keeper).investToStrategy(await morpho.getAddress(), usdc("6000"));

      for (const strat of [aave, compound, morpho]) {
        const addr = await strat.getAddress();
        await vault.connect(keeper).emergencyWithdraw(addr, "fork-lifecycle-test");
        // Compound emergency drain leaves up to a few wei of cToken dust; treat sub-cent as drained.
        expect(await strat.balanceOf()).to.be.lt(usdc("0.01"));
        const info = await vault.strategyInfo(addr);
        expect(info.isActive).to.equal(false);
        expect(info.isBlacklisted).to.equal(true);
      }
    });
  });

  // ─── 7. End-to-end scenario ────────────────────────────────
  describe("full lifecycle scenario", () => {
    it("test_fork_lifecycle_depositInvestHarvestRebalanceWithdraw", async () => {
      const {
        vault,
        keeper,
        aave,
        compound,
        morpho,
        treasury,
        alice,
        bob,
        usdcContract,
      } = await loadFixture(deployForkStack);
      const vaultAddr = await vault.getAddress();

      // Step 1: invest into all 3 strategies.
      await vault.connect(keeper).investToStrategy(await aave.getAddress(), usdc("9000"));
      await vault
        .connect(keeper)
        .investToStrategy(await compound.getAddress(), usdc("7500"));
      await vault.connect(keeper).investToStrategy(await morpho.getAddress(), usdc("6000"));

      // Step 2: 30 days yield accrual.
      await time.increase(30 * 24 * 60 * 60);

      // Step 3: harvest → Treasury picks up fee shares.
      const treasuryBeforeHarvest = await vault.balanceOf(treasury.address);
      await vault.connect(keeper).harvest();
      const treasuryAfterHarvest = await vault.balanceOf(treasury.address);
      expect(treasuryAfterHarvest).to.be.gt(treasuryBeforeHarvest);

      // Step 4: rebalance via divest+invest pair (v2.1+, SPEC 1.24) — $500 Compound → Aave.
      await vault
        .connect(keeper)
        .divestFromStrategy(await compound.getAddress(), usdc("500"));
      await vault
        .connect(keeper)
        .investToStrategy(await aave.getAddress(), usdc("500"));

      // Step 5: bob full redeem (forces multi-strategy auto-pull).
      const bobShares = await vault.balanceOf(bob.address);
      const bobUsdcBefore = await usdcContract.balanceOf(bob.address);
      await vault.connect(bob).redeem(bobShares, bob.address, bob.address);
      const bobUsdcAfter = await usdcContract.balanceOf(bob.address);
      // bob's principal was $10K — net should be ≥ that (less than $5 dust loss is OK,
      // yield bumps it up but harvest skim trims the upside).
      expect(bobUsdcAfter - bobUsdcBefore).to.be.gte(usdc("9995"));

      // Step 6: alice partial withdraw $5K.
      const aliceUsdcBefore = await usdcContract.balanceOf(alice.address);
      await vault.connect(alice).withdraw(usdc("5000"), alice.address, alice.address);
      const aliceUsdcAfter = await usdcContract.balanceOf(alice.address);
      expect(aliceUsdcAfter - aliceUsdcBefore).to.equal(usdc("5000"));

      // Final invariant: totalAssets == idle + sum(strategies). $5 tolerance for combined dust.
      const idle = await usdcContract.balanceOf(vaultAddr);
      const reconstructed =
        idle + (await aave.balanceOf()) + (await compound.balanceOf()) + (await morpho.balanceOf());
      const reported = await vault.totalAssets();
      expect(reported).to.be.closeTo(reconstructed, usdc("5"));
    });
  });
});
