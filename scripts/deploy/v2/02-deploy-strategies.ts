import { ethers, network } from "hardhat";

import { constructorArgsFor, getChainConfig, type StrategyEntry } from "../00-config";
import {
  getV2VersionHash,
  getV2VersionString,
  requireTier,
  strategiesForTier,
} from "./00-tier-config";
import { getGeneration, loadDeployment, updateDeployment } from "../../utils/deployments";
import { verifyOne } from "../../ops/verify";

/// V2 Step 2: Deploy strategy adapters for whichever strategies are configured for
/// the current (chain, tier) pair.
///
/// Adapter constructor signature is identical to V1 (Strategy contracts reused as-is
/// per V2_VAULT.md "strategy 컨트랙트 동일 인터페이스 유지"). The version hash passed
/// to BaseStrategy is the V2 tier-specific hash so strategy etherscan pages match
/// their owning Vault's tier.
///
/// Idempotent: skips strategies already in the deployment record.

async function deployOne(
  entry: StrategyEntry,
  vaultAddr: string,
  asset: string,
  strategyVersionHash: string,
  chain: ReturnType<typeof getChainConfig>,
): Promise<string> {
  const Factory = await ethers.getContractFactory(entry.adapter);
  // V2.1 — constructorArgsFor now requires the chain config to inject the per-chain
  // `dexRouter` (Soken F-04). Missing reward fields default to ethers.ZeroAddress, so
  // strategies still deploy cleanly on chains where the reward program is dormant.
  const extraArgs = constructorArgsFor(entry, chain);
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
  const tier = requireTier();
  const strategyVersion = getV2VersionString(generation, tier);
  const strategyVersionHash = getV2VersionHash(generation, tier);

  if (!record?.contracts.vault) {
    throw new Error(
      `No VaultV2 found for ${network.name} / ${generation} / ${tier}. ` +
        `Run scripts/deploy/v2/01-deploy-vault.ts first.`,
    );
  }

  const vaultAddr = record.contracts.vault;
  const asset = config.usdc.address;
  const tieredStrategies = strategiesForTier(network.name, tier);

  console.log("─────────────────────────────────────────────");
  console.log(`Deploying strategies on ${config.displayName}`);
  console.log(`Generation:  ${generation} / ${tier}   →  VERSION="${strategyVersion}"`);
  console.log(`Vault:       ${vaultAddr}`);
  console.log(`Asset:       ${asset}`);
  console.log(`Strategies:  ${tieredStrategies.map((s) => s.key).join(", ") || "(none)"}`);
  console.log("─────────────────────────────────────────────");

  if (tieredStrategies.length === 0) {
    console.warn(
      `! No strategies match tier "${tier}" on ${network.name}. ` +
        `Check scripts/deploy/v2/00-tier-config.ts TIER_STRATEGY_KEYS.`,
    );
    return;
  }

  const skipVerify = network.name === "localhost" || network.name === "hardhat";
  for (const { key, entry } of tieredStrategies) {
    const existing = record.contracts.strategies?.[key];
    if (existing) {
      console.log(`✓ ${entry.adapter.padEnd(20)} ${key.padEnd(10)} ${existing} (already deployed, skipping)`);
      continue;
    }
    const addr = await deployOne(entry, vaultAddr, asset, strategyVersionHash, config);
    console.log(`✓ ${entry.adapter.padEnd(20)} ${key.padEnd(10)} ${addr}`);
    console.log(`  display="${entry.display}"  slug="${entry.slug}"`);
    updateDeployment(network.name, (r) => {
      if (!r.contracts.strategies) r.contracts.strategies = {};
      r.contracts.strategies[key] = addr;
      // 2026-06-17 — canonical user-facing labeling lives in deployment evidence (00-config.ts
      // 의 display/slug 필드 단일 출처). Server / frontend MUST consume from here to prevent
      // stale-label cascades (Steakhouse → Smokehouse, Portofino → Pangolins, etc.).
      if (!r.contracts.strategyMeta) r.contracts.strategyMeta = {};
      r.contracts.strategyMeta[key] = { slug: entry.slug, display: entry.display };
    });

    // Inline verify — register 전에 strategy 도 verify 되어야 Etherscan UI 가 함수 / 이벤트
    // 명확히 표시 (Vault 의 inline verify 와 동일 사유). constructorArguments 는 V1/V2 동일
    // 시그니처: (vault, asset, ...adapterArgs, strategyVersionHash).
    if (!skipVerify) {
      const ctorArgs: unknown[] = [
        vaultAddr,
        asset,
        ...constructorArgsFor(entry, config),
        strategyVersionHash,
      ];
      await verifyOne(`${entry.adapter} (${key})`, addr, ctorArgs);
    }
  }

  console.log("\nNext: scripts/deploy/v2/03-register-strategies.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
