import { ethers, network } from "hardhat";

import { getChainConfig, getVersionHash, getVersionString } from "./00-config";
import { readRoles, requireGasBalance } from "../utils/env";
import { getGeneration, saveDeployment } from "../utils/deployments";

/// Step 1: Deploy the immutable Vault.
///
/// Initial owner = deployer EOA (so subsequent steps can call addStrategy / setDepositCap).
/// Multi-sig takeover happens in step 04-transfer-ownership.

async function main() {
  const config = getChainConfig(network.name);
  const roles = readRoles(network.name);
  const generation = getGeneration();
  const versionString = getVersionString(generation);
  const versionHash = getVersionHash(generation);

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  requireGasBalance(deployer.address, balance, network.name);

  console.log("─────────────────────────────────────────────");
  console.log(`Deploying Vault on ${config.displayName} (chainId=${config.chainId})`);
  console.log(`Generation: ${generation}   →  VERSION="${versionString}"`);
  console.log(`Deployer:   ${deployer.address}`);
  console.log(`Gas bal:    ${ethers.formatEther(balance)} native`);
  console.log("─────────────────────────────────────────────");
  console.log("Roles:");
  console.log(`  Multi-sig (post-transfer Owner): ${roles.multisig}`);
  console.log(`  Keeper:                          ${roles.keeper}`);
  console.log(`  Guardian:                        ${roles.guardian}`);
  console.log(`  Treasury:                        ${roles.treasury}`);
  console.log("─────────────────────────────────────────────");

  const depositCap = ethers.parseUnits(
    config.vault.depositCapHuman,
    config.usdc.decimals,
  );
  const defaultUserCap = ethers.parseUnits(
    config.vault.defaultUserCapHuman,
    config.usdc.decimals,
  );

  const Vault = await ethers.getContractFactory("Vault");
  const vault = await Vault.deploy(
    config.usdc.address,
    config.vault.name,
    config.vault.symbol,
    deployer.address, // initial owner (transfer to multisig in step 04)
    roles.keeper,
    roles.guardian,
    roles.treasury,
    config.vault.feeRateBps,
    depositCap,
    defaultUserCap,
    versionHash,
  );
  await vault.waitForDeployment();

  const vaultAddr = await vault.getAddress();
  console.log(`✓ Vault deployed: ${vaultAddr}`);
  console.log(`  VERSION:        "${versionString}" (hash ${versionHash})`);
  console.log(`  feeRate:        ${config.vault.feeRateBps} bps (15%)`);
  console.log(`  depositCap:     ${config.vault.depositCapHuman} USDC (vault total, Soft Launch)`);
  console.log(`  defaultUserCap: ${config.vault.defaultUserCapHuman} USDC (Free tier, Soft Launch)`);

  saveDeployment({
    network: network.name,
    chainId: config.chainId,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      vault: vaultAddr,
    },
    config: {
      asset: config.usdc.address,
      name: config.vault.name,
      symbol: config.vault.symbol,
      initialOwner: deployer.address,
      keeper: roles.keeper,
      guardian: roles.guardian,
      treasury: roles.treasury,
      feeRateBps: config.vault.feeRateBps,
      depositCap: depositCap.toString(),
      defaultUserCap: defaultUserCap.toString(),
      version: versionString,
      versionHash,
    },
  });

  console.log(`✓ Saved to deployments/${network.name}.json`);
  console.log("\nNext: scripts/deploy/02-deploy-strategies.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
