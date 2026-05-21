# Security Policy

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

**Pre-audit.** A formal solo audit is planned post-soft-launch.

The audit commit hash will be tagged as `v1.0.0-soft-launch` (or a subsequent
release tag) and published in the README's Audit section once available.

---

## PGP / Encrypted Communication

If you require encrypted communication, request our PGP public key in your
initial email and we will respond with the current key fingerprint.

---

## Contact

`support@apyee.com`
