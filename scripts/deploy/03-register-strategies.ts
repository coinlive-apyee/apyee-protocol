import { ethers, network } from "hardhat";

import { getChainConfig } from "./00-config";
import { loadDeployment } from "../utils/deployments";

/// Step 3: Register each deployed strategy with the Vault via addStrategy(strategy, target, max).
/// MUST run before 04-transfer-ownership (after that, Owner = Multi-sig and addStrategy needs
/// a Safe transaction).
///
/// Idempotent: a strategy already marked `isActive` on-chain (via Vault.strategyInfo) is
/// skipped. Recovers cleanly from partial failures (one addStrategy confirmed, the next
/// reverting mid-loop).

async function main() {
  const config = getChainConfig(network.name);
  const record = loadDeployment(network.name);

  if (!record?.contracts.vault) {
    throw new Error(`No Vault for ${network.name}. Run 01-deploy-vault first.`);
  }

  const [deployer] = await ethers.getSigners();
  const vault = await ethers.getContractAt("Vault", record.contracts.vault);

  console.log("─────────────────────────────────────────────");
  console.log(`Registering strategies on ${config.displayName}`);
  console.log(`Vault:   ${record.contracts.vault}`);
  console.log(`Caller:  ${deployer.address} (must be current Owner)`);
  console.log("─────────────────────────────────────────────");

  const ownerOnChain = await vault.owner();
  if (ownerOnChain.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Owner mismatch. Vault owner = ${ownerOnChain}, signer = ${deployer.address}. ` +
        `addStrategy requires the deployer EOA to still hold Owner (run before 04-transfer-ownership).`,
    );
  }

  let registered = 0;
  for (const [name, entry] of Object.entries(config.strategies)) {
    const stratAddr = record.contracts.strategies?.[name];
    if (!stratAddr) {
      console.log(`→ ${name}: NOT deployed (run 02-deploy-strategies first), skipping`);
      continue;
    }
    const info = await vault.strategyInfo(stratAddr);
    if (info.isActive) {
      console.log(`→ ${name}: already registered, skipping`);
      continue;
    }
    console.log(`→ ${name}: addStrategy(target=${entry.targetBps}bps, max=${entry.maxBps}bps)`);
    const tx = await vault.addStrategy(stratAddr, entry.targetBps, entry.maxBps);
    const receipt = await tx.wait();
    console.log(`  tx ${receipt!.hash} (block ${receipt!.blockNumber})`);
    registered++;
  }

  const count = await vault.strategyCount();
  console.log(`\n✓ ${registered} strategies registered this run, ${count} total on-chain`);
  console.log("\nNext: scripts/deploy/04-transfer-ownership.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
