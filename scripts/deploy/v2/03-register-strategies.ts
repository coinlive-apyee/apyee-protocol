import { ethers, network } from "hardhat";

import { getChainConfig } from "../00-config";
import { requireTier, strategiesForTier } from "./00-tier-config";
import { loadDeployment } from "../../utils/deployments";

/// V2 Step 3: Register each deployed strategy with the Vault via
/// `addStrategy(strategy, targetBps, maxBps)`. MUST run before
/// 04-transfer-ownership (Multi-sig takeover).
///
/// Idempotent: skips strategies already marked `isActive` on-chain.

async function main() {
  const config = getChainConfig(network.name);
  const record = loadDeployment(network.name);
  const tier = requireTier();

  if (!record?.contracts.vault) {
    throw new Error(
      `No VaultV2 for ${network.name} / ${tier}. Run v2/01-deploy-vault first.`,
    );
  }

  const [deployer] = await ethers.getSigners();
  const vault = await ethers.getContractAt("VaultV2", record.contracts.vault);
  const tieredStrategies = strategiesForTier(network.name, tier);

  console.log("─────────────────────────────────────────────");
  console.log(`Registering strategies on ${config.displayName} (${tier})`);
  console.log(`Vault:   ${record.contracts.vault}`);
  console.log(`Caller:  ${deployer.address} (must still be current Owner)`);
  console.log("─────────────────────────────────────────────");

  const ownerOnChain = await vault.owner();
  if (ownerOnChain.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Owner mismatch. Vault owner = ${ownerOnChain}, signer = ${deployer.address}. ` +
        `addStrategy requires the deployer EOA to still hold Owner ` +
        `(run before v2/04-transfer-ownership).`,
    );
  }

  let registered = 0;
  for (const { key, entry } of tieredStrategies) {
    const stratAddr = record.contracts.strategies?.[key];
    if (!stratAddr) {
      console.log(`→ ${key}: NOT deployed (run v2/02-deploy-strategies first), skipping`);
      continue;
    }
    const info = await vault.strategyInfo(stratAddr);
    if (info.isActive) {
      console.log(`→ ${key}: already registered, skipping`);
      continue;
    }
    console.log(`→ ${key}: addStrategy(target=${entry.targetBps}bps, max=${entry.maxBps}bps)`);
    const tx = await vault.addStrategy(stratAddr, entry.targetBps, entry.maxBps);
    const receipt = await tx.wait();
    console.log(`  tx ${receipt!.hash} (block ${receipt!.blockNumber})`);
    registered++;
  }

  const count = await vault.strategyCount();
  console.log(`\n✓ ${registered} strategies registered this run, ${count} total on-chain`);
  console.log("\nNext: scripts/deploy/v2/04-transfer-ownership.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
