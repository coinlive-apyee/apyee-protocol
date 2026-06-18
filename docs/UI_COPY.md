# UI Copy — Soft Launch Phase

> Reference copy for the Apyee frontend during the V2 Soft Launch phase.
> Goal: be specific and verifiable, not vague. Avoid the word "audited"
> until an external firm completes a review (see also
> [SECURITY.md](../SECURITY.md) → Known Limitations).
>
> Frontend repo is separate. This document is the contract-side copy
> reference so the marketing/UX copy aligns with what the contracts
> actually do.

---

## Status badge (header / footer)

```
Soft Launch · V2 (2026-06)
```

Avoid:
- "Beta" (ambiguous — implies "may break" rather than "fund safety policy")
- "Audited" / "Security-reviewed" (no external firm has reviewed V2 yet)

Use:
- "Soft Launch" — DeFi-standard term for "in production with conservative caps before external audit"
- "V2" — clearly distinguishes from V1 (which is also still on-chain)

---

## Hero / landing section

```
Multi-strategy USDC yield, four chains, one Vault interface.

Strategy adapters battle-tested in V1 — two months on Ethereum, Base,
Arbitrum, BNB Chain with zero security incidents.

V2 adds a streaming performance fee and tier-based allocation caps.
Deposit caps are intentionally conservative during Soft Launch — see
the Trust Model for what the operator can and cannot do.
```

Linked CTAs:
- "Trust model" → `/security/trust-model` (or external GitHub link to `docs/TRUST_MODEL.md`)
- "V2 design" → `/security/design` (or `docs/V2_DESIGN.md`)
- "Contract addresses" → `/contracts` (or `deployments/v2-prod/`)

---

## Deposit page — pre-deposit disclosure box

Display this above the "Approve" / "Deposit" buttons:

```
Soft Launch caps

Per-chain Vault cap:    $500,000
Per-user deposit cap:   $10,000
Withdrawals:            Always open, including during pause()
Performance fee:        15% of yield (streaming, no extra fee on principal)

What this means

• Strategy adapters (Aave, Compound, Morpho, Venus, Fluid) ran in V1
  for two months on these chains without incident — same code in V2.
• The Vault contract itself has new streaming-fee logic. We've done
  extensive internal testing (78 spec tests + invariants) but no
  external audit has been completed yet.
• You can withdraw at any time. The operator cannot move your funds
  to an arbitrary address — verify in our Trust Model document.
• Bug bounty is in preparation. External audit is planned post-Soft-Launch.
```

Linked CTAs:
- "Trust Model" → `docs/TRUST_MODEL.md`
- "Withdraw is always open" → Vault.sol line 546 (`function withdraw`) and `pause()` invariant test
- "What is streaming fee?" → `docs/V2_DESIGN.md` §3

---

## Security tab / page

```
Security & verification

Multi-sig owner
  Gnosis Safe — 0xEC4d3B6a39D61B85dF61cCb35CE693517992A98e
  (same address on all 4 chains)
  Verify: app.safe.global

Contract source
  Verified Exact-Match on Etherscan / Basescan / Arbiscan / BSCscan
  Tag: v2.0.0 — github.com/coinlive-apyee/apyee-protocol/releases/tag/v2.0.0

What the operator CAN do
  • Add / remove strategies (whitelist only)
  • Adjust fee rate (capped at 20% hard ceiling)
  • Adjust deposit / per-user caps
  • Replace Keeper / Guardian / Treasury addresses
  • Pause and unpause (does NOT block withdrawals)

What the operator CANNOT do
  • Move user funds to an arbitrary address (no such function)
  • Raise the 20% fee ceiling
  • Block your withdrawal — `withdraw()` works even while paused
  • Mint shares outside the streaming-fee math

Full line-by-line list: Trust Model document

Security tools used (in preparation)
  ☐ Slither static analysis    (pre-audit checks)
  ☐ Mythril static analysis    (pre-audit checks)
  ☐ Foundry fuzz harness        (precision testing of _accrue)
  ☐ Immunefi bug bounty        (will go live before TVL $100K)

External audit
  Status: Planned post-Soft-Launch
  Conservative caps remain in effect until audit completion.
```

When each of the four checkboxes lands (results published in the public
repo), flip ☐ → ✅ with a link to the result file.

---

## "Why we're not yet labelled 'Audited'" — FAQ block

```
Why doesn't Apyee say "Audited" yet?

We launched V2 on 2026-06. External audit firms typically take 4-6 weeks
and cost $50K-150K. We're running Soft Launch with conservative caps
(see above) until the external audit completes, which is honest about
where we stand.

Strategy adapters in V2 are identical to V1, which has been in
production on 4 chains for 2 months without security incident. The new
code in V2 is the streaming-fee math and the tier-parameterized cap —
that's what the external audit will focus on.

While we wait, you can verify directly:
  • All contracts Exact-Match verified on chain explorers
  • Multi-sig is the only owner — verifiable on app.safe.global
  • Source code is open: github.com/coinlive-apyee/apyee-protocol
  • Trust Model document enumerates every privileged function
```

---

## Footer disclosure (every page)

```
Apyee Protocol is in Soft Launch (V2, 2026-06). Conservative deposit
caps apply. External audit is pending. Use at your own risk —
read the Security tab before depositing.
```

---

## Email / Twitter announcement copy (template)

### Twitter — V2 launch
```
Apyee V2 is live on Ethereum, Base, Arbitrum, BNB Chain.

What's new
• Streaming performance fee — no Keeper harvest call needed
• Tier-based allocation cap (Balanced / Aggressive)
• Same strategy adapters as V1 — 2 months battle-tested

Soft Launch caps: $500K/chain, $10K/user.
External audit pending. Bug bounty in preparation.

Trust model: github.com/coinlive-apyee/apyee-protocol/blob/main/docs/TRUST_MODEL.md
```

### Email — to existing V1 users
```
Subject: Apyee V2 is live — voluntary migration available

Hi,

V2 of the Apyee Vault is now live on the same 4 chains. The strategy
adapters are identical to V1 — same code, same protocols, same audit
surface that's been running for 2 months.

What's new in V2 is the Vault contract itself: a streaming performance
fee model (no Keeper harvest cycle) and tier-based allocation caps.

Migration is voluntary. V1 Vaults remain open for withdrawal forever.
To move, withdraw from V1 then deposit into the V2 tier of your choice.

Soft Launch caps apply: $500K/chain, $10K/user. External audit is
pending — V1 strategy adapter code is unchanged from the 2-month-tested
V1 deployment.

Trust Model: [link]
V2 Design: [link]
Contract addresses: [link]

— Apyee team
```

---

## Things NOT to write

| Don't write | Why |
|---|---|
| "Audited" | No external firm has completed a review |
| "Audited by Blockwave Capital" | See `SECURITY.md` — affiliated-party self-audit cannot be marketed as third-party |
| "Battle-tested V2" | V2's Vault contract is new code; only the strategy adapters are battle-tested. Be specific about which layer. |
| "Bug bounty active" | Until Immunefi page is live with a funded pool, this is misrepresentation. Use "Bug bounty in preparation" until then. |
| "Insured" / "Risk-free" | No insurance is in place. DeFi is not risk-free, and conservative caps are the only on-chain risk control. |
| "Pre-audit security checks complete" | OK to use **only after** Slither + Mythril results are public in the repo. Until then, "Pre-audit security checks in preparation". |
