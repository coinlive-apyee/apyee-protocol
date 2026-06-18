import { ethers } from "ethers";

import { resolveDryRunTarget } from "../deploy/00-config";

/// Roles required to deploy a Vault on a given chain.
/// - `multisig` is the Gnosis Safe address that the Vault's ownership will be transferred to.
///   Until step 04-transfer-ownership runs, the deployer EOA holds Owner.
/// - `keeper` / `guardian` are single EOAs (typically chain-agnostic).
/// - `treasury` defaults to `multisig` unless overridden — share-price model fees collect there.
export interface DeploymentRoles {
  multisig: string;
  keeper: string;
  guardian: string;
  treasury: string;
}

function requireAddress(envKey: string): string {
  const v = process.env[envKey];
  if (!v) throw new Error(`Missing env: ${envKey}`);
  if (!ethers.isAddress(v)) {
    throw new Error(`Invalid address for ${envKey}: ${v}`);
  }
  return ethers.getAddress(v); // normalize to checksum
}

function optionalAddress(envKey: string): string | undefined {
  const v = process.env[envKey];
  if (!v || v.trim() === "") return undefined;
  if (!ethers.isAddress(v)) {
    throw new Error(`Invalid address for ${envKey}: ${v}`);
  }
  return ethers.getAddress(v);
}

/// Resolve the Keeper EOA address for the active deployment generation.
/// - `APYEE_GENERATION=v1-prod` / `v2-prod` → `KEEPER_ADDRESS_PROD`
/// - other / unset                          → `KEEPER_ADDRESS_DEV`
/// - legacy fallback                        → `KEEPER_ADDRESS` (pre-split .env files)
///
/// dev / prod 를 분리한 이유: prod (v1-prod, v2-prod) 는 실 유저 자금 다루므로 dev smoke /
/// v0-dev cleanup 과 키 격리 권장 (운영 보안). 동일 EOA 재사용 가능하나 권장 안 함.
function isProdGeneration(gen: string): boolean {
  return gen === "v1-prod" || gen === "v2-prod";
}

export function keeperAddressForGeneration(): string {
  const gen = process.env.APYEE_GENERATION ?? "";
  const primary = isProdGeneration(gen) ? "KEEPER_ADDRESS_PROD" : "KEEPER_ADDRESS_DEV";
  const v = process.env[primary] || process.env.KEEPER_ADDRESS;
  if (!v) {
    throw new Error(
      `Missing env: ${primary} (or legacy KEEPER_ADDRESS). APYEE_GENERATION="${gen}"`,
    );
  }
  if (!ethers.isAddress(v)) {
    throw new Error(`Invalid keeper address for generation "${gen}": ${v}`);
  }
  return ethers.getAddress(v);
}

/// Same generation split for the private key. Required by ops scripts that need to
/// broadcast keeper-only tx (smoke / divest / harvest dry-runs).
export function keeperPrivateKeyForGeneration(): string {
  const gen = process.env.APYEE_GENERATION ?? "";
  const primary = isProdGeneration(gen) ? "KEEPER_PRIVATE_KEY_PROD" : "KEEPER_PRIVATE_KEY_DEV";
  const v = process.env[primary] || process.env.KEEPER_PRIVATE_KEY;
  if (!v) {
    throw new Error(
      `Missing env: ${primary} (or legacy KEEPER_PRIVATE_KEY). APYEE_GENERATION="${gen}"`,
    );
  }
  return v;
}

/// Read deployment roles for `networkName`. Each chain has its own `MULTISIG_<NETWORK>`
/// and (optionally) `TREASURY_<NETWORK>`; keeper resolves via `keeperAddressForGeneration()`
/// (dev/prod split); guardian is a global single EOA.
/// For dry-runs (network = localhost / hardhat), resolve via the same DRY_RUN_FORK_TARGET /
/// FORK_CHAIN cascade as 00-config.ts so the right MULTISIG_<TARGET> is read.
export function readRoles(networkName: string): DeploymentRoles {
  const targetName =
    networkName === "localhost" || networkName === "hardhat"
      ? resolveDryRunTarget()
      : networkName;
  const upper = targetName.toUpperCase().replace(/-/g, "_");

  const multisig = requireAddress(`MULTISIG_${upper}`);
  const keeper = keeperAddressForGeneration();
  const guardian = requireAddress("GUARDIAN_ADDRESS");
  const treasury = optionalAddress(`TREASURY_${upper}`) ?? multisig;

  return { multisig, keeper, guardian, treasury };
}

/// Per-chain minimum balance before the deploy script proceeds. L1 (Ethereum) needs the most
/// because 4-step deploy = ~8M gas → at 30 gwei that's ~0.24 ETH. L2 (Base/Arbitrum) settle
/// most fees at <1 gwei so 0.005 ETH covers the same workload with safety margin.
/// BSC: 가스 비용 8M × 0.05 gwei ≈ 0.0004 BNB. 0.02 BNB = 50× 여유 (이전 0.05 는 100× +
/// BNB 변동성 버퍼 였으나 dev 환경엔 과보수적 — 2026-06-09 조정).
const MIN_BALANCE_BY_CHAIN: Record<string, string> = {
  mainnet: "0.05",
  base: "0.005",
  arbitrum: "0.005",
  bsc: "0.02",
  // localhost / hardhat fork: 0.05 fallback (we hardhat_setBalance to 10000 ETH anyway)
  localhost: "0.05",
  hardhat: "0.05",
};

/// Sanity-check before deploy: the deployer EOA must have ETH/BNB for gas.
export function requireGasBalance(
  deployerAddress: string,
  balanceWei: bigint,
  networkName: string,
) {
  const minHuman = MIN_BALANCE_BY_CHAIN[networkName] ?? "0.05";
  const minBalance = ethers.parseEther(minHuman);
  if (balanceWei < minBalance) {
    throw new Error(
      `Deployer ${deployerAddress} on ${networkName} has only ${ethers.formatEther(balanceWei)} ETH/BNB. ` +
        `Need at least ${minHuman} for safe deployment on ${networkName}.`,
    );
  }
}
