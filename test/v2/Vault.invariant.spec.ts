import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployVaultV2Fixture,
  TIER_BALANCED_BPS,
} from "../fixtures/deployVaultV2";

const usdc = (n: string) => ethers.parseUnits(n, 6);

/// V2 invariant suite — CLAUDE.md §5.2.
///
/// Two safety-critical invariants must hold after every state-changing user/keeper/owner
/// action:
///   I1. **totalAssets() = idle + Σ strategy.balanceOf** (active OR blacklisted strategies count)
///   I2. **share price (sp) monotonic** along yield-only paths (deposit / withdraw / invest /
///       divest / time-skip). Loss simulation breaks I2 by design; _accrue mints dilutive
///       shares, also dropping sp briefly. This suite focuses on yield-only paths.

async function deployWithStrategies() {
  const ctx = await loadFixture(deployVaultV2Fixture);
  const MockStrategy = await ethers.getContractFactory("MockStrategy");

  // Second strategy so Σ strategy.balanceOf has more than one term.
  const strat2 = await MockStrategy.deploy(
    await ctx.vault.getAddress(),
    await ctx.usdc.getAddress(),
  );
  await strat2.waitForDeployment();

  // Raise per-user cap so deposit can fund big invests cleanly.
  await ctx.vault.connect(ctx.owner).setUserCap(ctx.alice.address, usdc("1000000"));
  await ctx.vault.connect(ctx.owner).setUserCap(ctx.bob.address, usdc("1000000"));

  await ctx.vault.connect(ctx.owner).addStrategy(
    await ctx.strategy.getAddress(),
    2000,
    TIER_BALANCED_BPS,
  );
  await ctx.vault.connect(ctx.owner).addStrategy(
    await strat2.getAddress(),
    1500,
    TIER_BALANCED_BPS,
  );

  return { ...ctx, strat2 };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sumStrategyBalances(vault: any, strats: any[]): Promise<bigint> {
  let s = 0n;
  for (const st of strats) {
    s += await st.balanceOf();
  }
  return s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assertI1(vault: any, token: any, strats: any[], label: string) {
  const idle: bigint = await token.balanceOf(await vault.getAddress());
  const stratSum = await sumStrategyBalances(vault, strats);
  const ta: bigint = await vault.totalAssets();
  expect(ta, `I1 mismatch after ${label}`).to.equal(idle + stratSum);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sharePrice(vault: any): Promise<bigint> {
  // sp = TA * 1e18 / TS (matches _calcSharePrice). 0 supply → return 1e18 as proxy.
  const ts: bigint = await vault.totalSupply();
  if (ts === 0n) return 10n ** 18n;
  const ta: bigint = await vault.totalAssets();
  return (ta * 10n ** 18n) / ts;
}

describe("VaultV2 invariants", () => {
  it("test_inv_I1_holds_through_full_lifecycle", async () => {
    const { vault, usdc: token, alice, bob, keeper, strategy, strat2 } =
      await deployWithStrategies();
    const strats = [strategy, strat2];

    await assertI1(vault, token, strats, "fresh deploy");

    // 1) deposit
    await token.connect(alice).approve(await vault.getAddress(), usdc("50000"));
    await vault.connect(alice).deposit(usdc("20000"), alice.address);
    await assertI1(vault, token, strats, "alice deposit 20k");

    // 2) invest to two strategies
    await vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("4000"));
    await assertI1(vault, token, strats, "invest 4k → strat1");
    await vault.connect(keeper).investToStrategy(await strat2.getAddress(), usdc("3000"));
    await assertI1(vault, token, strats, "invest 3k → strat2");

    // 3) second user deposit
    await token.connect(bob).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(bob).deposit(usdc("10000"), bob.address);
    await assertI1(vault, token, strats, "bob deposit 10k");

    // 4) yield via simulateYield (MockStrategy directly bumps principal)
    await strategy.simulateYield(usdc("200"));
    await strat2.simulateYield(usdc("150"));
    await assertI1(vault, token, strats, "yield accrual on both strats");

    // 5) divest partially
    await vault.connect(keeper).divestFromStrategy(await strategy.getAddress(), usdc("1500"));
    await assertI1(vault, token, strats, "divest 1.5k from strat1");

    // 6) accrue (treasury mint changes TS but TA stays)
    await time.increase(1);
    await vault.accrue();
    await assertI1(vault, token, strats, "explicit accrue");

    // 7) bob redeems half — auto-pull may fire if idle short
    const bobShares = await vault.balanceOf(bob.address);
    await vault.connect(bob).redeem(bobShares / 2n, bob.address, bob.address);
    await assertI1(vault, token, strats, "bob partial redeem");

    // 8) alice redeems all — likely triggers auto-pull across strats
    const aliceShares = await vault.balanceOf(alice.address);
    await vault.connect(alice).redeem(aliceShares, alice.address, alice.address);
    await assertI1(vault, token, strats, "alice full redeem");
  });

  it("test_inv_I2_sharePriceMonotonic_underYieldOnly", async () => {
    const { vault, usdc: token, alice, keeper, strategy } =
      await deployWithStrategies();

    await token.connect(alice).approve(await vault.getAddress(), usdc("50000"));
    await vault.connect(alice).deposit(usdc("20000"), alice.address);
    let prev = await sharePrice(vault);

    // Series of yield-only actions; sp should never decrease between observations
    // taken at the SAME accrual baseline (i.e. we don't call accrue between checks,
    // so dilutive mints can't break monotonicity).
    await vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("5000"));
    let cur = await sharePrice(vault);
    expect(cur, "I2 after invest").to.be.gte(prev);
    prev = cur;

    await strategy.simulateYield(usdc("100"));
    cur = await sharePrice(vault);
    expect(cur, "I2 after 100 yield").to.be.gte(prev);
    prev = cur;

    await time.increase(7 * 24 * 3600);
    await strategy.simulateYield(usdc("50"));
    cur = await sharePrice(vault);
    expect(cur, "I2 after 7d + 50 yield").to.be.gte(prev);
    prev = cur;

    // Divest doesn't add or remove value (it's a transfer) → sp invariant under divest.
    await vault.connect(keeper).divestFromStrategy(await strategy.getAddress(), usdc("1000"));
    cur = await sharePrice(vault);
    expect(cur, "I2 after divest").to.be.gte(prev);
  });

  it("test_inv_I1_holds_after_emergencyWithdraw_and_blacklist", async () => {
    const { vault, usdc: token, alice, keeper, strategy, strat2 } =
      await deployWithStrategies();
    const strats = [strategy, strat2];

    await token.connect(alice).approve(await vault.getAddress(), usdc("50000"));
    await vault.connect(alice).deposit(usdc("30000"), alice.address);
    await vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("5000"));
    await vault.connect(keeper).investToStrategy(await strat2.getAddress(), usdc("3000"));

    // emergencyWithdraw pulls all funds back AND blacklists the strategy.
    // totalAssets() must still include blacklisted strategies in its sum.
    await vault.connect(keeper).emergencyWithdraw(await strategy.getAddress());
    await assertI1(vault, token, strats, "after emergencyWithdraw strat1");

    // Withdraw 50% to ensure auto-pull only touches the (still-active) strat2.
    const aliceShares = await vault.balanceOf(alice.address);
    await vault.connect(alice).redeem(aliceShares / 2n, alice.address, alice.address);
    await assertI1(vault, token, strats, "after partial redeem (auto-pull strat2)");
  });
});
