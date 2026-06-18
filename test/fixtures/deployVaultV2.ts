import { ethers } from "hardhat";

// ─── Per-tier maxAllocationBps_ constructor arg (V2 immutable cap) ───
export const TIER_CONSERVATIVE_BPS = 2500;
export const TIER_BALANCED_BPS = 4000;
export const TIER_AGGRESSIVE_BPS = 6000;

// ─── Soft Launch caps (matches V1 fixture for parity) ───
export const V2_DEPOSIT_CAP = ethers.parseUnits("500000", 6); // $500K
export const V2_DEFAULT_USER_CAP = ethers.parseUnits("10000", 6); // $10K
export const DEFAULT_FEE_RATE = 1500; // 15%
export const MAX_FEE = 2000;
export const MAX_ALLOCATION_CEILING = 10_000;
export const ACCRUE_PRECISION = 10n ** 18n;

// ─── Version hash matrix (matches V2_VAULT.md §4.4) ───
const versionHash = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
export const V2_VERSION_HASHES = {
  devConservative:  versionHash("2.0.0-dev-conservative"),
  devBalanced:      versionHash("2.0.0-dev-balanced"),
  devAggressive:    versionHash("2.0.0-dev-aggressive"),
  prodConservative: versionHash("2.0.0-prod-conservative"),
  prodBalanced:     versionHash("2.0.0-prod-balanced"),
  prodAggressive:   versionHash("2.0.0-prod-aggressive"),
} as const;

export const TEST_USER_BALANCE = ethers.parseUnits("100000", 6);

export type Tier = "conservative" | "balanced" | "aggressive";

function tierConfig(tier: Tier) {
  switch (tier) {
    case "conservative":
      return { capBps: TIER_CONSERVATIVE_BPS, versionHash: V2_VERSION_HASHES.devConservative };
    case "balanced":
      return { capBps: TIER_BALANCED_BPS, versionHash: V2_VERSION_HASHES.devBalanced };
    case "aggressive":
      return { capBps: TIER_AGGRESSIVE_BPS, versionHash: V2_VERSION_HASHES.devAggressive };
  }
}

/// Deploys MockUSDC + VaultV2 + MockStrategy. Default tier = balanced.
///
/// Returns vault as `any` so per-tier immutable params can be inspected without
/// re-narrowing the typechain type. All test assertions still type-check on
/// .balanceOf() / .deposit() etc. via ERC-4626 inheritance.
export async function deployVaultV2Fixture(tier: Tier = "balanced") {
  const [owner, keeper, guardian, treasury, alice, bob, attacker] =
    await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();

  const { capBps, versionHash: vh } = tierConfig(tier);

  const VaultV2 = await ethers.getContractFactory("VaultV2");
  const vault = await VaultV2.deploy({
    asset: await usdc.getAddress(),
    name: `Apyee USDC Vault V2 (${tier})`,
    symbol: `apUSDC-${tier[0]}`,
    initialOwner: owner.address,
    keeper: keeper.address,
    guardian: guardian.address,
    treasury: treasury.address,
    feeRate: DEFAULT_FEE_RATE,
    depositCap: V2_DEPOSIT_CAP,
    defaultUserCap: V2_DEFAULT_USER_CAP,
    maxAllocationAbsolute: capBps,
    versionHash: vh,
  });
  await vault.waitForDeployment();

  const MockStrategy = await ethers.getContractFactory("MockStrategy");
  const strategy = await MockStrategy.deploy(
    await vault.getAddress(),
    await usdc.getAddress(),
  );
  await strategy.waitForDeployment();

  // Fund test users — enough to hit caps in any test.
  await usdc.mint(alice.address, TEST_USER_BALANCE);
  await usdc.mint(bob.address, TEST_USER_BALANCE);
  await usdc.mint(attacker.address, TEST_USER_BALANCE);

  return {
    vault,
    usdc,
    strategy,
    owner,
    keeper,
    guardian,
    treasury,
    alice,
    bob,
    attacker,
    tier,
    capBps,
    versionHash: vh,
  };
}

// Convenience wrappers for the 3 tiers.
export const deployConservativeVault = () => deployVaultV2Fixture("conservative");
export const deployBalancedVault     = () => deployVaultV2Fixture("balanced");
export const deployAggressiveVault   = () => deployVaultV2Fixture("aggressive");
