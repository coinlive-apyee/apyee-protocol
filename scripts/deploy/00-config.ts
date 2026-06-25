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
  /// V2.1 (Soken F-04) — RewardsController for the (chain, pool) variant. Spark and
  /// Kinza fork-pools have their own controller distinct from Aave V3's. address(0)
  /// opts out (no claim hook fires).
  rewardsController?: string;
  /// V2.1 (Soken F-04) — single reward token harvested by this Aave-family instance
  /// (SPK for Spark, KINZA for Kinza, stkAAVE on chains where Aave V3 supplies are
  /// actually incentivized). address(0) opts out.
  rewardToken?: string;
}

export interface CompoundStrategyEntry extends BaseStrategyEntry {
  adapter: "CompoundV3Strategy";
  comet: string;
  /// V2.1 (Soken F-04) — CometRewards distributor for the chain.
  cometRewards?: string;
}

export interface MorphoStrategyEntry extends BaseStrategyEntry {
  adapter: "MorphoStrategy";
  metaMorpho: string;
  /// V2.1 (Soken F-04) — Universal Rewards Distributor (URD). Multiple URDs may exist
  /// per chain; we pin one per strategy instance. reward token + cumulative amount +
  /// merkle proof are supplied per-call by the Keeper (off-chain).
  urd?: string;
}

export interface VenusStrategyEntry extends BaseStrategyEntry {
  adapter: "VenusStrategy";
  vUsdc: string;
  /// V2.1 (Soken F-04) — Venus Unitroller proxy (Comptroller).
  comptroller?: string;
  /// V2.1 (Soken F-04) — XVS reward token.
  rewardToken?: string;
}

export interface FluidStrategyEntry extends BaseStrategyEntry {
  adapter: "FluidStrategy";
  fluidVault: string; // fUSDC address (ERC-4626 fToken)
  /// V2.1 (Soken F-04) — Fluid MerkleDistributor. Enforces msg.sender == recipient.
  fluidDistributor?: string;
  /// V2.1 (Soken F-04) — FLUID reward token (formerly INST; same contract address).
  rewardToken?: string;
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

