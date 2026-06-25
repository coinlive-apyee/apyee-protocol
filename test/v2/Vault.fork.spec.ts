import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
  time,
} from "@nomicfoundation/hardhat-network-helpers";

import { DEFAULT_FEE_RATE, V2_VERSION_HASHES, TIER_BALANCED_BPS } from "../fixtures/deployVaultV2";

/// VaultV2 fork integration test. Same shape as test/integration/VaultLifecycle.fork.test.ts
/// (V1) but against the V2 contract — verifies streaming fee accrual against real protocol
/// yield (not synthetic mints).
///
/// Scope (PR2 baseline):
///   - Single chain (Ethereum mainnet fork)
///   - Single tier (Balanced — V1 parity)
///   - 3 strategies (Aave V3, Compound V3, Morpho/Steakhouse)
///   - Lifecycle: deposit → invest → yield (time skip) → accrue → withdraw → fee correctness
///
/// PR3 will extend to the full hypothetical 5~6 Vault matrix (per-tier × per-chain dry-run).

const FORK_ENABLED = process.env.FORK === "true";
const FORK_CHAIN = process.env.FORK_CHAIN ?? "ethereum";
const describeFork =
  FORK_ENABLED && FORK_CHAIN === "ethereum" ? describe : describe.skip;

// Ethereum mainnet live addresses
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

// $1M cap to bypass V2 default user cap during integration scenarios.
const FORK_DEPOSIT_CAP = usdc("1000000");
const FORK_USER_CAP = usdc("1000000");

