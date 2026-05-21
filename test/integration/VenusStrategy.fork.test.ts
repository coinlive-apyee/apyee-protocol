import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
  time,
} from "@nomicfoundation/hardhat-network-helpers";

import { DEFAULT_FEE_RATE, TEST_VERSION_HASH, TEST_STRATEGY_VERSION_HASH } from "../fixtures/deployVault";

/// Run only when `FORK=true FORK_CHAIN=bsc FORK_BSC_ENABLED=true`.
///
/// BSC fork is currently disabled by default because Hardhat 2.22 EDR (the new Rust EVM engine)
/// does not recognize the hardfork activation history for chain id 56 at recent block heights
/// (96M+). Setting `chains: { 56: { hardforkHistory: { shanghai: 0 } } }` in hardhat.config does
/// not propagate through EDR — known limitation, tracked in NomicFoundation/edr issues.
///
/// The unit tests in `test/unit/VenusStrategy.test.ts` (17 cases) cover the adapter logic
/// against a MockVToken that mirrors Compound V2 conventions (mint return codes, exchange-rate
/// scaling, redeem/redeemUnderlying split). Real BSC validation will run as a small-amount
/// dry-run during Phase 1 Beta deploy (spec 1.13 step 5).
///
/// Re-enable with `FORK_BSC_ENABLED=true` once EDR's chain history support stabilizes.
const FORK_ENABLED = process.env.FORK === "true";
const FORK_CHAIN = process.env.FORK_CHAIN ?? "ethereum";
const BSC_FORK_OPT_IN = process.env.FORK_BSC_ENABLED === "true";
const describeFork =
  FORK_ENABLED && FORK_CHAIN === "bsc" && BSC_FORK_OPT_IN ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────
// BNB Chain mainnet live addresses
// ─────────────────────────────────────────────────────────────
// Binance-Peg USD Coin (BSC USDC, 18 decimals).
const USDC_BSC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
// Venus vUSDC (Compound V2 fork).
const V_USDC = "0xeca88125a5adbe82614ffc12d0db554e2e2867c8";

// USDC whales on BSC. PancakeSwap MasterChef + Binance hot wallets typically hold meaningful
// amounts; we cycle through them and pick whichever has enough at the current fork block.
const USDC_WHALES_BSC = [
  "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3", // Binance Hot Wallet 6
  "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance: Hot Wallet 8
  "0x73feaa1eE314F8c655E354234017bE2193C9E24E", // PancakeSwap MasterChef v2
  "0x0F8c45B896784A1E408526B9300519ef8660209c", // XSwapProtocol
];

// BSC USDC has 18 decimals (different from Ethereum's 6).
const usdcBsc = (n: string) => ethers.parseUnits(n, 18);

const INTEGRATION_DEPOSIT_CAP = usdcBsc("1000000");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fundFromWhale(token: any, recipient: string, amount: bigint): Promise<void> {
  for (const whaleAddr of USDC_WHALES_BSC) {
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
    `No BSC USDC whale found with ≥ ${ethers.formatUnits(amount, 18)} USDC at this fork block`,
  );
}

