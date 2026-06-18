import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployVaultV2Fixture,
  TIER_BALANCED_BPS,
} from "../fixtures/deployVaultV2";

const usdc = (n: string) => ethers.parseUnits(n, 6);

/// V2 auto-pull resilience suite — drives the try-catch + `StrategyWithdrawSkipped` path
/// added in response to the V1 BSC Venus dust incident (2026-06-09):
///
/// V1 의 `_pullFromStrategies` 는 strategy.withdraw 가 revert 하면 user 출금 tx 전체가
/// revert 했다. Venus vToken 이 sub-unit underlying (264M wei) 에 대해 redeem 시
/// `redeemTokens zero` revert 를 던지면서 BSC dev vault user 가 출금 못하는 사고 발생.
///
/// V2 는 `try { strategy.withdraw } catch { emit StrategyWithdrawSkipped }` 로 wrap —
/// 한 strategy revert 가 전체 출금을 막지 않고 다음 strategy 로 fallback. 최종 idle
/// 부족 시에만 `IdleInsufficient` revert (user 자금 안전 보장).

async function deployWith2Strats() {
  const ctx = await loadFixture(deployVaultV2Fixture);
  const MockStrategy = await ethers.getContractFactory("MockStrategy");

  const strat2 = await MockStrategy.deploy(
    await ctx.vault.getAddress(),
    await ctx.usdc.getAddress(),
  );
  await strat2.waitForDeployment();

  await ctx.vault.connect(ctx.owner).setUserCap(ctx.alice.address, usdc("1000000"));
  await ctx.vault.connect(ctx.owner).addStrategy(
    await ctx.strategy.getAddress(),
    2000,
    TIER_BALANCED_BPS,
  );
  await ctx.vault.connect(ctx.owner).addStrategy(
    await strat2.getAddress(),
    2000,
    TIER_BALANCED_BPS,
  );

  return { ...ctx, strat2 };
}

describe("VaultV2 auto-pull resilience (try-catch fallback)", () => {
  it("test_autoPull_strategyReverts_skipsAndContinuesToNext", async () => {
    const { vault, usdc: token, alice, keeper, strategy, strat2 } =
      await deployWith2Strats();

    await token.connect(alice).approve(await vault.getAddress(), usdc("50000"));
    await vault.connect(alice).deposit(usdc("50000"), alice.address);

    // 양쪽 strategy 에 자금 분산 (strat1: 10k, strat2: 10k, idle: 30k — balanced cap 40% 이내)
    await vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("10000"));
    await vault.connect(keeper).investToStrategy(await strat2.getAddress(), usdc("10000"));

    // strat1 (insertion order 첫 번째) 가 revert 하도록 — Venus dust 시나리오 시뮬
    await strategy.setRevertOnWithdraw(true);

    // 40k 부분 출금 요청 → idle 30k 부족분 10k → strat1 catch → strat2 에서 10k pull
    const before = await token.balanceOf(alice.address);
    const shares40k = await vault.convertToShares(usdc("40000"));
    const tx = await vault.connect(alice).redeem(shares40k, alice.address, alice.address);
    const rcpt = await tx.wait();
    const after = await token.balanceOf(alice.address);

    expect(after - before).to.be.gte(usdc("39999"));
    expect(after - before).to.be.lte(usdc("40001"));

    // skip event 발행 검증
    const skipped = rcpt!.logs
      .map((l) => { try { return vault.interface.parseLog({ topics: [...l.topics], data: l.data }); } catch { return null; } })
      .filter((p) => p && p.name === "StrategyWithdrawSkipped");
    expect(skipped.length).to.equal(1);
    expect(skipped[0]!.args[0]).to.equal(await strategy.getAddress());
  });

  it("test_autoPull_allStrategiesRevert_revertsIdleInsufficient", async () => {
    const { vault, usdc: token, alice, keeper, strategy, strat2 } =
      await deployWith2Strats();

    await token.connect(alice).approve(await vault.getAddress(), usdc("50000"));
    await vault.connect(alice).deposit(usdc("50000"), alice.address);

    // idle 30k, strat1 10k, strat2 10k — balanced cap 40% 이내
    await vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("10000"));
    await vault.connect(keeper).investToStrategy(await strat2.getAddress(), usdc("10000"));

    // 둘 다 revert
    await strategy.setRevertOnWithdraw(true);
    await strat2.setRevertOnWithdraw(true);

    // 전부 출금 요청 → idle 30k 부족분 20k 필요 → 둘 다 catch → idle 그대로 → IdleInsufficient
    const aliceShares = await vault.balanceOf(alice.address);
    await expect(
      vault.connect(alice).redeem(aliceShares, alice.address, alice.address),
    ).to.be.revertedWithCustomError(vault, "IdleInsufficient");
  });

  it("test_autoPull_partialFallback_userGetsCorrectAmount", async () => {
    const { vault, usdc: token, alice, keeper, strategy, strat2 } =
      await deployWith2Strats();

    await token.connect(alice).approve(await vault.getAddress(), usdc("50000"));
    await vault.connect(alice).deposit(usdc("50000"), alice.address);

    // idle 30k, strat1 10k, strat2 10k — balanced cap 40% 이내
    await vault.connect(keeper).investToStrategy(await strategy.getAddress(), usdc("10000"));
    await vault.connect(keeper).investToStrategy(await strat2.getAddress(), usdc("10000"));

    // strat1 revert. strat2 정상.
    await strategy.setRevertOnWithdraw(true);

    // 35k 출금 (idle 30k + strat2 5k 면 충분, strat1 revert 무관)
    const before = await token.balanceOf(alice.address);
    const shares35k = await vault.convertToShares(usdc("35000"));
    await vault.connect(alice).redeem(shares35k, alice.address, alice.address);
    const after = await token.balanceOf(alice.address);

    expect(after - before).to.be.gte(usdc("34999"));
    expect(after - before).to.be.lte(usdc("35001"));
  });
});
