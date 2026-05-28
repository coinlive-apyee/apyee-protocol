# Contributing to Apyee Protocol

Thanks for your interest in Apyee. This document describes how we work with
contributors and what to expect.

## What we accept

This repository is a **public mirror** of Apyee's smart-contract source. The
contracts are **immutable** (no upgradeable proxy) — any logic change requires
a new major version and a fresh deployment, not a patch to the existing one.

Because of that, we are selective about what gets merged.

### We welcome

- **Issues**: bug reports (non-security), documentation gaps, build/test
  problems, integration questions.
- **Pull requests** that fix typos, improve documentation, fix non-code tooling
  issues (`hardhat.config.ts`, `package.json` scripts, lint rules), or improve
  test coverage without changing contract behavior.
- **Forks**: see [LICENSE](LICENSE) (BUSL-1.1) for usage terms.

### We do NOT accept via public PR

- **Contract logic changes**. These need to go through a `v2.0.0`-style
  redeploy process and require an audit. If you have an idea, open a
  discussion or [submit a security report](SECURITY.md) if it's
  vulnerability-driven.
- **Security vulnerabilities**. See [SECURITY.md](SECURITY.md) — please report
  privately to `support@apyee.com`.
- **Strategy adapter additions**. New strategies are added by the Owner
  (Multi-sig) on the deployed Vault. If you maintain a yield protocol and want
  Apyee to integrate, reach out via `support@apyee.com`.

## Before you open a PR

1. **Search existing issues** to see if your concern is already tracked.
2. **For non-trivial changes**, open an issue first to discuss approach.
3. **Verify the change keeps tests passing**:
   ```bash
   npm run compile
   npm run test:unit
   npm run test:invariant
   ```
4. **For contract code touched** (rare — see above): also include
   `npm run test:fork` results.
5. Sign off your commits — by submitting a PR you agree to the terms of the
   Developer Certificate of Origin (DCO).

## Style

- Solidity: pragma `^0.8.28`, OpenZeppelin Contracts v5.x, custom errors over
  `require(string)`.
- TypeScript: passes `npm run lint` and `npm run format:check`.
- Commit messages: Conventional Commits (`feat(vault): ...`, `fix(strategy): ...`,
  `docs: ...`, `chore: ...`, `test: ...`).
- **Do not** include AI-tool co-author trailers in commit messages.

## Disclosure & licensing

- The Solidity source in `contracts/` is governed by
  [BUSL-1.1](LICENSE). The Change Date and conversion clauses are described in
  the LICENSE file.
- Contributions are accepted under the same license. By submitting a PR you
  certify that you have the right to license the contribution under BUSL-1.1
  to the project.

## Code of Conduct

By participating in this project you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Contact

- Security issues → `support@apyee.com` (private)
- General questions → open a GitHub issue
- Business / integration inquiries → `support@apyee.com`