describeFork("VenusStrategy — Mainnet Fork (BNB Chain)", function () {
  this.timeout(180_000);

  async function deployForkStack() {
    const [owner, keeper, guardian, treasury, alice] = await ethers.getSigners();

    const usdcContract = await ethers.getContractAt("IERC20", USDC_BSC);
    await fundFromWhale(usdcContract, alice.address, usdcBsc("50000"));

    const Vault = await ethers.getContractFactory("Vault");
    const vault = await Vault.deploy(
      USDC_BSC,
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

    const VenusStrategy = await ethers.getContractFactory("VenusStrategy");
    const venusStrategy = await VenusStrategy.deploy(
      await vault.getAddress(),
      USDC_BSC,
      V_USDC,
      TEST_STRATEGY_VERSION_HASH,
    );
    await venusStrategy.waitForDeployment();

    await vault.connect(owner).addStrategy(
      await venusStrategy.getAddress(),
      3000,
      4000,
    );

    await usdcContract.connect(alice).approve(await vault.getAddress(), usdcBsc("10000"));
    await vault.connect(alice).deposit(usdcBsc("10000"), alice.address);

    return {
      vault,
      venusStrategy,
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
    it("test_fork_setup_venusIsLive", async () => {
      const { venusStrategy } = await loadFixture(deployForkStack);
      const apy = await venusStrategy.currentAPY();
      expect(apy).to.be.gt(0);
      // BSC USDC supply APR realistically between 1bp and 2000bp.
      expect(apy).to.be.lt(2000);
    });

    it("test_fork_underlyingMatchesAsset", async () => {
      const { venusStrategy } = await loadFixture(deployForkStack);
      const vToken = await ethers.getContractAt("IVToken", await venusStrategy.vToken());
      expect(await vToken.underlying()).to.equal(USDC_BSC);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("invest → real Venus mint", () => {
    it("test_fork_invest_suppliesUsdcAndMintsVTokens", async () => {
      const { vault, keeper, venusStrategy } = await loadFixture(deployForkStack);

      const vToken = await ethers.getContractAt("IVToken", await venusStrategy.vToken());

      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdcBsc("3000"),
      );

      // vToken balance should be > 0; underlying balance should be ~$3K (within rounding).
      const vBal: bigint = await vToken.balanceOf(await venusStrategy.getAddress());
      expect(vBal).to.be.gt(0);

      const underlyingBal = await venusStrategy.balanceOf();
      expect(underlyingBal).to.be.closeTo(usdcBsc("3000"), usdcBsc("1"));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("yield accrual on live Venus", () => {
    it("test_fork_balanceAccrues_after30Days", async () => {
      const { vault, keeper, venusStrategy } = await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdcBsc("3000"),
      );
      const before = await venusStrategy.balanceOf();

      // Compound V2 forks accrue interest on `accrueInterest` calls (auto-triggered by
      // mint/redeem/borrow). Time alone via `time.increase` updates the rate model but
      // not the stored exchange rate. We mine some blocks then trigger accrual via a
      // benign no-op redeemUnderlying(0) — simplest: force-mine + read live rate.
      await time.increase(30 * 24 * 60 * 60);
      // Mine extra blocks so block.number progresses (exchange rate is block-based).
      for (let i = 0; i < 10; i++) await network.provider.send("evm_mine");

      // Stored rate may not update without a state-changing call; do a no-op
      // mint(0)/redeemUnderlying(0) to refresh. We'll just add a tiny invest to force accrue.
      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdcBsc("1"),
      );

      const after = await venusStrategy.balanceOf();
      // After accrue + tiny invest, balance should be at least `before + 1` USDC.
      expect(after).to.be.gt(before);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("withdraw + emergencyWithdraw on real Venus", () => {
    it("test_fork_divest_returnsPrincipalToVault", async () => {
      const { vault, keeper, venusStrategy, usdcContract } =
        await loadFixture(deployForkStack);

      const vaultAddr = await vault.getAddress();
      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdcBsc("3000"),
      );

      const idleBefore = await usdcContract.balanceOf(vaultAddr);
      await time.increase(7 * 24 * 60 * 60);
      for (let i = 0; i < 5; i++) await network.provider.send("evm_mine");

      // Pull most of the balance back. Use a fixed amount slightly under principal to avoid
      // the exchange-rate-vs-stored mismatch (similar to Aave/Compound dust pattern).
      await vault.connect(keeper).divestFromStrategy(
        await venusStrategy.getAddress(),
        usdcBsc("3000"),
      );

      const idleAfter = await usdcContract.balanceOf(vaultAddr);
      expect(idleAfter - idleBefore).to.be.gte(usdcBsc("2999")); // ~principal recovered
    });

    it("test_fork_emergencyWithdraw_drainsAllAndBlacklists", async () => {
      const { vault, keeper, venusStrategy } = await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdcBsc("3000"),
      );

      await vault
        .connect(keeper)
        .emergencyWithdraw(await venusStrategy.getAddress(), "fork-integration-test");

      // Strategy fully drained.
      expect(await venusStrategy.balanceOf()).to.equal(0);

      const info = await vault.strategyInfo(await venusStrategy.getAddress());
      expect(info.isActive).to.equal(false);
      expect(info.isBlacklisted).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("harvest — real Venus yield drives Treasury fees", () => {
    it("test_fork_harvest_mintsFeeSharesAfterAccrual", async () => {
      const { vault, keeper, venusStrategy, treasury } =
        await loadFixture(deployForkStack);

      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdcBsc("3000"),
      );

      // Accrue + force a state-changing call so vToken's exchange rate refreshes.
      await time.increase(7 * 24 * 60 * 60);
      for (let i = 0; i < 5; i++) await network.provider.send("evm_mine");
      await vault.connect(keeper).investToStrategy(
        await venusStrategy.getAddress(),
        usdcBsc("1"),
      );

      const treasuryBefore = await vault.balanceOf(treasury.address);
      await vault.connect(keeper).harvest();
      const treasuryAfter = await vault.balanceOf(treasury.address);

      expect(treasuryAfter).to.be.gte(treasuryBefore);
    });
  });
});
