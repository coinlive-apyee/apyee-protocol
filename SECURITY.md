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
- `contracts/access/*.sol`

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

**Pre-audit (as of 2026-05-28).** The Soft Launch deployment is tagged
[`v1.0.0`](https://github.com/coinlive-apyee/apyee-protocol/releases/tag/v1.0.0).

Audit timeline:

| Stage | Target | Status |
|---|---|---|
| Internal review + mainnet fork testing | Pre-launch | Complete (2026-05) |
| Solo audit (single firm) | Post-Soft Launch | Planned for 2026 Q3 |
| Contest audit (Code4rena / Cantina / Sherlock) | Post-Solo | Planned for 2026 Q4 |
| Bug bounty program | Post-Solo audit | Planned |

Deposit caps during pre-audit operation are intentionally conservative
(`$500K`/chain Soft Launch, `$10K`/user Free tier) and Owner-tightenable at any
time via `setDepositCap` / `setDefaultUserCap` Multi-sig calls. The audit
commit hash will be published in this section once the engagement begins.

---

## PGP / Encrypted Communication

If you require encrypted communication, request our PGP public key in your
initial email and we will respond with the current key fingerprint.

---

## Contact

`support@apyee.com`
