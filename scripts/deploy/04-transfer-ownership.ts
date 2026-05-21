import { ethers, network } from "hardhat";

import { readRoles } from "../utils/env";
import { loadDeployment, updateDeployment } from "../utils/deployments";

/// Step 4: Transfer Vault ownership from the deployer EOA to the Multi-sig (Gnosis Safe).
/// THIS IS IRREVERSIBLE without Multi-sig cooperation. Run only AFTER:
///   - 01-deploy-vault
///   - 02-deploy-strategies
///   - 03-register-strategies
/// All Owner-only operations (addStrategy / setFeeRate / setDepositCap / unblacklistStrategy /
/// setKeeper / setGuardian / setTreasury) will require Safe signatures from this point.

async function main() {
  const roles = readRoles(network.name);
  const record = loadDeployment(network.name);

  if (!record?.contracts.vault) {
    throw new Error(`No Vault for ${network.name}. Run 01-deploy-vault first.`);
  }

  const [deployer] = await ethers.getSigners();
  const vault = await ethers.getContractAt("Vault", record.contracts.vault);

  const currentOwner = await vault.owner();
  console.log("─────────────────────────────────────────────");
  console.log(`Transferring ownership on ${network.name}`);
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

  // Some public RPCs (e.g. Base mainnet.base.org) have read-after-write lag where a follow-up
  // owner() call returns stale state for several seconds even after the tx is confirmed in a
  // block. Poll up to 30s before declaring a real mismatch.
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

  console.log(`\n✓ Saved to deployments/${network.name}.json`);
  console.log(
    "\nDeploy complete. Owner-only operations from now on require Multi-sig signatures.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
