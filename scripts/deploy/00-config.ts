import { ethers } from "ethers";

/// Per-chain deployment configuration.
/// Network names match Hardhat's `networks` keys in hardhat.config.ts.
///
/// Schema v2 (2026-05): `strategies` is a named map so multiple instances of the same
/// adapter (e.g. Aave + Spark on Ethereum, or Aave + Kinza on BSC — both `AaveV3Strategy.sol`
/// with different pool addresses) can coexist on the same chain. Each entry's `adapter` field
/// dispatches to the right contract factory in 02-deploy-strategies.ts; remaining fields are
/// the adapter-specific constructor args beyond `(vault, asset)`.
///
/// Naming convention for strategy keys: lowercase protocol name (`aave`, `compound`, `morpho`,
/// `venus`, `spark`, `kinza`, `fluid`). Keys are stable identifiers — used by deploy scripts,
/// verify, prepare-manual-verify, and keeper-smoke `STRATEGY=<key>` env.

export type AdapterName =
  | "AaveV3Strategy"
  | "CompoundV3Strategy"
  | "MorphoStrategy"
  | "VenusStrategy"
  | "FluidStrategy";

interface BaseStrategyEntry {
  /// Initial target allocation (Keeper aims for this), bps of TVL.
  targetBps: number;
  /// Per-strategy hard cap (must satisfy MAX_ALLOCATION_BPS_ABSOLUTE = 4000 in Vault.sol).
  maxBps: number;
  /// Canonical user-facing display name. Single source of truth — server / frontend MUST
  /// derive labels from here (via deployment JSON's strategyMeta) to prevent stale labels
  /// like "Steakhouse USDC" (was rebranded to "Smokehouse USDC") / "Portofino" (memo error;
  /// real curator is Pangolins) / "Usual Boosted USDC" (server-side mislabel) recurring.
  /// See SPEC 1.28.3 + memory_v2_prod_naming_canonical (2026-06-17).
  display: string;
  /// Server slug — kebab-case of display name. Used for /api/strategy/* routes + frontend
  /// activity URLs. Must match server's `getStrategyActivitySlug(vaultStrategyName)` output.
  slug: string;
}

export interface AaveStrategyEntry extends BaseStrategyEntry {
  adapter: "AaveV3Strategy";
  pool: string;
  aUsdc: string;
}

export interface CompoundStrategyEntry extends BaseStrategyEntry {
  adapter: "CompoundV3Strategy";
  comet: string;
}

export interface MorphoStrategyEntry extends BaseStrategyEntry {
  adapter: "MorphoStrategy";
  metaMorpho: string;
}

export interface VenusStrategyEntry extends BaseStrategyEntry {
  adapter: "VenusStrategy";
  vUsdc: string;
}

export interface FluidStrategyEntry extends BaseStrategyEntry {
  adapter: "FluidStrategy";
  fluidVault: string; // fUSDC address (ERC-4626 fToken)
}

export type StrategyEntry =
  | AaveStrategyEntry
  | CompoundStrategyEntry
  | MorphoStrategyEntry
  | VenusStrategyEntry
  | FluidStrategyEntry;

export interface ChainConfig {
  displayName: string;
  chainId: number;

  /// Underlying asset for the Vault.
  usdc: { address: string; decimals: number };

  /// Named map of strategies to deploy + register on this chain.
  /// Order is determined by Object.keys insertion order (used for deploy + register order).
  strategies: Record<string, StrategyEntry>;

  /// ERC-4626 vault metadata + Soft Launch defaults.
  vault: {
    name: string;
    symbol: string;
    feeRateBps: number;
    depositCapHuman: string;        // Vault total cap. e.g. "10000" → parseUnits with usdc.decimals
    defaultUserCapHuman: string;    // Per-user cap (Free tier). SPEC 1.21.4
  };
}

const VAULT_DEFAULTS = {
  name: "Apyee USDC Vault",
  symbol: "apUSDC",
  feeRateBps: 1500, // 15%
  depositCapHuman: "10000",      // Beta default. Per-generation override via depositCapForGeneration().
  defaultUserCapHuman: "10000",  // Soft Launch per-user Free cap = $10K (1.21.4)
} as const;

