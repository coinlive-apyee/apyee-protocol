import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

const {
  DEPLOYER_PRIVATE_KEY,
  ALCHEMY_API_KEY,
  NODEREAL_BNB_URL,
  ETHERSCAN_API_KEY,
  MAINNET_FORK_BLOCK,
  REPORT_GAS,
  FORK,
  FORK_CHAIN,
} = process.env;

const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/// Fork target selector. FORK_CHAIN=ethereum (default) | base | arbitrum | bsc.
/// Used by both fork-test suites and localhost dry-runs (in concert with DRY_RUN_FORK_TARGET
/// in 00-config.ts, which falls through to FORK_CHAIN when not explicitly set).
function resolveForkConfig() {
  if (FORK !== "true") return undefined;
  if (FORK_CHAIN === "bsc") {
    return { url: NODEREAL_BNB_URL || "https://bsc-dataseed.binance.org" };
  }
  if (FORK_CHAIN === "base") {
    if (!ALCHEMY_API_KEY) return undefined;
    return { url: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` };
  }
  if (FORK_CHAIN === "arbitrum") {
    if (!ALCHEMY_API_KEY) return undefined;
    return { url: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` };
  }
  if (!ALCHEMY_API_KEY) return undefined;
  return {
    url: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    blockNumber: MAINNET_FORK_BLOCK ? Number(MAINNET_FORK_BLOCK) : undefined,
  };
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: false,
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      forking: resolveForkConfig(),
      // Hardhat needs a hardfork activation history for non-Ethereum forks.
      // BSC / Base / Arbitrum reached Shanghai-equivalent feature parity well before block 0;
      // using shanghai across the entire history avoids "No known hardfork" errors on recent
      // fork blocks. Ethereum forks (chain id 1) keep the built-in default history (Cancun).
      chains: {
        56: { hardforkHistory: { shanghai: 0 } }, // BNB Chain
        8453: { hardforkHistory: { shanghai: 0 } }, // Base
        42161: { hardforkHistory: { shanghai: 0 } }, // Arbitrum One
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      accounts,
    },

    // --- Testnets ---
    sepolia: {
      url: ALCHEMY_API_KEY
        ? `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
        : "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts,
    },
    baseSepolia: {
      url: "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    arbitrumSepolia: {
      url: "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts,
    },
    bscTestnet: {
      url: "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts,
    },

    // --- Mainnets (Phase 1) ---
    // These URLs are used by deploy/verify scripts only — Keeper bot + frontend live in
    // separate repos with their own RPC config. Swap providers freely (e.g. move all four
    // to Alchemy paid tier later) without affecting contract behavior.
    mainnet: {
      // Alchemy Ethereum endpoint returns `to: ""` (not null) for CREATE tx responses,
      // which ethers v6.16 rejects with "invalid value for value.to". publicnode returns
      // proper `to: null` and worked first try for Beta deploy. Alchemy still used for
      // fork tests via resolveForkConfig (fork RPC doesn't go through this path).
      url: "https://ethereum-rpc.publicnode.com",
      chainId: 1,
      accounts,
    },
    base: {
      // Official public RPC. Returned `to: null` correctly during Beta deploy. If switched
      // to Alchemy later, watch for the same `to: ""` issue as Ethereum.
      url: "https://mainnet.base.org",
      chainId: 8453,
      accounts,
    },
    arbitrum: {
      // Official public RPC. Same notes as Base.
      url: "https://arb1.arbitrum.io/rpc",
      chainId: 42161,
      accounts,
    },
    bsc: {
      // NodeReal (paid free tier) — Alchemy doesn't support BSC. Public RPC fallback used
      // when NODEREAL_BNB_URL is empty.
      url: NODEREAL_BNB_URL || "https://bsc-dataseed.binance.org",
      chainId: 56,
      accounts,
    },
  },
  etherscan: {
    // Etherscan V2 unified API (single key works across all supported chains by chainid).
    // hardhat-verify v2 routes to the V2 endpoint only when `apiKey` is a single string;
    // the per-chain object form falls back to deprecated V1 endpoints (sunset May 31, 2025).
    // We standardize on ETHERSCAN_API_KEY since the V2 free tier covers ETH/Base/Arbitrum/BSC.
    apiKey: ETHERSCAN_API_KEY ?? "",
  },
  gasReporter: {
    enabled: REPORT_GAS === "true",
    currency: "USD",
    excludeContracts: ["mocks/"],
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
