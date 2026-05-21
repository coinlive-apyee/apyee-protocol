import { ethers, network } from "hardhat";

import { constructorArgsFor, getChainConfig, getVersionHash, getVersionString, StrategyEntry } from "./00-config";
import { getGeneration, loadDeployment, updateDeployment } from "../utils/deployments";

/// Step 2: Deploy strategy adapters for whichever strategies are configured for this chain.
/// Each adapter is constructed with (vault, asset, ...adapterSpecificArgs) so the Vault can
/// authenticate via onlyVault.
///
/// Idempotent: a strategy already present in deployments/<network>.json (`contracts.strategies`)
/// is skipped. This makes the script safe to re-run after a partial failure (e.g. a single tx
/// confirmed but the surrounding script process crashed) without re-deploying.

async function deployOne(
  entry: StrategyEntry,
  vaultAddr: string,
  asset: string,
  strategyVersionHash: string,
): Promise<string> {
  const Factory = await ethers.getContractFactory(entry.adapter);
  const extraArgs = constructorArgsFor(entry);
  // BaseStrategy signature: (vault_, asset_, ...adapter_specific, strategyVersionHash_)
  const contract = await Factory.deploy(
    vaultAddr,
    asset,
    ...(extraArgs as never[]),
    strategyVersionHash,
  );
  await contract.waitForDeployment();
  return contract.getAddress();
}

async function main() {
  const config = getChainConfig(network.name);
  const record = loadDeployment(network.name);
  const generation = getGeneration();
  const strategyVersion = getVersionString(generation);
  const strategyVersionHash = getVersionHash(generation);

  if (!record?.contracts.vault) {
    throw new Error(
      `No Vault found for ${network.name}. Run 01-deploy-vault.ts first.`,
    );
  }

  const vaultAddr = record.contracts.vault;
  const asset = config.usdc.address;

  console.log("─────────────────────────────────────────────");
  console.log(`Deploying strategies on ${config.displayName}`);
  console.log(`Generation: ${generation}   →  STRATEGY_VERSION="${strategyVersion}" (hash ${strategyVersionHash})`);
  console.log(`Vault:      ${vaultAddr}`);
  console.log(`Asset:      ${asset}`);
  console.log("─────────────────────────────────────────────");

  for (const [name, entry] of Object.entries(config.strategies)) {
    const existing = record.contracts.strategies?.[name];
    if (existing) {
      console.log(`✓ ${entry.adapter.padEnd(20)} ${name.padEnd(10)} ${existing} (already deployed, skipping)`);
      continue;
    }
    const addr = await deployOne(entry, vaultAddr, asset, strategyVersionHash);
    console.log(`✓ ${entry.adapter.padEnd(20)} ${name.padEnd(10)} ${addr}`);
    updateDeployment(network.name, (r) => {
      if (!r.contracts.strategies) r.contracts.strategies = {};
      r.contracts.strategies[name] = addr;
    });
  }

  console.log("\nNext: scripts/deploy/03-register-strategies.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
