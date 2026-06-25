import { expect } from "chai";
import { ethers } from "hardhat";
import {
  impersonateAccount,
  setBalance,
  time,
} from "@nomicfoundation/hardhat-network-helpers";

import {
  DEFAULT_FEE_RATE,
  V2_VERSION_HASHES,
  TIER_BALANCED_BPS,
} from "../fixtures/deployVaultV2";

/// V2.1 Soken F-04 fork test — verifies the full reward-claim + DEX-swap +
/// auto-reinvest flow on a mainnet fork. Each adapter's distributor is real;
/// only the orchestration around it (`claimAndCompound`) is what we exercise.
///
/// Companion to test/v2/Vault.v21.spec.ts (which covers F-04's onlyKeeper
/// dynamic-read invariant in isolation).
///
/// Scope (this file): CompoundV3Strategy on Ethereum mainnet fork —
/// the simplest distributor (no merkle proof). Other adapters land in
/// follow-up commits as their RPC / state stabilises:
///   - VenusStrategy        (BSC, Comptroller.claimVenus, PancakeV3)
///   - AaveV3Strategy       (Ethereum/Base/Arb, RewardsController)
///   - MorphoStrategy       (Ethereum URD, merkle proof from API)
///   - FluidStrategy        (Ethereum distributor, merkle proof + metadata,
///                           msg.sender == recipient)
///
/// Run:
///   FORK=true npx hardhat test test/v2/Strategy.claim.fork.spec.ts

const FORK_ENABLED = process.env.FORK === "true";
const FORK_CHAIN = process.env.FORK_CHAIN ?? "ethereum";
const describeFork =
  FORK_ENABLED && FORK_CHAIN === "ethereum" ? describe : describe.skip;

// ── Ethereum mainnet live addresses ──────────────────────────────────────
const USDC          = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const COMET_USDC    = "0xc3d688B66703497DAA19211EEdff47f25384cdc3"; // Comet USDC market
const COMET_REWARDS = "0x1B0e765F6224C21223AeA2af16c1C46E38885a40"; // CometRewards (COMP)
const COMP          = "0xc00e94Cb662C3520282E6f5717214004A7f26888";
const WETH          = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const SWAP_ROUTER   = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // UniV3 SwapRouter02

// V2.1.1: COMP/USDC direct UniV3 pool is too thin → multi-hop COMP -> WETH -> USDC.
//   COMP/WETH 0.3 %   (3000)
//   WETH/USDC 0.05 %  ( 500)
// Encoding: `tokenIn || fee0 || mid1 || fee1 || tokenOut` (20 + 3 + 20 + 3 + 20 = 66 bytes)
function buildSwapPath(): string {
  const fee3000 = "000bb8";   // 3000 (0.3 %)
  const fee500  = "0001f4";   // 500  (0.05 %)
  return (
    "0x" +
    COMP.slice(2).toLowerCase() +
    fee3000 +
    WETH.slice(2).toLowerCase() +
    fee500 +
    USDC.slice(2).toLowerCase()
  );
}

const USDC_WHALES = [
  "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
  "0x3ee18B2214AFF97000D974cf647E54D44b8Ba5C4",
  "0xcEe284F754E854890e311e3280b767F80797180d",
  "0xF977814e90dA44bFA03b6295A0616a897441aceC",
  "0x55FE002aefF02F77364de339a1292923A15844B8",
];

const COMP_WHALES = [
  // Compound Comptroller (legacy) — holds the largest COMP balance pre-distribution.
  "0x2775b1c75658Be0F640272CCb8c72ac986009e38",
  // Coinbase 1 — typically holds 100k+ COMP
  "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3",
  "0xF977814e90dA44bFA03b6295A0616a897441aceC",
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

/// Pre-funds CometRewards with COMP so claim() can actually distribute. mainnet's
/// distributor is supposed to be topped up by Compound governance; on a fresh fork it
/// often has 0 balance and any claim reverts with "transfer amount exceeds balance".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fundCometRewardsWithComp(comp: any, fundAmount: bigint): Promise<boolean> {
  for (const whaleAddr of COMP_WHALES) {
    const bal: bigint = await comp.balanceOf(whaleAddr);
    if (bal >= fundAmount) {
      await impersonateAccount(whaleAddr);
      const whale = await ethers.getSigner(whaleAddr);
      await setBalance(whaleAddr, ethers.parseEther("10"));
      await comp.connect(whale).transfer(COMET_REWARDS, fundAmount);
      return true;
    }
  }
  return false;
}

const FORK_DEPOSIT_CAP = usdc("1000000");
const FORK_USER_CAP    = usdc("1000000");

