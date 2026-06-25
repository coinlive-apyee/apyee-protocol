import { ethers, network, run } from "hardhat";

import { constructorArgsFor, getChainConfig } from "../deploy/00-config";
import { getGeneration, loadDeployment } from "../utils/deployments";

/// Auto-verify deployed contracts on Etherscan-family explorers.
///
/// Etherscan V2 unified API covers all four target chains (Ethereum, Base, Arbitrum, BSC)
/// with a single key — see hardhat.config.ts `etherscan` block. Per-strategy verification
/// is driven by deployments/<network>.json `contracts.strategies` map and adapter metadata
/// from 00-config.ts.

/// Reusable single-contract verify with consistent error handling. Exported so deploy
/// scripts can call it inline right after deploy (avoids "vault selector matches unrelated
/// function" 혼선 on Etherscan when strategies are added before vault is verified).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function verifyOne(label: string, address: string, constructorArguments: any[]) {
  console.log(`\n→ ${label}: verify ${address}`);
  try {
    await run("verify:verify", { address, constructorArguments });
    console.log(`  ✓ verified`);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.toLowerCase().includes("already verified")) {
      console.log(`  ✓ already verified`);
      return;
    }
    if (msg.includes("Free API access is not supported")) {
      console.warn(
        `  ⚠ Etherscan V2 Free does not cover this chain. Use manual verify ` +
          `(npm run verify:prepare -- --network ${network.name}).`,
      );
      return;
    }
    console.error(`  ✗ ${msg}`);
  }
}

async function main() {
  const config = getChainConfig(network.name);
  const generation = getGeneration();
  const isV2 = generation.startsWith("v2-");
  const record = loadDeployment(network.name);
  if (!record) {
    throw new Error(`No deployment record for ${network.name}. Run 01-deploy-vault first.`);
  }

  console.log("─────────────────────────────────────────────");
  console.log(`Verifying contracts on ${config.displayName}${isV2 ? ` (${generation}/${record.config.tier})` : ""}`);
  console.log("─────────────────────────────────────────────");

  // ─── Vault ───
  if (record.contracts.vault) {
    const depositCap = record.config.depositCap
      ? BigInt(record.config.depositCap)
      : ethers.parseUnits(config.vault.depositCapHuman, config.usdc.decimals);
    const defaultUserCap = record.config.defaultUserCap
      ? BigInt(record.config.defaultUserCap)
      : ethers.parseUnits(config.vault.defaultUserCapHuman, config.usdc.decimals);
    if (!record.config.versionHash) {
      throw new Error(
        `record.config.versionHash missing on ${network.name}. v1.0.0+ deployments must carry versionHash. ` +
          "Either redeploy via 01-deploy-vault.ts or patch the JSON manually.",
      );
    }

    if (isV2) {
      // VaultV2 constructor takes a single InitConfig struct. hardhat-verify ABI-encodes structs
      // when passed as a single object inside the constructorArguments array.
      if (record.config.maxAllocationAbsolute == null) {
        throw new Error(
          `record.config.maxAllocationAbsolute missing for ${network.name}/${record.config.tier}. ` +
            "V2 deployments must carry the per-tier immutable cap — redeploy via v2/01-deploy-vault.ts.",
        );
      }
      const initConfig = {
        asset: record.config.asset,
        name: record.config.name,
        symbol: record.config.symbol,
        initialOwner: record.config.initialOwner,
        keeper: record.config.keeper,
        guardian: record.config.guardian,
        treasury: record.config.treasury,
        feeRate: record.config.feeRateBps,
        depositCap,
        defaultUserCap,
        maxAllocationAbsolute: record.config.maxAllocationAbsolute,
        versionHash: record.config.versionHash,
      };
      await verifyOne(`VaultV2 (${record.config.tier})`, record.contracts.vault, [initConfig]);
    } else {
      // V1 positional constructor.
      await verifyOne("Vault", record.contracts.vault, [
        config.usdc.address,
        record.config.name,
        record.config.symbol,
        record.config.initialOwner,
        record.config.keeper,
        record.config.guardian,
        record.config.treasury,
        record.config.feeRateBps,
        depositCap,
        defaultUserCap,
        record.config.versionHash,
      ]);
    }
  }

  // ─── Strategies (named map driven) ───
  for (const [name, entry] of Object.entries(config.strategies)) {
    const addr = record.contracts.strategies?.[name];
    if (!addr) {
      console.log(`\n→ ${name}: not in deployments, skipping`);
      continue;
    }
    if (!record.config.versionHash) {
      throw new Error(`record.config.versionHash missing — see Vault verify error above`);
    }
    const label = `${entry.adapter} (${name})`;
    const ctorArgs: unknown[] = [
      record.contracts.vault!,
      config.usdc.address,
      ...constructorArgsFor(entry, config),
      record.config.versionHash, // strategy_version_hash_ matches Vault.VERSION_HASH for same generation
    ];
    await verifyOne(label, addr, ctorArgs);
  }
}

// Gate main() so importing verifyOne from other scripts (e.g. scripts/deploy/v2/01-deploy-vault.ts
// PR15 inline verify) doesn't trigger the standalone batch verifier. Only run main when invoked
// directly via `npx hardhat run scripts/ops/verify.ts`.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
