import { expect } from "chai";
import { ethers } from "hardhat";

import {
  DEFAULT_FEE_RATE,
  V2_VERSION_HASHES,
  V2_DEPOSIT_CAP,
  V2_DEFAULT_USER_CAP,
  TIER_BALANCED_BPS,
  TIER_AGGRESSIVE_BPS,
} from "../fixtures/deployVaultV2";

/// Hypothesis matrix dry-run — V2_VAULT.md §4.2.
///
/// Per (chain, tier) combination from the active fork, deploy a VaultV2 and confirm:
///   - constructor accepts tier-specific args (cap + versionHash) without revert
///   - first deposit's lazy baseline init triggers correctly with real USDC token
///   - per-tier `MAX_ALLOCATION_BPS_ABSOLUTE` is enforced at runtime
///
/// Mirrors what `npm run deploy:v2:vault` would do on a real chain — same code path, just
/// inline so the fork test gives a deterministic deploy regression signal.
///
/// **Coverage**: 5~6 Vault matrix as of 2026-06-08 (SPEC 1.28.3 확정):
///   - ETH:  Balanced
///   - Base: Balanced, Aggressive (A4 + B4 = 8 풀)
///   - Arb:  Balanced (Aggressive ❌ 제외 — 신규 B 등급 USDC 풀 없음)
///   - BSC:  Balanced
/// Conservative tier deploys skipped for now (per V2_VAULT.md §4.2 "결정 보류 사유": 보수 티어
/// 0~1 미정).

const FORK_ENABLED = process.env.FORK === "true";
const FORK_CHAIN = (process.env.FORK_CHAIN ?? "ethereum").toLowerCase();

const CHAIN_USDC: Record<string, { addr: string; decimals: number }> = {
  ethereum: { addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6  },
  base:     { addr: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6  },
  arbitrum: { addr: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6  },
  bsc:      { addr: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
};

interface MatrixEntry {
  tier: "balanced" | "aggressive";
  tierCap: number;
  versionHash: string;
}

function matrixFor(chain: string): MatrixEntry[] {
  const out: MatrixEntry[] = [
    { tier: "balanced", tierCap: TIER_BALANCED_BPS, versionHash: V2_VERSION_HASHES.devBalanced },
  ];
  // Aggressive is Base-only (SPEC 1.28.3 — Arb 제외 확정).
  if (chain === "base") {
    out.push({ tier: "aggressive", tierCap: TIER_AGGRESSIVE_BPS, versionHash: V2_VERSION_HASHES.devAggressive });
  }
  return out;
}

const describeDryRun = FORK_ENABLED ? describe : describe.skip;

describeDryRun(`V2 dry-run hypothesis matrix — ${FORK_CHAIN}`, function () {
  this.timeout(300_000);

  const chainCfg = CHAIN_USDC[FORK_CHAIN];
  if (!chainCfg) {
    it(`unknown FORK_CHAIN="${FORK_CHAIN}" — skipping`, () => {});
    return;
  }

  const entries = matrixFor(FORK_CHAIN);

  for (const entry of entries) {
    it(`test_dryrun_${FORK_CHAIN}_${entry.tier}_deploysAndFirstDepositWorks`, async () => {
      const [owner, keeper, guardian, treasury] = await ethers.getSigners();

      const VaultV2 = await ethers.getContractFactory("VaultV2");
      const vault = await VaultV2.deploy({
        asset: chainCfg.addr,
        name: `Apyee USDC Vault V2 (${entry.tier[0].toUpperCase()}${entry.tier.slice(1)})`,
        symbol: `apUSDC-${entry.tier[0]}`,
        initialOwner: owner.address,
        keeper: keeper.address,
        guardian: guardian.address,
        treasury: treasury.address,
        feeRate: DEFAULT_FEE_RATE,
        depositCap: V2_DEPOSIT_CAP,
        defaultUserCap: V2_DEFAULT_USER_CAP,
        maxAllocationAbsolute: entry.tierCap,
        versionHash: entry.versionHash,
      });
      await vault.waitForDeployment();

      expect(await vault.MAX_ALLOCATION_BPS_ABSOLUTE()).to.equal(entry.tierCap);
      expect(await vault.VERSION_HASH()).to.equal(entry.versionHash);
      expect(await vault.feeRate()).to.equal(DEFAULT_FEE_RATE);
      // decimalsOffset 6 → vault decimals = asset.decimals + 6
      expect(await vault.decimals()).to.equal(chainCfg.decimals + 6);
    });
  }
});
