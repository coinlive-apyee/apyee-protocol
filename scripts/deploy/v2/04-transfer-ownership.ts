import { ethers, network } from "hardhat";

import { requireTier } from "./00-tier-config";
import { readRoles } from "../../utils/env";
import { loadDeployment, updateDeployment } from "../../utils/deployments";

/// V2 Step 4: Transfer VaultV2 ownership from the deployer EOA to the Multi-sig (Gnosis Safe).
/// IRREVERSIBLE without Multi-sig cooperation. Run only AFTER 01 → 02 → 03.
///
/// Same flow as V1 04-transfer-ownership. Difference: loads VaultV2 (not Vault) and
/// records the tier in `deployments/v2-<env>/<tier>/<chain>.json` via the active path
/// resolver (deployments.ts auto-prefixes by APYEE_GENERATION + APYEE_TIER).

async function main() {
  const roles = readRoles(network.name);
  const record = loadDeployment(network.name);
  const tier = requireTier();

  if (!record?.contracts.vault) {
    throw new Error(
      `No VaultV2 for ${network.name} / ${tier}. Run v2/01-deploy-vault first.`,
    );
  }

  const [deployer] = await ethers.getSigners();
  const vault = await ethers.getContractAt("VaultV2", record.contracts.vault);

  const currentOwner = await vault.owner();
  console.log("─────────────────────────────────────────────");
  console.log(`Transferring ownership on ${network.name} (${tier})`);
  console.log(`Vault:           ${record.contracts.vault}`);
  console.log(`Current owner:   ${currentOwner}`);
  console.log(`New owner (MS):  ${roles.multisig}`);
  console.log(`Caller:          ${deployer.address}`);
  console.log("─────────────────────────────────────────────");

  if (currentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Cannot transfer: deployer ${deployer.address} is NOT current owner (${currentOwner}). ` +
        `Owner may already have been transferred.`,
    );
  }

  if (currentOwner.toLowerCase() === roles.multisig.toLowerCase()) {
    throw new Error(
      `Owner is already the Multi-sig (${roles.multisig}). Aborting to avoid no-op tx.`,
    );
  }

  // Sanity: warn if multisig is an EOA (Gnosis Safe contracts have non-empty bytecode).
  const code = await ethers.provider.getCode(roles.multisig);
  if (code === "0x") {
    console.warn(
      `⚠️  Target ${roles.multisig} has no bytecode — looks like an EOA, not a Multi-sig. ` +
        `Aborting. Set MULTISIG_${network.name.toUpperCase()} to your Gnosis Safe address.`,
    );
    process.exit(1);
  }

  console.log(`\nExecuting transferOwnership(${roles.multisig})...`);
  const tx = await vault.transferOwnership(roles.multisig);
  const receipt = await tx.wait();

  console.log(`✓ tx ${receipt!.hash} (block ${receipt!.blockNumber})`);

  // Read-after-write lag tolerance (same pattern as V1 04 — Base mainnet RPC quirk).
  let newOwner = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    newOwner = await vault.owner();
    if (newOwner.toLowerCase() === roles.multisig.toLowerCase()) break;
    if (attempt < 5) await new Promise((r) => setTimeout(r, 5_000));
  }
  console.log(`✓ New on-chain owner: ${newOwner}`);

  if (newOwner.toLowerCase() !== roles.multisig.toLowerCase()) {
    throw new Error(
      `Ownership transfer mismatch after retry! On-chain ${newOwner}, expected ${roles.multisig}. ` +
        `tx ${receipt!.hash} confirmed at block ${receipt!.blockNumber} — verify manually on the explorer.`,
    );
  }

  updateDeployment(network.name, (r) => {
    r.ownershipTransferred = {
      to: roles.multisig,
      txHash: receipt!.hash,
      blockNumber: receipt!.blockNumber,
    };
  });

  console.log(`\n✓ Saved deployment record.`);
  console.log(
    "\nV2 deploy complete. Owner-only operations from now on require Multi-sig signatures.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
