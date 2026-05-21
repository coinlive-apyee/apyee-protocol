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

/// Read deployment roles for `networkName`. Each chain has its own `MULTISIG_<NETWORK>`
/// and (optionally) `TREASURY_<NETWORK>`; keeper/guardian are global single EOAs.
/// For dry-runs (network = localhost / hardhat), resolve via the same DRY_RUN_FORK_TARGET /
/// FORK_CHAIN cascade as 00-config.ts so the right MULTISIG_<TARGET> is read.
export function readRoles(networkName: string): DeploymentRoles {
  const targetName =
    networkName === "localhost" || networkName === "hardhat"
      ? resolveDryRunTarget()
      : networkName;
  const upper = targetName.toUpperCase().replace(/-/g, "_");

  const multisig = requireAddress(`MULTISIG_${upper}`);
  const keeper = requireAddress("KEEPER_ADDRESS");
  const guardian = requireAddress("GUARDIAN_ADDRESS");
  const treasury = optionalAddress(`TREASURY_${upper}`) ?? multisig;

  return { multisig, keeper, guardian, treasury };
}

/// Per-chain minimum balance before the deploy script proceeds. L1 (Ethereum) needs the most
/// because 4-step deploy = ~8M gas → at 30 gwei that's ~0.24 ETH. L2 (Base/Arbitrum) settle
/// most fees at <1 gwei so 0.005 ETH covers the same workload with safety margin. BSC mirrors
/// L1 thresholds — gas price is low but BNB volatility justifies the buffer.
const MIN_BALANCE_BY_CHAIN: Record<string, string> = {
  mainnet: "0.05",
  base: "0.005",
  arbitrum: "0.005",
  bsc: "0.05",
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