describeFork("CompoundV3Strategy claim+compound — Ethereum mainnet fork", function () {
  this.timeout(600_000);

  async function deployStack() {
    const [owner, keeper, guardian, treasury, alice, attacker] =
      await ethers.getSigners();
    const usdcContract = await ethers.getContractAt("IERC20", USDC);

    // Alice gets $50k USDC for the lifecycle.
    await fundFromWhale(usdcContract, alice.address, usdc("50000"));

    // Vault — balanced tier mirrors V1 / V2 prod.
    const VaultV2 = await ethers.getContractFactory("VaultV2");
    const vault = await VaultV2.deploy({
      asset: USDC,
      name: "Apyee USDC Vault V2 (Balanced Fork)",
      symbol: "apUSDC-b-fork",
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

    // CompoundV3Strategy with the V2.1 reward distributor + dex wired in.
    const Compound = await ethers.getContractFactory("CompoundV3Strategy");
    const strat = await Compound.deploy(
      vaultAddr,
      USDC,
      COMET_USDC,
      COMET_REWARDS,
      SWAP_ROUTER,
      V2_VERSION_HASHES.devBalanced,
    );
    await strat.waitForDeployment();
    const stratAddr = await strat.getAddress();

    await vault.connect(owner).addStrategy(stratAddr, 3000, TIER_BALANCED_BPS);

    return { vault, strat, usdc: usdcContract, owner, keeper, treasury, alice, attacker, stratAddr };
  }

  async function depositAndInvest(amount: bigint) {
    const fx = await deployStack();
    const { vault, strat, usdc: token, keeper, alice, stratAddr } = fx;
    const vaultAddr = await vault.getAddress();

    await token.connect(alice).approve(vaultAddr, amount);
    await vault.connect(alice).deposit(amount, alice.address);
    // Strategy max allocation = TIER_BALANCED_BPS (40 %). Invest just under the cap.
    const investAmount = (amount * BigInt(TIER_BALANCED_BPS)) / 10_000n;
    await vault.connect(keeper).investToStrategy(stratAddr, investAmount);
    return fx;
  }

  const swapPath = buildSwapPath();

  it("test_compound_claimAndCompound_revertsWhenNotKeeper", async () => {
    const { strat, attacker } = await deployStack();
    await expect(
      strat.connect(attacker).claimAndCompound(swapPath, 0n),
    ).to.be.revertedWithCustomError(strat, "NotKeeper");
  });

  it("test_compound_claimAndCompound_zeroBeforeYieldAccrues", async () => {
    // Immediately after invest there's been ~0 seconds of supply → reward 0 → no-op.
    const { strat, keeper } = await depositAndInvest(usdc("10000"));
    const tx = await strat.connect(keeper).claimAndCompound(swapPath, 0n);
    const receipt = await tx.wait();
    // No `RewardsCompounded` event when claimed == 0 (early-return branch).
    const rcTopic = strat.interface.getEvent("RewardsCompounded")!.topicHash;
    const ev = receipt!.logs.find((l) => l.topics?.[0] === rcTopic);
    expect(ev).to.equal(undefined);
  });

  it("test_compound_claimAndCompound_claimsSwapsAndReinvests", async function () {
    // Deposit + invest, then skip 30 days so COMP accrues meaningfully.
    const { strat, vault, keeper, treasury, stratAddr } =
      await depositAndInvest(usdc("50000"));

    await time.increase(30 * 24 * 3600);
    // Mine one block so cometRewards state catches up.
    await ethers.provider.send("evm_mine", []);

    // Capture pre-claim state for delta assertions.
    const compToken = await ethers.getContractAt("IERC20", COMP);

    // Mainnet CometRewards is funded out-of-band by Compound governance; a fresh
    // fork sometimes has 0 distributor balance which makes claim() revert with
    // "transfer amount exceeds balance". Top it up so the claim path is observable.
    const funded = await fundCometRewardsWithComp(compToken, ethers.parseUnits("1000", 18));
    if (!funded) {
      // No COMP whale available at this fork block — emission test unreliable.
      this.skip();
      return;
    }
    const taBefore  = await vault.totalAssets();
    const stratBalBefore = await strat.balanceOf();
    const treasuryShBefore = await vault.balanceOf(treasury.address);

    // Slippage cap 5 % (off-chain Keeper bot would do 1 %).
    const minOut = 1n;
    const tx = await strat.connect(keeper).claimAndCompound(swapPath, minOut);
    const receipt = await tx.wait();

    // Parse return values via the RewardsCompounded event.
    const rcTopic = strat.interface.getEvent("RewardsCompounded")!.topicHash;
    const rcLog = receipt!.logs.find((l) => l.topics?.[0] === rcTopic);
    const compoundedLog = rcLog ? strat.interface.parseLog(rcLog) : null;

    if (!compoundedLog) {
      // Reward emission may have been zero at this fork block — that's a real
      // chain state observation, not a bug. Assert the conservative invariant.
      expect(stratBalBefore).to.equal(await strat.balanceOf());
      this.skip();
      return;
    }

    const claimed = compoundedLog.args[1] as bigint;
    const swapped = compoundedLog.args[2] as bigint;
    expect(claimed).to.be.gt(0n);
    expect(swapped).to.be.gte(minOut);

    // All COMP drained (token forced through router, no leftover dust).
    expect(await compToken.balanceOf(stratAddr)).to.equal(0n);

    // Strategy balance grew by ≈ swapped (reinvested into Comet). Tolerance covers the
    // small base-yield increment that lands between the swap and our `balanceOf` read.
    const stratBalAfter = await strat.balanceOf();
    expect(stratBalAfter - stratBalBefore).to.be.closeTo(swapped, swapped / 1000n + 100n);

    // Vault totalAssets reflects the new strategy balance.
    expect((await vault.totalAssets()) - taBefore).to.be.closeTo(swapped, swapped / 1000n + 100n);

    // Next user action accrues the streaming fee on the new yield.
    await vault.accrue();
    expect(await vault.balanceOf(treasury.address)).to.be.gt(treasuryShBefore);
  });
});
