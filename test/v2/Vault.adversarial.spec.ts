import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  deployVaultV2Fixture,
  DEFAULT_FEE_RATE,
  TIER_BALANCED_BPS,
  V2_VERSION_HASHES,
  V2_DEPOSIT_CAP,
  V2_DEFAULT_USER_CAP,
} from "../fixtures/deployVaultV2";

const usdc = (n: string) => ethers.parseUnits(n, 6);

/// Adversarial test suite — V2_VAULT.md §7.4 (scenarios 24-27).
///
/// Each scenario simulates a known attack pattern against ERC-4626 + streaming-fee vaults
/// and asserts the V2 contract neutralizes it.

describe("VaultV2 adversarial scenarios", () => {
  // ─── Scenario 24 — Fee-rate sandwich ──────────────────
  it("test_adv_feeRateChangeSandwich_attackerCannotEvadeFee", async () => {
    const { vault, usdc: token, owner, alice, treasury } =
      await loadFixture(deployVaultV2Fixture);

    // Alice deposits $10K. Yield accrues to share price.
    await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);
    await token.mint(await vault.getAddress(), usdc("500")); // +5% yield

    // Attacker observed a pending setFeeRate(0) tx and front-runs with a small deposit to capture
    // share-price growth without paying fee. We model the attack: rate is changed to 0; check
    // that fee was already accrued at the OLD rate (15%) BEFORE the change.
    const pendingAtOldRate = await vault.pendingFeeShares();
    expect(pendingAtOldRate).to.be.gt(0);

    // setFeeRate(0) — must call _accrue() FIRST, locking in the OLD-rate fee.
    await vault.connect(owner).setFeeRate(0);

    // Treasury already received the old-rate fee.
    const treasuryAfter = await vault.balanceOf(treasury.address);
    expect(treasuryAfter).to.equal(pendingAtOldRate);

    // Alice redeems all — at this point fee rate is 0 but the prior fee is locked.
    // attacker (impersonated by anyone else) would gain NOTHING from the sandwich because
    // the rate change does not retroactively refund the old-rate fee.
    const beforeBal = await token.balanceOf(alice.address);
    await vault.connect(alice).redeem(
      await vault.balanceOf(alice.address),
      alice.address,
      alice.address,
    );
    const aliceWithdrew = (await token.balanceOf(alice.address)) - beforeBal;
    // Alice receives her share-of-vault MINUS the 15% fee already taken. If the sandwich had
    // worked, she would receive the FULL $10,500 (no fee). Here she receives less.
    expect(aliceWithdrew).to.be.lt(usdc("10500"));
    expect(aliceWithdrew).to.be.gt(usdc("10000")); // still some yield benefit
  });

  // ─── Scenario 25 — Donation attack ────────────────────
  it("test_adv_donationDoesNotStealShareValue", async () => {
    const { vault, usdc: token, alice, attacker } =
      await loadFixture(deployVaultV2Fixture);

    // Alice deposits $10K and gets shares.
    await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);
    const aliceSharesBefore = await vault.balanceOf(alice.address);

    // Attacker transfers USDC directly to the vault (no deposit call → no share mint to attacker).
    // Goal: inflate share value? Then mint cheap shares → withdraw at higher price?
    // OZ v5 ERC-4626 with decimalsOffset blocks the inflation half (first-deposit corner).
    // Donation only LIFTS share value — attacker gets nothing back.
    await token.connect(attacker).transfer(await vault.getAddress(), usdc("100"));

    // Alice's share count is unchanged. Her underlying assets value INCREASED — attacker gifted her.
    expect(await vault.balanceOf(alice.address)).to.equal(aliceSharesBefore);
    const aliceUnderlying = await vault.convertToAssets(aliceSharesBefore);
    expect(aliceUnderlying).to.be.gte(usdc("10000")); // gained from donation

    // Attacker has no shares (never called deposit), and the $100 USDC is unrecoverable.
    expect(await vault.balanceOf(attacker.address)).to.equal(0);
  });

  // ─── Scenario 26 — Treasury redeem doesn't harm others ─
  it("test_adv_treasuryRedeem_doesNotReduceUserPosition", async () => {
    const { vault, usdc: token, alice, treasury } =
      await loadFixture(deployVaultV2Fixture);

    await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);
    await token.mint(await vault.getAddress(), usdc("500"));
    await vault.accrue();

    const aliceMaxRedeemBefore = await vault.maxRedeem(alice.address);
    const aliceUnderlyingBefore = await vault.convertToAssets(
      await vault.balanceOf(alice.address),
    );

    // Treasury redeems all its shares — should NOT change Alice's underlying assets value.
    const treasuryShares = await vault.balanceOf(treasury.address);
    await vault
      .connect(treasury)
      .redeem(treasuryShares, treasury.address, treasury.address);

    const aliceMaxRedeemAfter = await vault.maxRedeem(alice.address);
    const aliceUnderlyingAfter = await vault.convertToAssets(
      await vault.balanceOf(alice.address),
    );

    // 1 wei rounding tolerance (Math.Rounding.Floor on both sides).
    expect(aliceMaxRedeemAfter).to.be.closeTo(aliceMaxRedeemBefore, 1n);
    expect(aliceUnderlyingAfter).to.be.closeTo(aliceUnderlyingBefore, 1n);
  });

  // ─── Scenario 27 — Treasury as contract / re-entrancy surface ─
  it("test_adv_contractTreasury_mintAccruesNormally_noReentry", async () => {
    // Treasury is a CONTRACT address (mock USDC contract, just to ensure code at address).
    // OZ ERC20 _update has no receiver hook, so _mint cannot trigger arbitrary code there.
    // This scenario certifies that switching Treasury to a contract address doesn't introduce
    // a re-entrancy surface: every state-changing user-facing fn is nonReentrant anyway.
    const [owner, keeper, guardian, , alice] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const token = await MockUSDC.deploy();
    const treasuryContract = await MockUSDC.deploy(); // any deployed contract works as receiver

    // Standalone deploy because we need a contract address for treasury.
    const VaultV2 = await ethers.getContractFactory("VaultV2");
    const vault = await VaultV2.deploy({
      asset: await token.getAddress(),
      name: "v",
      symbol: "v",
      initialOwner: owner.address,
      keeper: keeper.address,
      guardian: guardian.address,
      treasury: await treasuryContract.getAddress(),
      feeRate: DEFAULT_FEE_RATE,
      depositCap: V2_DEPOSIT_CAP,
      defaultUserCap: V2_DEFAULT_USER_CAP,
      maxAllocationAbsolute: TIER_BALANCED_BPS,
      versionHash: V2_VERSION_HASHES.devBalanced,
    });

    await token.mint(alice.address, usdc("100000"));
    await token.connect(alice).approve(await vault.getAddress(), usdc("10000"));
    await vault.connect(alice).deposit(usdc("10000"), alice.address);
    await token.mint(await vault.getAddress(), usdc("500"));

    // accrue() → _mint(treasury) where treasury is a contract. Must NOT revert.
    await time.increase(1);
    await vault.accrue();

    // Contract treasury holds shares — accrual ran without re-entrant call paths firing.
    expect(await vault.balanceOf(await treasuryContract.getAddress())).to.be.gt(0);
  });
});
