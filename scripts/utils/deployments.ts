import * as fs from "fs";
import * as path from "path";

/// On-disk deployment record. Persisted to `deployments/<network>.json` so subsequent
/// scripts (02-deploy-strategies, 03-register, 04-transfer-ownership, verify) can
/// chain off the previous step's output.
///
/// Schema v2 (2026-05): strategies live under `contracts.strategies` as a named map so
/// multiple instances of the same adapter (e.g. Aave + Spark + Kinza all using
/// AaveV3Strategy.sol) can coexist on the same chain. Existing Beta records use the
/// legacy `aaveStrategy` / `compoundStrategy` / `morphoStrategy` / `venusStrategy`
/// top-level slots — loadDeployment migrates those into the new map on the fly.
export interface DeploymentRecord {
  network: string;
  chainId: number;
  timestamp: string;
  deployer: string;
  contracts: {
    vault?: string;
    /// Address-only map (key → deployed strategy contract address). Backward compatible —
    /// every generation (v0-dev / v1-* / v2-*) populates this.
    strategies?: Record<string, string>;
    /// Canonical naming metadata per strategy key (key → {slug, display}). Added 2026-06-17
    /// to anchor the user-facing label in the deployment evidence — prevents stale labels
    /// (Steakhouse → Smokehouse, Portofino → Pangolins, Usual Boosted → Pangolins) from
    /// cascading from the contract layer to server / frontend. Server MUST read `slug` /
    /// `display` from here rather than re-deriving from internal keys.
    /// V2-prod (2026-06-17 onward) populates this. Earlier records omit (optional).
    strategyMeta?: Record<string, { slug: string; display: string }>;
  };
  config: {
    asset: string;
    name: string;
    symbol: string;
    initialOwner: string;
    keeper: string;
    guardian: string;
    treasury: string;
    feeRateBps: number;
    depositCap: string; // string to keep large bigint serializable
    defaultUserCap?: string; // optional for legacy v0-dev records; required from v1.0.0 prod
    version?: string; // optional for legacy v0-dev records; human-readable ("1.0.0" / "1.0.0-dev")
    versionHash?: string; // optional for legacy v0-dev records; keccak256(version) bytes32 (0x...) — used by verify
    // V2 only — Vault.constructor InitConfig.maxAllocationAbsolute (per-tier immutable cap, bps).
    // V1 omits (constant 4000 lives in the bytecode).
    maxAllocationAbsolute?: number;
    // V2 only — tier label ("conservative" / "balanced" / "aggressive"). Drives the V2 verify
    // path and matches the on-chain VERSION_HASH suffix.
    tier?: string;
  };
  ownershipTransferred?: {
    to: string;
    txHash: string;
    blockNumber: number;
  };
}

const DEPLOYMENTS_DIR = path.join(__dirname, "..", "..", "deployments");

/// Resolve the active deployment generation (e.g. "v2-prod", "v2-dev", "v1-prod", "v1-dev", "v0-dev").
/// Priority: env `APYEE_GENERATION` > `deployments/_generation` pointer file > legacy flat (empty).
///
/// Returns "" for legacy (current mainnet files at `deployments/<network>.json`).
/// Returns "v1-prod" / "v1-dev" / etc. for generation-aware deploys, in which case files live at
/// `deployments/<generation>/<network>.json`. SPEC 1.22 Runbook.
/// For v2-* generations, files live at `deployments/<generation>/<tier>/<network>.json`
/// (additional tier dimension — see APYEE_TIER + V2_VAULT.md §4.3).
export function getGeneration(): string {
  const env = process.env.APYEE_GENERATION?.trim();
  if (env) return env;
  const ptr = path.join(DEPLOYMENTS_DIR, "_generation");
  if (fs.existsSync(ptr)) return fs.readFileSync(ptr, "utf8").trim();
  return "";
}

/// Resolve the active tier (V2 only — "conservative" / "balanced" / "aggressive").
/// Returns "" if not set. V2 deploys must set this; V1 deploys ignore it.
export function getTier(): string {
  return process.env.APYEE_TIER?.trim() ?? "";
}

function generationDir(): string {
  const gen = getGeneration();
  if (!gen) return DEPLOYMENTS_DIR;
  if (gen.startsWith("v2-")) {
    const tier = getTier();
    if (!tier) {
      throw new Error(
        `Generation "${gen}" requires APYEE_TIER. ` +
          `Set APYEE_TIER to one of conservative / balanced / aggressive.`,
      );
    }
    return path.join(DEPLOYMENTS_DIR, gen, tier);
  }
  return path.join(DEPLOYMENTS_DIR, gen);
}

function ensureDir() {
  const dir = generationDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function deploymentPath(networkName: string): string {
  return path.join(generationDir(), `${networkName}.json`);
}

export function loadDeployment(networkName: string): DeploymentRecord | undefined {
  const p = deploymentPath(networkName);
  if (!fs.existsSync(p)) return undefined;
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as DeploymentRecord & {
    contracts: { aaveStrategy?: string; compoundStrategy?: string; morphoStrategy?: string; venusStrategy?: string };
  };
  // Migrate legacy top-level slots into the new strategies map (in-memory only —
  // writes go through saveDeployment which emits the new shape).
  if (!raw.contracts.strategies) raw.contracts.strategies = {};
  const legacy: Record<string, string | undefined> = {
    aave: raw.contracts.aaveStrategy,
    compound: raw.contracts.compoundStrategy,
    morpho: raw.contracts.morphoStrategy,
    venus: raw.contracts.venusStrategy,
  };
  for (const [name, addr] of Object.entries(legacy)) {
    if (addr && !raw.contracts.strategies[name]) {
      raw.contracts.strategies[name] = addr;
    }
  }
  return raw;
}

export function saveDeployment(record: DeploymentRecord) {
  ensureDir();
  // Strip any legacy top-level strategy slots before write — strategies map is canonical.
  // Preserve strategyMeta (added 2026-06-17 for canonical naming evidence — see [[1]] in
  // DeploymentRecord). Earlier this cleaned-spread silently dropped strategyMeta whenever
  // updateDeployment was called by step 04-transfer-ownership.ts → mainnet + arbitrum
  // v2-prod records lost strategyMeta and frontend slug mapping went stale (2026-06-18 incident).
  const cleaned: DeploymentRecord = {
    ...record,
    contracts: {
      vault: record.contracts.vault,
      strategies: record.contracts.strategies ?? {},
      ...(record.contracts.strategyMeta ? { strategyMeta: record.contracts.strategyMeta } : {}),
    },
  };
  fs.writeFileSync(deploymentPath(record.network), JSON.stringify(cleaned, null, 2));
}

/// Merge new fields into an existing deployment record (used by later steps to add
/// strategy addresses / ownership transfer info without overwriting earlier data).
export function updateDeployment(networkName: string, updater: (r: DeploymentRecord) => void) {
  const existing = loadDeployment(networkName);
  if (!existing) {
    throw new Error(
      `No deployment record found for "${networkName}". Run 01-deploy-vault first.`,
    );
  }
  updater(existing);
  saveDeployment(existing);
}