describeFork("VaultV2 Lifecycle — Mainnet Fork (Ethereum, Balanced tier)", function () {
  this.timeout(300_000);

  async function deployForkStack() {
    const [owner, keeper, guardian, treasury, alice, bob] = await ethers.getSigners();

    const usdcContract = await ethers.getContractAt("IERC20", USDC);

    // alice $20K, bob $10K
    await fundFromWhale(usdcContract, alice.address, usdc("20000"));
    await fundFromWhale(usdcContract, bob.address, usdc("10000"));

    // Deploy VaultV2 — Balanced tier (cap 4000 bps).
    const VaultV2 = await ethers.getContractFactory("VaultV2");
    const vault = await VaultV2.deploy({
      asset: USDC,
      name: "Apyee USDC Vault V2 (Balanced)",
      symbol: "apUSDC-b",
      initialOwner: owner.address,
      keeper: keeper.address,
      guardian: guardian.address,
      treasury: treasury.address,
      feeRate: DEFAULT_FEE_RATE,
      depositCap: FORK_DEPOSIT_CAP,
      defaultUserCap: FORK_USER_CAP,
      maxAllocationAbsolute: TIER_BALANCED_BPS,
      versionHash: V2_VERSION_HASHES.devBalanced,
    });
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();

    // Deploy 3 strategies (Aave / Compound / Morpho) — use V1 adapter code (V2 reuses).
    // V2.1 (Soken F-04): extra constructor args for reward distributors + dexRouter; fork
    // spec opts out (ZeroAddress) so the claim path is dormant — invest/withdraw/balanceOf
    // semantics under test are unaffected.
    const Aave = await ethers.getContractFactory("AaveV3Strategy");
    const aaveStrat = await Aave.deploy(
      vaultAddr, USDC, AAVE_V3_POOL, A_USDC,
      ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
      V2_VERSION_HASHES.devBalanced,
    );
    await aaveStrat.waitForDeployment();

    const Compound = await ethers.getContractFactory("CompoundV3Strategy");
    const compoundStrat = await Compound.deploy(
      vaultAddr, USDC, COMET_USDC,
      ethers.ZeroAddress, ethers.ZeroAddress,
      V2_VERSION_HASHES.devBalanced,
    );
    await compoundStrat.waitForDeployment();

    const Morpho = await ethers.getContractFactory("MorphoStrategy");
    const morphoStrat = await Morpho.deploy(
      vaultAddr, USDC, STEAKHOUSE_USDC,
      ethers.ZeroAddress, ethers.ZeroAddress,
      V2_VERSION_HASHES.devBalanced,
    );
    await morphoStrat.waitForDeployment();

    // Register strategies. targetBps mirrors 00-config.ts; maxBps = tier cap (4000).
    await vault.connect(owner).addStrategy(await aaveStrat.getAddress(),     3000, TIER_BALANCED_BPS);
    await vault.connect(owner).addStrategy(await compoundStrat.getAddress(), 2500, TIER_BALANCED_BPS);
    await vault.connect(owner).addStrategy(await morphoStrat.getAddress(),   2000, TIER_BALANCED_BPS);

    return {
      vault, usdc: usdcContract, owner, keeper, guardian, treasury, alice, bob,
      aaveStrat, compoundStrat, morphoStrat,
    };
  }

  it("test_fork_lifecycle_depositInvestYieldAccrueWithdraw", async () => {
    const { vault, usdc: token, alice, keeper, treasury, aaveStrat } =
      await loadFixture(deployForkStack);

    // ── deposit ──
    await token.connect(alice).approve(await vault.getAddress(), usdc("20000"));
    await vault.connect(alice).deposit(usdc("20000"), alice.address);
    expect(await vault.totalAssets()).to.equal(usdc("20000"));

    // Baseline lazy-init must have set lastSharePrice on first deposit.
    const lastSpAfterDeposit = await vault.lastSharePrice();
    expect(lastSpAfterDeposit).to.be.gt(0);

    // ── invest 30% to Aave (3000 / 10000 = $6K) ──
    await vault.connect(keeper).investToStrategy(await aaveStrat.getAddress(), usdc("6000"));
    expect(await aaveStrat.balanceOf()).to.be.closeTo(usdc("6000"), 10n); // tolerance for Aave's rayMul rounding

    // ── time skip 30 days → Aave aUSDC accrues yield ──
    await time.increase(30 * 24 * 3600);
    const aaveBalAfter = await aaveStrat.balanceOf();
    expect(aaveBalAfter).to.be.gt(usdc("6000")); // real yield accrued

    // ── accrue (anyone) → fee mints to treasury ──
    await vault.accrue();
    const treasuryShares = await vault.balanceOf(treasury.address);
    expect(treasuryShares).to.be.gt(0); // streaming fee captured 15% of the yield curve

    // ── partial withdraw → auto-pull from Aave triggers _withdraw → _accrue (idempotent) ──
    const aliceShares = await vault.balanceOf(alice.address);
    const withdrawShares = aliceShares / 4n;
    const beforeRedeemBal = await token.balanceOf(alice.address);
    await vault.connect(alice).redeem(withdrawShares, alice.address, alice.address);
    const afterRedeemBal = await token.balanceOf(alice.address);
    expect(afterRedeemBal).to.be.gt(beforeRedeemBal); // received USDC out
  });

  it("test_fork_pendingFeeShares_matchesActualMint_underRealYield", async () => {
    const { vault, usdc: token, alice, keeper, treasury, aaveStrat } =
      await loadFixture(deployForkStack);
    await token.connect(alice).approve(await vault.getAddress(), usdc("20000"));
    await vault.connect(alice).deposit(usdc("20000"), alice.address);
    await vault.connect(keeper).investToStrategy(await aaveStrat.getAddress(), usdc("6000"));

    await time.increase(30 * 24 * 3600);

    const pending = await vault.pendingFeeShares();
    expect(pending).to.be.gt(0);

    await vault.accrue();
    const actual = await vault.balanceOf(treasury.address);

    // pending view (read, no block mined) vs actual mint (write, next block) — Aave aToken
    // 의 매-block 이자가 그 사이 strategy.balanceOf() 를 흘려 totalAssets 가 미세 증가.
    // unit test (synthetic yield) 에서는 1 wei tolerance 가 가능하지만 fork 환경에서는
    // 1-block worth of real yield 만큼 차이 발생 → 비율 기반 tolerance.
    // 0.001% (= 1e-5 relative) 이면 30일 야이드 (~ 5% APY → 일 1.37bps → 블록 차이 무관) 보다
    // 훨씬 작아 정합성 검증 의미 유지.
    const tolerance = pending / 100_000n;
    expect(actual).to.be.closeTo(pending, tolerance > 1n ? tolerance : 1n);
  });

  it("test_fork_withdrawWhenPaused_stillWorks", async () => {
    const { vault, usdc: token, alice, keeper, guardian, aaveStrat } =
      await loadFixture(deployForkStack);

    await token.connect(alice).approve(await vault.getAddress(), usdc("20000"));
    await vault.connect(alice).deposit(usdc("20000"), alice.address);
    await vault.connect(keeper).investToStrategy(await aaveStrat.getAddress(), usdc("6000"));
    await time.increase(30 * 24 * 3600);

    // Pause AFTER deposit. CLAUDE.md invariant: redeem MUST still succeed.
    await vault.connect(guardian).pause();

    const aliceShares = await vault.balanceOf(alice.address);
    const beforeBal = await token.balanceOf(alice.address);
    await vault.connect(alice).redeem(aliceShares / 4n, alice.address, alice.address);
    expect(await token.balanceOf(alice.address)).to.be.gt(beforeBal);
  });
});
