import { ethers } from "hardhat";

/// Soft Launch (Beta UI badge) deposit cap per spec 1.21.4: $10K USDC.
export const BETA_DEPOSIT_CAP = ethers.parseUnits("10000", 6);

/// Soft Launch (Beta UI badge) per-user cap (Free tier): $10K USDC.
export const BETA_DEFAULT_USER_CAP = ethers.parseUnits("10000", 6);

/// Test environment version string. Matches dev generation pattern.
export const TEST_VERSION = "1.0.0-dev";

/// keccak256 hash of TEST_VERSION — passed to Vault constructor (bytes32 immutable).
export const TEST_VERSION_HASH = ethers.keccak256(ethers.toUtf8Bytes(TEST_VERSION));

/// Strategy version for adapter tests (matches BaseStrategy constructor convention).
export const TEST_STRATEGY_VERSION = "1.0.0-dev";

/// keccak256 hash of TEST_STRATEGY_VERSION — passed to BaseStrategy constructor (bytes32 immutable).
export const TEST_STRATEGY_VERSION_HASH = ethers.keccak256(ethers.toUtf8Bytes(TEST_STRATEGY_VERSION));

/// Default initial fee rate (15% in bps).
export const DEFAULT_FEE_RATE = 1500;

/// Sufficient mint amount per test signer ($100K USDC).
export const TEST_USER_BALANCE = ethers.parseUnits("100000", 6);

/// Standard fixture: deploys MockUSDC + Vault + a single MockStrategy, mints USDC to alice/bob.
/// Usage:
///   const { vault, usdc, strategy, owner, keeper, ... } = await loadFixture(deployVaultFixture);
export async function deployVaultFixture() {
  const [owner, keeper, guardian, treasury, alice, bob, attacker] =
    await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();

  const Vault = await ethers.getContractFactory("Vault");
  const vault = await Vault.deploy(
    await usdc.getAddress(),
    "Apyee USDC Vault",
    "apUSDC",
    owner.address,
    keeper.address,
    guardian.address,
    treasury.address,
    DEFAULT_FEE_RATE,
    BETA_DEPOSIT_CAP,
    BETA_DEFAULT_USER_CAP,
    TEST_VERSION_HASH,
  );
  await vault.waitForDeployment();

  const MockStrategy = await ethers.getContractFactory("MockStrategy");
  const strategy = await MockStrategy.deploy(
    await vault.getAddress(),
    await usdc.getAddress(),
  );
  await strategy.waitForDeployment();

  // Fund test users
  await usdc.mint(alice.address, TEST_USER_BALANCE);
  await usdc.mint(bob.address, TEST_USER_BALANCE);

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
  };
}
