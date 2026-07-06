import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { deployVaultV2Fixture, TIER_BALANCED_BPS } from "../fixtures/deployVaultV2";

/// V2.1.2 — `_convertToAssets` / `_convertToShares` are overridden to include
/// `_pendingFeeShares()` in the divisor so that view-side helpers reflect the
/// dilution that `_accrue()` would apply on the next transactional call.
///
/// Without the override, a user hitting MAX with the pre-fix `maxWithdraw` value
/// triggered `ERC4626ExceededMaxWithdraw` inside `withdraw()` (which calls
/// `_accrue()` first, minting treasury shares, reducing effective max by a small
/// residual equal to the fee that would be minted mid-tx).
///
/// The transactional paths call `_accrue()` before `_convertToAssets`, so
/// `_pendingFeeShares()` returns 0 there → override is a no-op on the tx path
/// and a correction only on external view queries.

describe("V2.1.2 mitigation — accrue-aware maxWithdraw / previewWithdraw", () => {
  async function fixture() {
    const fx = await deployVaultV2Fixture("balanced");
    const depositAmt = ethers.parseUnits("5000", 6);
    await fx.usdc.connect(fx.alice).approve(await fx.vault.getAddress(), depositAmt);
    await fx.vault.connect(fx.alice).deposit(depositAmt, fx.alice.address);
    // Wire a whitelisted strategy so Keeper can invest.
    await fx.vault
      .connect(fx.owner)
      .addStrategy(await fx.strategy.getAddress(), 3000, TIER_BALANCED_BPS);
    const investAmt = (depositAmt * BigInt(TIER_BALANCED_BPS)) / 10_000n;
    await fx.vault
      .connect(fx.keeper)
      .investToStrategy(await fx.strategy.getAddress(), investAmt);
    return fx;
  }

  /// Nudge the mock strategy to report yield, which grows share price and creates
  /// pending fee shares — the exact precondition where the pre-fix view returned
  /// a max larger than the transactional path would honor.
  ///
  /// MockStrategy.balanceOf() returns `_principal`, not raw USDC balance. Use
  /// `simulateYield` to bump `_principal` (mirrors real strategies that report
  /// yield growth through their protocol view — e.g. Aave `aToken.balanceOf`).
  /// Also mint the underlying USDC so `withdraw`/`redeem` paths can pull the
  /// balance back to the Vault later.
  async function accrueSomeYield(fx: Awaited<ReturnType<typeof fixture>>, yieldAmt: bigint) {
    await fx.usdc.mint(await fx.strategy.getAddress(), yieldAmt);
    await fx.strategy.simulateYield(yieldAmt);
  }

  it("test_maxWithdraw_reflectsPendingAccrue", async () => {
    // After yield growth, pendingFeeShares > 0. maxWithdraw must show the
    // post-accrue value (smaller than a naïve totalAssets × shares / totalSupply).
    const fx = await loadFixture(fixture);
    await accrueSomeYield(fx, ethers.parseUnits("100", 6));

    const pending = await fx.vault.pendingFeeShares();
    expect(pending, "yield growth should produce pending fee shares").to.be.gt(0n);

    const max = await fx.vault.maxWithdraw(fx.alice.address);
    // The pre-fix (naïve) value equals shares × totalAssets / totalSupply.
    // The post-fix value uses (totalSupply + pending) in the divisor → strictly smaller.
    const shares = await fx.vault.balanceOf(fx.alice.address);
    const totalAssets = await fx.vault.totalAssets();
    const totalSupply = await fx.vault.totalSupply();
    // Approximate naïve calc; the exact formula includes +1/+decimalsOffset but the
    // inequality direction is what matters.
    const naive = (shares * (totalAssets + 1n)) / (totalSupply + 10n ** 6n); // decimalsOffset=6
    expect(max, "maxWithdraw must be strictly less than pre-fix naïve value").to.be.lt(naive);
  });

  it("test_withdraw_maxAmount_afterYieldAccrual_succeeds", async () => {
    // The primary regression case reported from the frontend. Query maxWithdraw,
    // then withdraw that exact amount → must NOT revert.
    const fx = await loadFixture(fixture);
    await accrueSomeYield(fx, ethers.parseUnits("100", 6));

    const max = await fx.vault.maxWithdraw(fx.alice.address);
    expect(max).to.be.gt(0n);

    // Pre-fix behavior: this would revert `ERC4626ExceededMaxWithdraw` because
    // the internal `_accrue()` inside `withdraw()` shrinks the effective max
    // before the check runs. Post-fix: view already includes the pending fee.
    await expect(
      fx.vault.connect(fx.alice).withdraw(max, fx.alice.address, fx.alice.address),
    ).to.not.be.reverted;
  });

  it("test_previewWithdraw_matchesActualBurn_afterYield", async () => {
    // previewWithdraw is what dApps use to preview share burn — must match the
    // actual burn amount that `withdraw()` performs (post-accrue).
    const fx = await loadFixture(fixture);
    await accrueSomeYield(fx, ethers.parseUnits("50", 6));

    const amt = ethers.parseUnits("100", 6);
    const previewed = await fx.vault.previewWithdraw(amt);
    const sharesBefore = await fx.vault.balanceOf(fx.alice.address);
    await fx.vault.connect(fx.alice).withdraw(amt, fx.alice.address, fx.alice.address);
    const sharesAfter = await fx.vault.balanceOf(fx.alice.address);

    const actualBurn = sharesBefore - sharesAfter;
    // Preview should match actual burn exactly (both accrue-aware).
    expect(actualBurn).to.equal(previewed);
  });

  it("test_convertToAssets_zeroYield_matchesBaseOZ", async () => {
    // When share price has not grown since last accrue, pendingFeeShares == 0
    // → override is a no-op → convertToAssets identical to the pre-fix path.
    const fx = await loadFixture(fixture);
    // No yield injected. Verify the invariant hold.
    const pending = await fx.vault.pendingFeeShares();
    expect(pending).to.equal(0n);

    const shares = await fx.vault.balanceOf(fx.alice.address);
    const assets = await fx.vault.convertToAssets(shares);
    // Round-trip should return roughly the shares back.
    const roundTrip = await fx.vault.convertToShares(assets);
    // Rounding can shave 1 wei; the invariant is: round-trip does not inflate.
    expect(roundTrip).to.be.lte(shares);
  });
});