/// Per-generation vault total cap (depositCap). SPEC 1.21.4 staged cap table.
/// - v1-dev:  $100K (dev dry-test sweet spot — wide enough for ops scenarios)
/// - v1-prod: $500K (Soft Launch — 50 users × $10K Free cap)
/// - other:   $10K (Beta default fallback)
///
/// Used by 01-deploy-vault.ts at construction time. Per-user cap (defaultUserCap)
/// stays at $10K for both generations — only total cap differs.
export function depositCapForGeneration(generation: string): string {
  switch (generation) {
    case "v1-prod":
      return "500000";
    case "v1-dev":
      return "100000";
    default:
      return VAULT_DEFAULTS.depositCapHuman;
  }
}

/// Generation → version string mapping. Used by 01-deploy-vault.ts + 02-deploy-strategies.ts
/// to set Vault.VERSION_HASH + BaseStrategy.STRATEGY_VERSION_HASH at deploy time. SPEC 1.22.
///
/// The hash form (vs raw string) is critical for genuine bytecode separation between
/// dev/prod — `immutable bytes32` values are embedded in runtime bytecode, so etherscan
/// cannot cross-reference dev/prod via shared bytecode ("Similar Match" elimination).
const VERSION_MAP: Record<string, string> = {
  "v1-dev": "1.0.0-dev",
  "v1-prod": "1.0.0",
};

/// Resolve the on-chain version string for the given generation (human-readable form).
/// Throws if generation is empty or unknown — every deploy must declare its generation.
export function getVersionString(generation: string): string {
  if (!generation) {
    throw new Error(
      "Generation not set. Either set APYEE_GENERATION env (e.g. APYEE_GENERATION=v1-prod) " +
        "or create deployments/_generation pointer file. See SPEC 1.22 Runbook.",
    );
  }
  const v = VERSION_MAP[generation];
  if (!v) {
    throw new Error(
      `Unknown generation "${generation}". Expected one of: ${Object.keys(VERSION_MAP).join(", ")}`,
    );
  }
  return v;
}

/// Resolve the keccak256 hash of the version string. Passed to Vault + Strategy constructors.
/// `keccak256(toUtf8Bytes("1.0.0"))` for prod, `keccak256(toUtf8Bytes("1.0.0-dev"))` for dev.
export function getVersionHash(generation: string): string {
  const versionString = getVersionString(generation);
  return ethers.keccak256(ethers.toUtf8Bytes(versionString));
}

