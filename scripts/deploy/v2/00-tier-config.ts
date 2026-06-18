import { ethers } from "ethers";

import { getChainConfig, type StrategyEntry } from "../00-config";

/// V2 tier set. See contracts/v2/Vault.sol line 63-65 and docs/page2/V2_VAULT.md §4.1.
export type Tier = "conservative" | "balanced" | "aggressive";

const TIERS: readonly Tier[] = ["conservative", "balanced", "aggressive"];

/// Per-tier immutable cap (`MAX_ALLOCATION_BPS_ABSOLUTE` constructor arg).
/// Embedded in runtime bytecode at deploy time — cannot be changed post-deploy.
export const TIER_CAP_BPS: Record<Tier, number> = {
  conservative: 2500,
  balanced:     4000,
  aggressive:   6000,
};

/// Strategy key allowlist per tier. Keys reference chain config's `strategies` map
/// (V1 00-config.ts).
///
/// - **Conservative**: blue-chip only (aave / compound / morpho). Lower yield, lower
///   protocol risk.
/// - **Balanced**: V1 strategy set (aave + compound + morpho + fluid + spark / kinza
///   per chain). Matches existing V1 policy.
/// - **Aggressive** (Base only — SPEC 1.28.3): A4 + B4 = 8 풀, 신규 `.sol` 0 개.
///   - A4 (safety, non-morpho fallback): `aave`, `compound`, `morpho`, `fluid` — reused
///     from balanced chain config.
///   - B4 (high-APY, morpho-curated MetaMorpho vaults): `gtusdcp` (Gauntlet USDC Prime),
///     `steakusdc` (Steakhouse USDC vanilla), `steakprime` (Steakhouse Prime USDC),
///     `pusdc` (Pangolins USDC) — all reuse `MorphoStrategy.sol`, only `metaMorpho`
///     constructor address differs. 4 풀 주소는 Morpho 공식 GraphQL + Base RPC +
///     백엔드 B-grade scan (`/api/admin/rnd/scan-b-grade`) candidates cross-check
///     검증 완료 (2026-06-09, asset=USDC, Morpho Blue Base
///     0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb).
///
/// 2026-06-09 B-grade scan 결과 반영: 기존 `bbqusdc` (Steakhouse High Yield v1.1,
/// TVL $3.78M) 가 candidates 임계 미달로 빠짐 → 동일 큐레이터(Steakhouse Financial)
/// 의 더 큰 TVL 별트 `steakprime` (Prime USDC, TVL $335M) 으로 교체.
///
/// SPEC 1.28.3 표 (Blueprint / Portofino) 는 메모 오류 — 실제 큐레이터:
///   - BBQUSDC 의 'Blueprint' → Steakhouse Financial (Smokehouse line)
///   - PUSDC 의 'Portofino' → Pangolins
/// see [docs/page2/SPEC.md 1.28.3](../../../docs/page2/SPEC.md#1283-확정-유니버스--a4--b4-2026-06-08-스캔-결과).
export const TIER_STRATEGY_KEYS: Record<Tier, string[] | "all"> = {
  conservative: ["aave", "compound", "morpho"],
  // Balanced = V1 strategy set union (4 체인 V1 prod 와 동일 구성). 체인별로 해당 키가
  // 없으면 strategiesForTier 의 `allow.filter((k) => k in config.strategies)` 가 자동 skip.
  // base 의 B4 (gtusdcp / steakusdc / steakprime / pusdc) 는 명시 제외 — V2_VAULT.md
  // 4.1 정의 "Balanced = V1 strategy set" 일관 + Base balanced 는 A4 4 풀만 적용.
  balanced: ["aave", "compound", "morpho", "fluid", "spark", "kinza", "venus"],
  // A4 + B4 = 8 풀 (Base 전용, base.strategies 에 모두 존재해야 함). Aggressive Vault
  // 가 Base 외 체인에 deploy 되면 base 가 아닌 chain config 에는 B4 키 없어 자동 누락
  // (단 SPEC 1.28.3 상 aggressive 는 Base 단일 배포라 외 체인 deploy 없음).
  aggressive: [
    "aave", "compound", "morpho", "fluid",
    "gtusdcp", "steakusdc", "steakprime", "pusdc",
  ],
};

