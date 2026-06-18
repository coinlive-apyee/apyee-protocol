import * as fs from "fs";
import * as path from "path";

/// Source tag helper — patches `__SOURCE_TAG__` placeholder in `contracts/v2/Vault.sol`
/// with the generation × tier value, runs the user-provided `action()`, then restores the
/// original file in a `try / finally` block (even on error / interrupt).
///
/// Why: Etherscan Similar Match aligns by bytecode metadata trailer (= source IPFS hash).
/// `immutable` constructor args are NOT in the comparison; only source code is. A unique
/// string literal per generation × tier makes the metadata hash divergent — Similar Match
/// is suppressed across our 6-vault matrix (V2_VAULT.md §4.4).
///
/// Caller flow (typical, inside 01-deploy-vault.ts):
///   await withSourceTag(generation, tier, async () => {
///     await hre.run("compile", { force: true });        // re-compile patched source
///     // ... deploy + verify ...
///   });
/// The restore in `finally` keeps the git working tree clean even on crash.

const VAULT_PATH = path.join(__dirname, "..", "..", "contracts", "v2", "Vault.sol");
const PLACEHOLDER = "__SOURCE_TAG__";

/// Compute the literal value that the placeholder will be replaced with.
/// Generation is expected to be `v2-dev` or `v2-prod` (caller validates).
export function sourceTagValue(generation: string, tier: string): string {
  if (!generation.startsWith("v2-")) {
    throw new Error(
      `SOURCE_TAG only supports v2 generations (got "${generation}").`,
    );
  }
  return `${generation}-${tier}`;
}

/// Patch the placeholder, run `action`, then ALWAYS restore the original source.
/// If `Vault.sol` no longer contains the placeholder (e.g. a previous run crashed
/// without finally), we abort instead of silently producing the wrong tag.
export async function withSourceTag<T>(
  generation: string,
  tier: string,
  action: () => Promise<T>,
): Promise<T> {
  const tag = sourceTagValue(generation, tier);
  const original = fs.readFileSync(VAULT_PATH, "utf8");
  if (!original.includes(PLACEHOLDER)) {
    throw new Error(
      `SOURCE_TAG placeholder "${PLACEHOLDER}" not found in ${VAULT_PATH}. ` +
        `Either: (a) the file was modified manually, or (b) a previous deploy crashed without restoring. ` +
        `Reset Vault.sol from git (git checkout contracts/v2/Vault.sol) and re-run.`,
    );
  }
  const patched = original.replace(PLACEHOLDER, tag);
  fs.writeFileSync(VAULT_PATH, patched);
  try {
    return await action();
  } finally {
    fs.writeFileSync(VAULT_PATH, original);
  }
}