export const CHAINS: Record<string, ChainConfig> = {
  // ─── Ethereum mainnet ───
  mainnet: {
    displayName: "Ethereum",
    chainId: 1,
    usdc: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    strategies: {
      aave: {
        adapter: "AaveV3Strategy",
        pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
        aUsdc: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
        display: "Aave V3",
        slug: "aave-v3",
        targetBps: 3000,
        maxBps: 4000,
      },
      compound: {
        adapter: "CompoundV3Strategy",
        comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
        display: "Compound V3",
        slug: "compound-v3",
        targetBps: 2500,
        maxBps: 4000,
      },
      morpho: {
        adapter: "MorphoStrategy",
        // Smokehouse USDC (bbqUSDC) — Steakhouse Financial 큐레이터 (Base steakUSDC vanilla +
        // Steakhouse Prime 와 동일 multisig 0x827e86...AdeCdB). V1 prod 배포 시점 (2026-05-07,
        // commit fbf03b3) 에는 vault 명칭이 "Steakhouse USDC" 였으나 이후 Steakhouse Financial
        // 이 라인업 확장하면서 본 vault 를 고수익 변종으로 분리 + "Smokehouse USDC / bbqUSDC"
        // 로 리브랜드. on-chain name 직접 검증 (2026-06-17, scripts/ops/check-morpho-name.ts).
        // 큐레이터 노출: mainnet Smokehouse (본 슬롯) + Base aggressive 의 steakUSDC vanilla +
        // Steakhouse Prime = Steakhouse Financial multisig 운영 3 vault. 단 vault 단위 분리
        // (서로 다른 immutable Vault, 다른 user pool, 종목 cap 별도 적용) 라 단일 Vault 집중
        // 없음. SPEC.md 1.28.3 격리 주석 참조. Lowercase 는 strict EIP-55 skip.
        metaMorpho: "0xbeefff209270748ddd194831b3fa287a5386f5bc",
        display: "Smokehouse USDC",
        slug: "smokehouse-usdc",
        targetBps: 2000,
        maxBps: 4000,
      },
      // Spark (Aave V3 fork by MakerDAO/Sky). Reuses AaveV3Strategy.sol — same interface,
      // different pool. USDC market active with ~$34M TVL on Etherscan (verified 2026-05).
      spark: {
        adapter: "AaveV3Strategy",
        pool: "0xC13e21B648A5Ee794902342038FF3aDAB66BE987",
        aUsdc: "0x377C3bd93f2a2984E1E7bE6A5C22c525eD4A4815", // spUSDC, 6 dec
        display: "Spark",
        slug: "spark",
        targetBps: 1500,
        maxBps: 4000,
      },
      // Fluid Lending (Instadapp). ERC-4626 fToken — reuses the standard ERC-4626 adapter
      // pattern via FluidStrategy.sol. ~$192M TVL on Ethereum (verified 2026-05).
      fluid: {
        adapter: "FluidStrategy",
        fluidVault: "0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33", // fUSDC, 6 dec
        display: "Fluid",
        slug: "fluid",
        targetBps: 1500,
        maxBps: 4000,
      },
    },
    vault: { ...VAULT_DEFAULTS },
  },

  // ─── Base ───
  base: {
    displayName: "Base",
    chainId: 8453,
    usdc: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    strategies: {
      aave: {
        adapter: "AaveV3Strategy",
        pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
        aUsdc: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
        display: "Aave V3",
        slug: "aave-v3",
        targetBps: 3000,
        maxBps: 4000,
      },
      compound: {
        adapter: "CompoundV3Strategy",
        comet: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
        display: "Compound V3",
        slug: "compound-v3",
        targetBps: 2500,
        maxBps: 4000,
      },
      // Moonwell Flagship USDC — MetaMorpho curated by B.Protocol + Block Analitica.
      // ~$9.8M TVL on Base (verified 2026-05). Lowercase to skip strict EIP-55 check.
      morpho: {
        adapter: "MorphoStrategy",
        metaMorpho: "0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca",
        display: "Moonwell Flagship USDC",
        slug: "moonwell-flagship-usdc",
        targetBps: 2000,
        maxBps: 4000,
      },
      // Fluid Lending on Base. ERC-4626 fToken. ~$16M TVL (verified 2026-05).
      fluid: {
        adapter: "FluidStrategy",
        fluidVault: "0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169", // fUSDC, 6 dec
        display: "Fluid",
        slug: "fluid",
        targetBps: 1500,
        maxBps: 4000,
      },

      // ─── B4: aggressive 티어 전용 (SPEC 1.28.3) ───
      // 4 entries 모두 MetaMorpho 큐레이티드 USDC vaults on Base. 어댑터 재사용
      // (MorphoStrategy), 신규 .sol 없음. tier-config 의 strategiesForTier 가 tier 별
      // maxBps 를 클램프하므로 여기 maxBps 4000 은 balanced 컨텍스트용 (aggressive 면
      // 6000 으로 자동 상향). 풀 주소 / 큐레이터 매핑 검증: 트랙 B 단일 출처 +
      // Morpho 공식 GraphQL API + Base RPC asset()/MORPHO() 직접 호출 (2026-06-09).

      // GTUSDCP — Gauntlet USDC Prime (Gauntlet 큐레이터). TVL $440M, B4 중 최대.
      // 백엔드 B-grade scan candidate poolId 8: e0672197 (2026-06-09).
      gtusdcp: {
        adapter: "MorphoStrategy",
        metaMorpho: "0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61",
        display: "Gauntlet USDC Prime",
        slug: "gauntlet-usdc-prime",
        targetBps: 1500,
        maxBps: 4000,
      },
      // STEAKUSDC — Steakhouse USDC vanilla flagship (Steakhouse Financial 큐레이터).
      // TVL $288M. 백엔드 B-grade scan candidate poolId 8: 81ae8812 (인센트 8%, MDD -50.2%).
      steakusdc: {
        adapter: "MorphoStrategy",
        metaMorpho: "0xbeef010f9cb27031ad51e3333f9af9c6b1228183",
        display: "Steakhouse USDC",
        slug: "steakhouse-usdc",
        targetBps: 1500,
        maxBps: 4000,
      },
      // STEAKPRIME — Steakhouse Prime USDC (Steakhouse Financial 동일 multisig 가 운영
      // 하는 별도 line, vanilla 와 owner/curator 일치). TVL $335M, MDD -56.1%, organic.
      // 큐레이터 의존도 ↑ 위험 있으나 risk-adjusted 정상. 백엔드 B-grade scan candidate
      // poolId 8: 7820bd3c. 2026-06-09 B-grade scan 결과 B4 슬롯 신규 추가 (bbqusdc 교체).
      steakprime: {
        adapter: "MorphoStrategy",
        metaMorpho: "0xbeefe94c8ad530842bfe7d8b397938ffc1cb83b2",
        display: "Steakhouse Prime USDC",
        slug: "steakhouse-prime-usdc",
        targetBps: 1500,
        maxBps: 4000,
      },
      // PUSDC — Pangolins USDC (Pangolins 큐레이터). SPEC 1.28.3 의 "Portofino" 표기는
      // 메모 오류 — Morpho 에 Portofino 큐레이터 실존 안 함. sym=pUSDC 의 실제 큐레이터
      // 는 Pangolins. TVL $30M, MDD -38.9% (B4 중 최저). 백엔드 scan candidate: c1949c46.
      pusdc: {
        adapter: "MorphoStrategy",
        metaMorpho: "0x1401d1271c47648ac70cbcdfa3776d4a87ce006b",
        display: "Pangolins USDC",
        slug: "pangolins-usdc",
        targetBps: 1500,
        maxBps: 4000,
      },
      // NOTE: 이전 B4 슬롯의 `bbqusdc` (Steakhouse High Yield USDC v1.1,
      // 0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F, TVL $3.78M) 는 2026-06-09 B-grade
      // scan candidates 임계 (유동성/TVL) 에서 빠짐 → 동일 큐레이터(Steakhouse Financial)
      // 의 더 큰 TVL 별트 steakprime 으로 교체.
    },
    vault: { ...VAULT_DEFAULTS },
  },

  // ─── Arbitrum One ───
  arbitrum: {
    displayName: "Arbitrum",
    chainId: 42161,
    usdc: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 }, // Native USDC
    strategies: {
      aave: {
        adapter: "AaveV3Strategy",
        pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        aUsdc: "0x724dc807b04555b71ed48a6896b6F41593b8C637",
        display: "Aave V3",
        slug: "aave-v3",
        targetBps: 3000,
        maxBps: 4000,
      },
      compound: {
        adapter: "CompoundV3Strategy",
        comet: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
        display: "Compound V3",
        slug: "compound-v3",
        targetBps: 2500,
        maxBps: 4000,
      },
      // Gauntlet USDC Prime — MetaMorpho curated by Gauntlet on Arbitrum.
      // ~$2.8M TVL (verified 2026-05). Lowercase per EIP-55 escape pattern.
      morpho: {
        adapter: "MorphoStrategy",
        metaMorpho: "0x7c574174da4b2be3f705c6244b4bfa0815a8b3ed",
        display: "Gauntlet USDC Prime",
        slug: "gauntlet-usdc-prime",
        targetBps: 2000,
        maxBps: 4000,
      },
      // Fluid Lending on Arbitrum. ERC-4626 fToken. ~$48M TVL (verified 2026-05).
      fluid: {
        adapter: "FluidStrategy",
        fluidVault: "0x1A996cb54bb95462040408C06122D45D6Cdb6096", // fUSDC, 6 dec
        display: "Fluid",
        slug: "fluid",
        targetBps: 1500,
        maxBps: 4000,
      },
    },
    vault: { ...VAULT_DEFAULTS },
  },

  // ─── BNB Chain ───
  bsc: {
    displayName: "BNB Chain",
    chainId: 56,
    // Binance-Peg USDC has 18 decimals (different from Ethereum's 6) — share decimals → 24.
    usdc: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
    strategies: {
      venus: {
        adapter: "VenusStrategy",
        vUsdc: "0xeca88125a5adbe82614ffc12d0db554e2e2867c8",
        display: "Venus",
        slug: "venus",
        targetBps: 3000,
        maxBps: 4000,
      },
      // Aave V3 on BNB Chain — official Aave V3 deployment (2024). Uses Binance-Peg USDC
      // (18 decimals) like every BSC strategy. ~$17M TVL on USDC market (verified 2026-05).
      // targetBps 30% — aligns with ETH/Base/Arb aave (Phase 5 첫 add 시 BSC 합계 90%).
      aave: {
        adapter: "AaveV3Strategy",
        pool: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
        aUsdc: "0x00901a076785e0906d1028c7d6372d247bec7d61", // aBnbUSDC, 18 dec
        display: "Aave V3",
        slug: "aave-v3",
        targetBps: 3000,
        maxBps: 4000,
      },
      // Kinza (Aave V3 fork on BSC). Smaller market (~$933K TVL) — same 40% cap as
      // siblings per SPEC 1.23.8 (cap = ceiling, not fixed allocation; Keeper picks the
      // active distribution by APY). Reuses AaveV3Strategy.sol — same Pool interface.
      kinza: {
        adapter: "AaveV3Strategy",
        pool: "0xcb0620b181140e57d1c0d8b724cde623ca963c8c",
        aUsdc: "0x26c8c9d74eAe6182316B30dE9ac60e2AdC9F4a04", // kUSDC, 18 dec
        display: "Kinza",
        slug: "kinza",
        targetBps: 1500,
        maxBps: 4000,
      },
      // Fluid Lending on BNB Chain. ERC-4626 fToken (18 dec to match Binance-Peg USDC).
      // ~$3.8M TVL (verified 2026-05). This becomes the BSC 4th strategy resolving the
      // earlier 1.23 gap — Fluid is the only credible non-Compound-V3 lending protocol
      // available on BSC.
      fluid: {
        adapter: "FluidStrategy",
        fluidVault: "0xfE60462E93cee34319F48Cfc6AcFbc13c2882Df9", // fUSDC, 18 dec
        display: "Fluid",
        slug: "fluid",
        targetBps: 1500,
        maxBps: 4000,
      },
    },
    vault: { ...VAULT_DEFAULTS },
  },
};

