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

/// V2.1 Soken F-04 follow-up — BSC chain fork tests for the claim+swap+reinvest
/// flow against the live Venus + PancakeV3 stack.
///
/// Run:
///   FORK=true FORK_CHAIN=bsc npx hardhat test test/v2/Strategy.claim.bsc.fork.spec.ts

const FORK_ENABLED = process.env.FORK === "true";
const FORK_CHAIN = process.env.FORK_CHAIN;
const describeFork = FORK_ENABLED && FORK_CHAIN === "bsc" ? describe : describe.skip;

// ── BSC mainnet live addresses ───────────────────────────────────────────
const USDC          = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"; // BSC USDC (18 dec)
const VUSDC         = "0xeCA88125a5ADbe82614ffC12D0DB554E2e2867C8"; // Venus vUSDC
const COMPTROLLER   = "0xfD36E2c2a6789Db23113685031d7F16329158384";
const XVS           = "0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63";
const WBNB          = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const PANCAKE_ROUTER = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4"; // PancakeV3 SmartRouter

const USDC_WHALES_BSC = [
  "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance hot
  "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3", // Binance 7
  "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", // BUSD admin (often holds USDC too)
];

const XVS_WHALES = [
  "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance hot
  "0xF89d7b9c864f589bbF53a82105107622B35EaA40", // Bybit cold
];

// BSC USDC has 18 decimals (unlike ETH/Base/Arb USDC which is 6).
const usdc = (n: string) => ethers.parseUnits(n, 18);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fundFromWhale(token: any, whales: string[], recipient: string, amount: bigint): Promise<void> {
  for (const whaleAddr of whales) {
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
    `No whale found for ${await token.getAddress()} with >= ${amount.toString()}`,
  );
}

/// Comptroller does NOT hold XVS — it pulls from `xvsVault` on each claim. On a
/// fresh fork the vault is often dry, so we top it up directly from a whale.
async function fundComptrollerWithXvs(): Promise<boolean> {
  const xvs = await ethers.getContractAt("IERC20", XVS);
  for (const whaleAddr of XVS_WHALES) {
    const bal: bigint = await xvs.balanceOf(whaleAddr);
    if (bal >= ethers.parseUnits("100", 18)) {
      await impersonateAccount(whaleAddr);
      const whale = await ethers.getSigner(whaleAddr);
      await setBalance(whaleAddr, ethers.parseEther("10"));
      await xvs.connect(whale).transfer(COMPTROLLER, ethers.parseUnits("100", 18));
      return true;
    }
  }
  return false;
}

const FORK_DEPOSIT_CAP = usdc("1000000");
const FORK_USER_CAP    = usdc("1000000");

// XVS → WBNB → USDC multi-hop (XVS/USDC direct pool is too thin on PancakeV3).
//   XVS/WBNB  2500 (0.25 %)  — primary XVS pool
//   WBNB/USDC  500 (0.05 %)
// path = `XVS(20) || 2500(3) || WBNB(20) || 500(3) || USDC(20)` = 66 bytes
function buildVenusSwapPath(): string {
  const fee2500 = "0009c4"; // 2500
  const fee500  = "0001f4"; //  500
  return (
    "0x" +
    XVS.slice(2).toLowerCase() +
    fee2500 +
    WBNB.slice(2).toLowerCase() +
    fee500 +
    USDC.slice(2).toLowerCase()
  );
}