  /// V2.1 (Soken F-04) — UniswapV3 SwapRouter02 on ETH / Base / Arb, PancakeV3 SmartRouter
  /// on BSC. All four follow the same `exactInputSingle` shape (PancakeV3 is a UniV3 fork).
  /// Used by every strategy adapter's `claimAndCompound` to swap protocol reward tokens
  /// (COMP / XVS / SPK / MORPHO / FLUID) into the underlying asset before re-depositing.
  /// Set to `ethers.ZeroAddress` to opt strategies on this chain out of compounding.
  dexRouter?: string;

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
    // V2.1 (Soken F-04): UniswapV3 SwapRouter02 — used by every adapter's claimAndCompound
    // to swap reward tokens to USDC. Same address on ETH + Arbitrum.
    dexRouter: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    strategies: {
      aave: {
        adapter: "AaveV3Strategy",
        pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
        aUsdc: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
        // V2.1 (Soken F-04): Aave V3 RewardsController on Ethereum. The aUSDC market itself
        // has no live reward emission today, so rewardToken is left address(0) and
        // `claimAndCompound` no-ops. The controller address is kept populated so a future
        // Aave program can be activated by re-deploying with rewardToken set.
        rewardsController: "0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb",
        rewardToken: ethers.ZeroAddress,
        display: "Aave V3",
        slug: "aave-v3",
        targetBps: 3000,
        maxBps: 4000,
      },
      compound: {
        adapter: "CompoundV3Strategy",
        comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
        // V2.1 (Soken F-04): Compound V3 CometRewards on Ethereum. The reward token (COMP)
        // is read dynamically from `cometRewards.rewardConfig(comet)` at claim time, so we
        // don't pin it here — forward-compatible with reward-token migrations.
        cometRewards: "0x1B0e765F6224C21223AeA2af16c1C46E38885a40",
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
        // V2.1 (Soken F-04): Morpho Universal Rewards Distributor on Ethereum.
        // Reward token (MORPHO + curator tokens) is supplied per-call by the Keeper
        // alongside the cumulative claim amount + merkle proof.
        urd: "0x330eefa8a787552DC5cAd3C3cA644844B1E61Ddb",
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
        // V2.1 (Soken F-04): Spark has its own RewardsController distinct from Aave V3's.
        // Currently set to address(0) pending confirmation of Spark's per-chain controller
        // + SPK token availability. Verify against docs.spark.fi before activating.
        rewardsController: ethers.ZeroAddress,
        rewardToken: ethers.ZeroAddress,
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
        // V2.1 (Soken F-04): Fluid MerkleDistributor + FLUID reward token (formerly INST,
        // same contract address). USDC/USDT lending rewards officially end 2026-06-30 —
        // after that date, claims still settle previously-cumulated rewards but no new
        // emission accrues. Pinned regardless so any residual cumulative claim survives.
        fluidDistributor: "0xF398E66B1273a34558AeBbEC550DccaF4AcC7714",
        rewardToken: "0x6f40d4A6237C257fff2dB00FA0510DeEECd303eb",
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
    // V2.1 (Soken F-04): UniswapV3 SwapRouter02 on Base.
    dexRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
    strategies: {
      aave: {
        adapter: "AaveV3Strategy",
        pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
        aUsdc: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
        // V2.1 (Soken F-04): Aave V3 RewardsController on Base. The aUSDC market on Base
        // has no active reward emission today; rewardToken pinned to address(0).
        rewardsController: "0xf9cc4F0D883F1a1eb2c253bdb46c254Ca51E1F44",
        rewardToken: ethers.ZeroAddress,
        display: "Aave V3",
        slug: "aave-v3",
        targetBps: 3000,
        maxBps: 4000,
      },
      compound: {
        adapter: "CompoundV3Strategy",
        comet: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
        // V2.1 (Soken F-04): Compound V3 CometRewards on Base.
        cometRewards: "0x123964802e6ABabBE1Bc9547D72Ef1B69B00A6b1",
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
        // V2.1 (Soken F-04): Morpho URD on Base (same canonical URD shape as Ethereum).
        // Address pending confirmation from docs.morpho.org/addresses — leave as address(0)
        // and re-deploy this strategy once verified. Keeper-side claim is no-op until then.
        urd: ethers.ZeroAddress,
        display: "Moonwell Flagship USDC",
        slug: "moonwell-flagship-usdc",
        targetBps: 2000,
        maxBps: 4000,
      },
      // Fluid Lending on Base. ERC-4626 fToken. ~$16M TVL (verified 2026-05).
      fluid: {
        adapter: "FluidStrategy",
        fluidVault: "0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169", // fUSDC, 6 dec
        // V2.1 (Soken F-04): Fluid distributor address on Base TBD — Fluid has expanded
        // multi-chain but the per-chain distributor proxy needs explicit confirmation
        // from github.com/Instadapp/fluid-contracts-public/deployments/base.
        // Left as address(0); re-deploy with the verified address before activating.
        fluidDistributor: ethers.ZeroAddress,
        rewardToken: ethers.ZeroAddress,
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
    // V2.1 (Soken F-04): UniswapV3 SwapRouter02 on Arbitrum (same canonical address as ETH).
    dexRouter: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    strategies: {
      aave: {
        adapter: "AaveV3Strategy",
        pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        aUsdc: "0x724dc807b04555b71ed48a6896b6F41593b8C637",
        // V2.1 (Soken F-04): Aave V3 RewardsController on Arbitrum. No active emission today.
        rewardsController: "0x929EC64c34a17401F460460D4B9390518E5B473e",
        rewardToken: ethers.ZeroAddress,
        display: "Aave V3",
        slug: "aave-v3",
        targetBps: 3000,
        maxBps: 4000,
      },
      compound: {
        adapter: "CompoundV3Strategy",
        comet: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
        // V2.1 (Soken F-04): Compound V3 CometRewards on Arbitrum.
        cometRewards: "0x88730d254A2f7e6AC8388c3198aFd694bA9f7fae",
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
        // V2.1 (Soken F-04): Arbitrum Morpho URD pending confirmation — see Base note.
        urd: ethers.ZeroAddress,
        display: "Gauntlet USDC Prime",
        slug: "gauntlet-usdc-prime",
        targetBps: 2000,
        maxBps: 4000,
      },
      // Fluid Lending on Arbitrum. ERC-4626 fToken. ~$48M TVL (verified 2026-05).
      fluid: {
        adapter: "FluidStrategy",
        fluidVault: "0x1A996cb54bb95462040408C06122D45D6Cdb6096", // fUSDC, 6 dec
        // V2.1 (Soken F-04): Arbitrum Fluid distributor address pending confirmation.
        fluidDistributor: ethers.ZeroAddress,
        rewardToken: ethers.ZeroAddress,
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
    // V2.1 (Soken F-04): PancakeSwap V3 SmartRouter (UniV3-fork; same `exactInputSingle`
    // shape). UniswapV3 is not natively deployed on BSC, so PancakeV3 is the canonical
    // alternative for XVS/KINZA → USDC swaps.
    dexRouter: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
    strategies: {
      venus: {
        adapter: "VenusStrategy",
        vUsdc: "0xeca88125a5adbe82614ffc12d0db554e2e2867c8",
        // V2.1 (Soken F-04): Venus Comptroller (Unitroller proxy) + XVS reward token.
        // BSC is the only chain where Venus is incentivized — XVS programs are actively
        // ongoing per the Venus DAO emission schedule.
        comptroller: "0xfD36E2c2a6789Db23113685031d7F16329158384",
        rewardToken: "0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63",
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
        // V2.1 (Soken F-04): Aave V3 on BSC has no active reward emission for USDC supplies
        // at deploy time. Both fields opt-out; re-deploy this strategy with the RewardsController
        // pinned if Aave activates BSC USDC incentives later.
        rewardsController: ethers.ZeroAddress,
        rewardToken: ethers.ZeroAddress,
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
        // V2.1 (Soken F-04): Kinza maintains its own RewardsController (Aave V3 fork) and
        // may emit KINZA tokens periodically. Both pending confirmation — opt-out for the
        // first V2.1 deploy; re-deploy once Kinza's program details are confirmed.
        rewardsController: ethers.ZeroAddress,
        rewardToken: ethers.ZeroAddress,
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
        // V2.1 (Soken F-04): BSC Fluid distributor + reward token pending confirmation.
        // Fluid expanded to BSC after the official 2026-06-30 USDC/USDT reward end date,
        // so even with the distributor pinned the cumulative claim may be zero.
        fluidDistributor: ethers.ZeroAddress,
        rewardToken: ethers.ZeroAddress,
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

/// Adapter-specific constructor argument extractor. Returns the args between
/// `(vaultAddress, assetAddress)` and `strategyVersionHash`, in the order required by each
/// adapter's constructor.
///
/// V2.1 (Soken F-04): every adapter now takes a `dexRouter` argument (last position before
/// `versionHash`). Adapters with protocol-specific reward distributors (Compound/Venus/Aave/
/// Morpho/Fluid) take additional reward-related args before `dexRouter`. Missing optional
/// fields default to `ethers.ZeroAddress` so the strategy deploys cleanly even on chains
/// where rewards are not yet active — `claimAndCompound` no-ops in that state.
///
/// Layout (after vault, asset):
///   AaveV3Strategy:    pool, aUsdc, rewardsController, rewardToken, dexRouter
///   CompoundV3Strategy: comet, cometRewards, dexRouter
///   MorphoStrategy:    metaMorpho, urd, dexRouter
///   VenusStrategy:     vUsdc, comptroller, rewardToken, dexRouter
///   FluidStrategy:     fluidVault, fluidDistributor, rewardToken, dexRouter
export function constructorArgsFor(entry: StrategyEntry, chain: ChainConfig): unknown[] {
  const dexRouter = chain.dexRouter ?? ethers.ZeroAddress;
  switch (entry.adapter) {
    case "AaveV3Strategy":
      return [
        entry.pool,
        entry.aUsdc,
        entry.rewardsController ?? ethers.ZeroAddress,
        entry.rewardToken ?? ethers.ZeroAddress,
        dexRouter,
      ];
    case "CompoundV3Strategy":
      return [entry.comet, entry.cometRewards ?? ethers.ZeroAddress, dexRouter];
    case "MorphoStrategy":
      return [entry.metaMorpho, entry.urd ?? ethers.ZeroAddress, dexRouter];
    case "VenusStrategy":
      return [
        entry.vUsdc,
        entry.comptroller ?? ethers.ZeroAddress,
        entry.rewardToken ?? ethers.ZeroAddress,
        dexRouter,
      ];
    case "FluidStrategy":
      return [
        entry.fluidVault,
        entry.fluidDistributor ?? ethers.ZeroAddress,
        entry.rewardToken ?? ethers.ZeroAddress,
        dexRouter,
      ];
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
