# Security Policy

**Website**: <https://apyee.com> &nbsp;·&nbsp; **Repository**: <https://github.com/coinlive-apyee/apyee-protocol>

## Reporting a Vulnerability

If you discover a security vulnerability in Apyee Protocol, please report it
privately via:

- **Email**: support@apyee.com

**Do NOT** open a public GitHub issue for security bugs.

We aim to acknowledge receipt within **48 hours** and provide a status update
within **7 days**.

---

## Scope

### In scope

- `contracts/Vault.sol`
- `contracts/strategies/*.sol`
- `contracts/libraries/Errors.sol`
- `contracts/interfaces/IStrategy.sol`

### Out of scope

- Third-party protocol vulnerabilities (Aave, Compound, Morpho, Venus, Fluid).
  Please report those directly to the respective protocol teams.
- Frontend, backend, or keeper bot applications (separate repositories).
- Issues in upstream dependencies (OpenZeppelin, etc.) unless triggered by our
  specific integration.
- Issues that require compromising the deployer key, Multi-sig signer keys,
  Keeper EOA private key, or Guardian EOA private key.
- Gas optimizations without a clear security impact.

---

## Disclosure Policy

We follow **responsible (coordinated) disclosure**:

1. Reporter contacts us privately via `support@apyee.com`.
2. We confirm receipt within 48 hours.
3. We work on a fix and coordinate disclosure timing with the reporter.
4. After the fix is deployed, we publish a security advisory crediting the
   reporter (if desired).

Please do not publicly disclose the vulnerability until we have had a
reasonable opportunity to investigate and respond.

---

## Bug Bounty

A formal bug bounty program will be announced **after the first external audit
completes**. For pre-audit reports, rewards are at our discretion based on
severity, impact, and quality of the report.

Severity classification follows the
[Immunefi Vulnerability Severity Classification System v2.3](https://immunefi.com/immunefi-vulnerability-severity-classification-system-v2-3/).

---

## Audit Status

**V2.1 remediation in progress (as of 2026-06-25).** Soken completed the V2 solo
audit and the remediation lives on the `feat/v2.1` branch pending a remediation
review.

| Stage | Target | Status |
|---|---|---|
| Internal review + mainnet fork testing | Pre-launch | Complete (2026-05/06) |
| **Solo audit (Soken) — V2** | Post-V2 Soft Launch | **Complete (2026-06-23, report APY-2026-06-001)** |
| **V2.1 remediation (16 findings → fixes)** | Post-audit | **In review — `feat/v2.1` PR** |
| Soken remediation review | Post-fix | Scheduled |
| Contest audit (Code4rena / Cantina / Sherlock) | Post-V2.1 deploy | Planned |
| Bug bounty program | Post-V2.1 / post-contest | Planned |

V2 generation tags:
- [`v2.0.0`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.0.0) — the audited V2 source (Soken APY-2026-06-001)
- `v2.1.0` (forthcoming) — Soken remediation. See [`docs/SOKEN_AUDIT.md`](docs/SOKEN_AUDIT.md) for finding → fix mapping
- [`v1.0.0`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v1.0.0) — V1 sources, on-chain but not part of the V2 audit deliverable

Soken findings summary (full mapping in [`docs/SOKEN_AUDIT.md`](docs/SOKEN_AUDIT.md)):
- **1 Critical** (F-17) — permanent vault brick via stale `lastSharePrice` once
  `totalSupply()` returned to zero. **Fixed in V2.1** by resetting the baseline.
- **2 Medium** (F-01 accrual hook ordering, F-02 strategy duplicate on re-add).
  Both fixed.
- **4 Low** (F-03 fee over-charge, F-04 reward tokens uncollected, F-06 single-step
  Ownable, F-07 unbounded `strategyList`). All fixed.
- **9 Informational** — 5 with code changes (F-05 quarantine, F-15 unused errors,
  trust-model phrasing F-16, etc.), 4 acknowledged as documented design tradeoffs.

V2.0 contracts remain on-chain (immutable). V2.0 holders will be invited to
migrate to V2.1 once the remediation review completes; V2.0 → V2.1 migration is
voluntary (mirrors V1 → V2). The current V2.0 `setDepositCap` was intentionally
set conservatively (`$500K`/chain Soft Launch, `$10K`/user Free tier) and remains
Owner-adjustable until the migration window closes.

---

## Known Limitations (V2)

Honest pre-audit disclosure. None of the items below affect on-chain
behavior, user funds, or the Vault's security invariants — they are
operational or tooling-side observations the audit firm should be aware
of so reports can categorise findings cleanly.

### Etherscan "Similar Match" — `SOURCE_TAG` mechanism inoperative

The five V2-prod Vaults all share the same on-chain bytecode-level
`SOURCE_TAG` value (the placeholder string `"__SOURCE_TAG__"`). The
intended sed-replace mechanism (see `scripts/utils/source-tag.ts`) was not
applied during the production deployment, so each (chain × tier) Vault
has identical metadata trailers instead of distinct ones.

- **Security impact**: none. `SOURCE_TAG` is an `external constant string`
  with no role in fee math, access control, asset movement, or any
  invariant. Vault behavior is unchanged.
- **Visible effect**: Etherscan's "Similar Match" UI flag may surface
  cross-Vault similarity that we had intended to suppress. All five
  Vaults are nevertheless **Exact-Match verified** with their respective
  source on each chain explorer.
- **Status**: filed as a tooling bug; will be addressed in a future
  deploy-script update. Does not require any contract change.

### V1 → V2 user migration is voluntary

V1 vaults remain on-chain (immutable) and any V1 holders must withdraw
from V1 and redeposit into V2 themselves. The V2 contracts contain no
migration helpers — `Vault.sol` interacts with V1 only through the
public ERC-4626 `redeem` / `deposit` surface from the user's wallet.
Migration tooling (`scripts/ops/migrate-parking.ts` in our private
operations repo) is out of audit scope.

---

## PGP / Encrypted Communication

If you require encrypted communication, request our PGP public key in your
initial email and we will respond with the current key fingerprint.

---

## Contact

`support@apyee.com`