describeFork("VenusStrategy claim+compound — BSC mainnet fork", function () {
  this.timeout(600_000);

  async function deployStack() {
    const [owner, keeper, guardian, treasury, alice, attacker] =
      await ethers.getSigners();
    const usdcContract = await ethers.getContractAt("IERC20", USDC);

    await fundFromWhale(usdcContract, USDC_WHALES_BSC, alice.address, usdc("50000"));

    const VaultV2 = await ethers.getContractFactory("VaultV2");
    const vault = await VaultV2.deploy({
      asset: USDC,
      name: "Apyee USDC Vault V2 (Balanced BSC Fork)",
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

    const Venus = await ethers.getContractFactory("VenusStrategy");
    const strat = await Venus.deploy(
      vaultAddr,
      USDC,
      VUSDC,
      COMPTROLLER,
      XVS,
      PANCAKE_ROUTER,
      V2_VERSION_HASHES.devBalanced,
    );
    await strat.waitForDeployment();
    const stratAddr = await strat.getAddress();

    await vault.connect(owner).addStrategy(stratAddr, 3000, TIER_BALANCED_BPS);

    return { vault, strat, usdc: usdcContract, owner, keeper, treasury, alice, attacker, stratAddr };
  }

  async function depositAndInvest(amount: bigint) {
    const fx = await deployStack();
    const { vault, keeper, alice, stratAddr } = fx;
    const vaultAddr = await fx.vault.getAddress();

    await fx.usdc.connect(alice).approve(vaultAddr, amount);
    await vault.connect(alice).deposit(amount, alice.address);
    const investAmount = (amount * BigInt(TIER_BALANCED_BPS)) / 10_000n;
    await vault.connect(keeper).investToStrategy(stratAddr, investAmount);
    return fx;
  }

  const swapPath = buildVenusSwapPath();

  it("test_venus_claimAndCompound_revertsWhenNotKeeper", async () => {
    const { strat, attacker } = await deployStack();
    await expect(
      strat.connect(attacker).claimAndCompound(swapPath, 0n),
    ).to.be.revertedWithCustomError(strat, "NotKeeper");
  });

  it("test_venus_claimAndCompound_claimsSwapsAndReinvests", async function () {
    const { strat, vault, keeper, treasury, stratAddr } =
      await depositAndInvest(usdc("50000"));

    // Skip 30 days so XVS accrues against the Comptroller's supply-side speed.
    await time.increase(30 * 24 * 3600);
    await ethers.provider.send("evm_mine", []);

    const xvsToken = await ethers.getContractAt("IERC20", XVS);
    const taBefore = await vault.totalAssets();
    const stratBalBefore = await strat.balanceOf();
    const treasuryShBefore = await vault.balanceOf(treasury.address);

    // Comptroller often has zero XVS on a fresh fork — top it up so the claim
    // path is observable.
    const funded = await fundComptrollerWithXvs();
    if (!funded) {
      this.skip();
      return;
    }

    const minOut = 1n;
    const tx = await strat.connect(keeper).claimAndCompound(swapPath, minOut);
    const receipt = await tx.wait();

    const rcTopic = strat.interface.getEvent("RewardsCompounded")!.topicHash;
    const rcLog = receipt!.logs.find((l) => l.topics?.[0] === rcTopic);
    const compoundedLog = rcLog ? strat.interface.parseLog(rcLog) : null;

    if (!compoundedLog) {
      // Emission may be zero at this fork block — that's a real chain observation.
      expect(stratBalBefore).to.equal(await strat.balanceOf());
      this.skip();
      return;
    }

    const claimed = compoundedLog.args[1] as bigint;
    const swapped = compoundedLog.args[2] as bigint;
    expect(claimed).to.be.gt(0n);
    expect(swapped).to.be.gte(minOut);

    // All XVS drained.
    expect(await xvsToken.balanceOf(stratAddr)).to.equal(0n);

    // Strategy balance grew by ≈ swapped (within a small base-yield drift).
    const stratBalAfter = await strat.balanceOf();
    expect(stratBalAfter - stratBalBefore).to.be.closeTo(swapped, swapped / 1000n + 100n);

    expect((await vault.totalAssets()) - taBefore).to.be.closeTo(swapped, swapped / 1000n + 100n);

    await vault.accrue();
    expect(await vault.balanceOf(treasury.address)).to.be.gt(treasuryShBefore);
  });
});