/// Per-tier × per-generation deposit cap (vault total). Conservative `depositCap`
/// stays lower to enforce the "분산 우선" semantic at the protocol layer (cap is set
/// by Owner, so this is a default — Multi-sig can adjust post-launch via setDepositCap).
///
/// v2-dev: dev dry-run sweet spot (small enough to limit blast radius, large enough
/// to host meaningful smoke flows). v2-prod: Soft Launch range, parameterized in
/// [V2_VAULT.md §4.2](../../docs/page2/V2_VAULT.md) — finalized at dev phase exit.
export function depositCapForV2(generation: string, tier: Tier): string {
  if (generation === "v2-dev") {
    // Match V1 dev (100k) for parity; halved for conservative to mirror the cap intuition.
    return tier === "conservative" ? "50000" : "100000";
  }
  if (generation === "v2-prod") {
    return tier === "conservative" ? "250000" : "500000";
  }
  throw new Error(
    `V2 deploy requires APYEE_GENERATION=v2-dev or v2-prod (got "${generation}")`,
  );
}

/// Per-tier × per-generation Version string. See V2_VAULT.md §4.4 (6 hash matrix).
export function getV2VersionString(generation: string, tier: Tier): string {
  if (!generation.startsWith("v2-")) {
    throw new Error(
      `V2 deploy requires APYEE_GENERATION=v2-dev or v2-prod (got "${generation}")`,
    );
  }
  const env = generation === "v2-prod" ? "prod" : "dev";
  return `2.0.0-${env}-${tier}`;
}

export function getV2VersionHash(generation: string, tier: Tier): string {
  return ethers.keccak256(ethers.toUtf8Bytes(getV2VersionString(generation, tier)));
}

/// Strict tier resolution — throws if `APYEE_TIER` is missing or unrecognized.
/// Use this in deploy scripts where tier is required (vault / strategies / register).
export function requireTier(): Tier {
  const raw = (process.env.APYEE_TIER ?? "").trim().toLowerCase();
  if (!raw) {
    throw new Error(
      "APYEE_TIER not set. Set one of: conservative / balanced / aggressive.",
    );
  }
  if (!TIERS.includes(raw as Tier)) {
    throw new Error(
      `Unknown tier "${raw}". Expected one of: ${TIERS.join(" / ")}`,
    );
  }
  return raw as Tier;
}

/// Resolve the strategy entries to deploy for a given (chain, tier) pair.
///
/// 1. Reads the chain config from V1 [00-config.ts](../00-config.ts).
/// 2. Filters by `TIER_STRATEGY_KEYS[tier]` allowlist.
/// 3. Overrides each entry's `maxBps` to the tier cap so per-strategy caps stay
///    consistent with `MAX_ALLOCATION_BPS_ABSOLUTE`. (The on-chain `addStrategy`
///    would reject anything larger anyway — overriding here keeps logs sane and
///    avoids confusion when reading the deployment record.)
export function strategiesForTier(
  networkName: string,
  tier: Tier,
): Array<{ key: string; entry: StrategyEntry }> {
  const config = getChainConfig(networkName);
  const allow = TIER_STRATEGY_KEYS[tier];
  const cap = TIER_CAP_BPS[tier];

  const keys =
    allow === "all"
      ? Object.keys(config.strategies)
      : allow.filter((k) => k in config.strategies);

  return keys.map((key) => {
    const original = config.strategies[key];
    // Clamp maxBps to tier cap (entries above cap would be rejected on-chain).
    const entry: StrategyEntry = { ...original, maxBps: cap };
    return { key, entry };
  });
}
