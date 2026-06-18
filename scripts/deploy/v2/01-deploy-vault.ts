import { ethers, network, run } from "hardhat";

import { getChainConfig } from "../00-config";
import {
  depositCapForV2,
  getV2VersionHash,
  getV2VersionString,
  requireTier,
  TIER_CAP_BPS,
} from "./00-tier-config";
import { readRoles, requireGasBalance } from "../../utils/env";
import { getGeneration, saveDeployment } from "../../utils/deployments";
import { verifyOne } from "../../ops/verify";
import { sourceTagValue, withSourceTag } from "../../utils/source-tag";

/// V2 Step 1: Deploy the immutable VaultV2.
///
/// Same shape as V1 01-deploy-vault, plus two new constructor args:
///   - maxAllocationAbsolute_  → per-tier immutable cap (2500 / 4000 / 6000 bps)
///   - versionHash_            → per (generation × tier) immutable hash
///                               (V2_VAULT.md §4.4 — 6 hash matrix)
///
/// Required env: APYEE_GENERATION=v2-dev|v2-prod, APYEE_TIER=conservative|balanced|aggressive

async function main() {
  const config = getChainConfig(network.name);
  const roles = readRoles(network.name);
  const generation = getGeneration();
  const tier = requireTier();
  const versionString = getV2VersionString(generation, tier);
  const versionHash = getV2VersionHash(generation, tier);
  const tierCap = TIER_CAP_BPS[tier];

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  requireGasBalance(deployer.address, balance, network.name);

  const tag = sourceTagValue(generation, tier);

  console.log("─────────────────────────────────────────────");
  console.log(`Deploying VaultV2 on ${config.displayName} (chainId=${config.chainId})`);
  console.log(`Generation:  ${generation}`);
  console.log(`Tier:        ${tier}  (cap = ${tierCap} bps, ${tierCap / 100}%)`);
  console.log(`Version:     "${versionString}"  hash=${versionHash}`);
  console.log(`SOURCE_TAG:  "${tag}"  (Etherscan Similar Match 차단 — metadata 분기)`);
  console.log(`Deployer:    ${deployer.address}`);
  console.log(`Gas bal:     ${ethers.formatEther(balance)} native`);
  console.log("─────────────────────────────────────────────");
  console.log("Roles:");
  console.log(`  Multi-sig (post-transfer Owner): ${roles.multisig}`);
  console.log(`  Keeper:                          ${roles.keeper}`);
  console.log(`  Guardian:                        ${roles.guardian}`);
  console.log(`  Treasury:                        ${roles.treasury}`);
  console.log("─────────────────────────────────────────────");

  const depositCapHuman = depositCapForV2(generation, tier);
  const depositCap = ethers.parseUnits(depositCapHuman, config.usdc.decimals);
  const defaultUserCap = ethers.parseUnits(
    config.vault.defaultUserCapHuman,
    config.usdc.decimals,
  );

  // ERC-4626 name/symbol include the tier so wallets / explorers show e.g.
  // "Apyee USDC Vault V2 (Aggressive)" / "apUSDC-a".
  const vaultName = `Apyee USDC Vault V2 (${tier[0].toUpperCase()}${tier.slice(1)})`;
  const vaultSymbol = `apUSDC-${tier[0]}`;

  // SOURCE_TAG sed-replace + force compile + deploy inside withSourceTag — finally
  // restores the original Vault.sol so the git working tree stays clean. Etherscan
  // Similar Match 는 metadata trailer (= source IPFS hash) 기반이라 placeholder 가
  // 6 분기마다 다르게 박혀야 차단됨.
  const vault = await withSourceTag(generation, tier, async () => {
    console.log(`SOURCE_TAG patched → compile + deploy ...`);
    await run("compile", { force: true });
    const VaultV2 = await ethers.getContractFactory("VaultV2");
    const c = await VaultV2.deploy({
      asset: config.usdc.address,
      name: vaultName,
      symbol: vaultSymbol,
      initialOwner: deployer.address, // transferred to multisig in step 04
      keeper: roles.keeper,
      guardian: roles.guardian,
      treasury: roles.treasury,
      feeRate: config.vault.feeRateBps,
      depositCap,
      defaultUserCap,
      maxAllocationAbsolute: tierCap,
      versionHash,
    });
    await c.waitForDeployment();
    return c;
  });

  const vaultAddr = await vault.getAddress();
  console.log(`✓ VaultV2 deployed: ${vaultAddr}`);
  console.log(`  Name / Symbol:    "${vaultName}" / ${vaultSymbol}`);
  console.log(`  feeRate:          ${config.vault.feeRateBps} bps (15%)`);
  console.log(`  depositCap:       ${depositCapHuman} USDC (vault total, ${generation}/${tier})`);
  console.log(`  defaultUserCap:   ${config.vault.defaultUserCapHuman} USDC (Free tier, Soft Launch)`);
  console.log(`  maxAllocationAbs: ${tierCap} bps (immutable, tier-defined)`);

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
      name: vaultName,
      symbol: vaultSymbol,
      initialOwner: deployer.address,
      keeper: roles.keeper,
      guardian: roles.guardian,
      treasury: roles.treasury,
      feeRateBps: config.vault.feeRateBps,
      depositCap: depositCap.toString(),
      defaultUserCap: defaultUserCap.toString(),
      version: versionString,
      versionHash,
      maxAllocationAbsolute: tierCap,
      tier,
    },
  });

  console.log(`✓ Saved to deployments/${generation}/${tier}/${network.name}.json`);

  // Inline verify — strategies 등록 전에 vault 가 verify 되어야 Etherscan 의 selector
  // 매칭이 정확히 표시됨 (verify 전엔 selector 만 보고 비슷한 외부 함수 — e.g. Compound 의
  // "Get Market Item" — 와 매칭되어 혼선). 2026-06-10 mainnet 사고 반영.
  if (network.name !== "localhost" && network.name !== "hardhat") {
    const initConfigArg = {
      asset: config.usdc.address,
      name: vaultName,
      symbol: vaultSymbol,
      initialOwner: deployer.address,
      keeper: roles.keeper,
      guardian: roles.guardian,
      treasury: roles.treasury,
      feeRate: config.vault.feeRateBps,
      depositCap,
      defaultUserCap,
      maxAllocationAbsolute: tierCap,
      versionHash,
    };
    await verifyOne(`VaultV2 (${tier})`, vaultAddr, [initConfigArg]);
  }

  console.log("\nNext: scripts/deploy/v2/02-deploy-strategies.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