/// `localhost` (Hardhat node forked from mainnet) is treated as a mainnet alias for dry-run
/// purposes — protocol addresses (Aave/Compound/Morpho) all exist on the fork, and step-04
/// transferOwnership works because the deterministic Safe at MULTISIG_MAINNET has bytecode on
/// mainnet (and therefore on its fork). Override with DRY_RUN_FORK_TARGET=base|arbitrum|bsc to
/// dry-run a different chain.
export function resolveDryRunTarget(): string {
  if (process.env.DRY_RUN_FORK_TARGET) return process.env.DRY_RUN_FORK_TARGET;
  const fc = process.env.FORK_CHAIN;
  if (!fc || fc === "ethereum") return "mainnet";
  return fc; // bsc / base / arbitrum
}

export function getChainConfig(networkName: string): ChainConfig {
  if (networkName === "localhost" || networkName === "hardhat") {
    const target = resolveDryRunTarget();
    const c = CHAINS[target];
    if (!c) {
      throw new Error(
        `DRY_RUN_FORK_TARGET="${target}" is not a known chain. ` +
          `Supported: ${Object.keys(CHAINS).join(", ")}`,
      );
    }
    return c;
  }
  const c = CHAINS[networkName];
  if (!c) {
    throw new Error(
      `No deployment config for network "${networkName}". ` +
        `Supported: ${Object.keys(CHAINS).join(", ")}`,
    );
  }
  return c;
}

/// Adapter-specific constructor argument extractor. Returns the args beyond
/// `(vaultAddress, assetAddress)` which every adapter receives.
export function constructorArgsFor(entry: StrategyEntry): unknown[] {
  switch (entry.adapter) {
    case "AaveV3Strategy":
      return [entry.pool, entry.aUsdc];
    case "CompoundV3Strategy":
      return [entry.comet];
    case "MorphoStrategy":
      return [entry.metaMorpho];
    case "VenusStrategy":
      return [entry.vUsdc];
    case "FluidStrategy":
      return [entry.fluidVault];
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

/// Source file name for the verify script's standard-JSON lookup.
export function sourceNameFor(entry: StrategyEntry): string {
  switch (entry.adapter) {
    case "AaveV3Strategy":
      return "contracts/strategies/AaveV3Strategy.sol";
    case "CompoundV3Strategy":
      return "contracts/strategies/CompoundV3Strategy.sol";
    case "MorphoStrategy":
      return "contracts/strategies/MorphoStrategy.sol";
    case "VenusStrategy":
      return "contracts/strategies/VenusStrategy.sol";
    case "FluidStrategy":
      return "contracts/strategies/FluidStrategy.sol";
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}
