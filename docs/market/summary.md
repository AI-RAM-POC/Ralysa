# Market Analysis: Summary and recommendations (synthesis)

> Phase 1 · Owner: market-analyst · Last updated: 2026-09-24
> Synthesis of the four stream files: [competitors.md](competitors.md) (MA-101 to MA-110), [segments-and-sizing.md](segments-and-sizing.md) (MA-201 to MA-212), [regulation.md](regulation.md) (MA-301 to MA-310) and [pricing-benchmarks.md](pricing-benchmarks.md) (MA-401 to MA-411).
> This file introduces no new sourced facts. Every claim rests on an MA-ID; the sources and access dates live in the stream files. New arithmetic is labelled **Estimate**, and inputs without a source are labelled **Assumption**. Regulatory points are market analysis, not legal advice (see the disclaimer in [regulation.md](regulation.md)).

---

## Decision questions

1. **Positioning.** Should Ralysa compete for generic AI assistant seats, or position as the governed department-agent layer that sits alongside Microsoft Copilot and ChatGPT?
2. **Beachhead.** Which country × industry should the Phase 1 pilot target, and which three segments come next?
3. **Pilot department pack** (spec §15 Q5). Technology or Revenue Assurance, or something else?
4. **Launch deployment models.** Which of the spec §9 deployment models (and which model-routing capabilities) must exist before the first regulated contract?
5. **Price architecture and seat model** (spec §15 Q7 and Q8). Which list-price structure, allowance model and seat types should Ralysa launch with?

## Executive summary

- **The gap is widest in Qatar and KSA, and in on-prem deployments.** Global AI workspaces offer in-country processing in the UAE only. No global vendor ships its agent *workspace* on-prem or air-gapped. Gulf sovereign players are infrastructure- and model-first, with few department-ready agent workspaces. (MA-101, MA-102, MA-104)
- **The binding constraint is where the LLM runs, not where Ralysa runs.** Gulf bank regulators require in-country processing plus prior approval. The only in-country frontier inference we found in the Gulf is Azure in UAE North, and Claude on Bedrock in the Middle East routes inference globally. That makes dedicated in-country and on-prem deployment, plus routing to local models by data tier, launch requirements. The spec §14 regional-model risk should be rated High. (MA-301, MA-302, MA-303)
- **MCP and multi-model support are now table stakes. Governance is the differentiator.** Ralysa should lead with identity-scoped MCP (per-group allowlists, approvals, audit), routing by data tier, and an AI system register plus regulator evidence pack. Gulf AI guidance from QCB, CBUAE, DIFC, SDAIA and NCSA asks for exactly these things. (MA-103, MA-202, MA-305)
- **Don't fight for generic chat seats.** Microsoft is winning whole-of-government Copilot deals, and suite-plus-sovereign bundles are forming (Inception42 with Copilot, HUMAIN ONE with Copilot). Ralysa should sell department agents that work *alongside* Copilot. (MA-204, MA-108, MA-209, MA-409)
- **Beachhead: Qatar × Telecom as a lighthouse, not a revenue engine** (about 2,100 seats). The planned sequence after that is Qatar banks (a QCB compliance purchase), then UAE banks (T3 departments first), then KSA telecom, timed to the in-country cloud regions opening in Nov/Dec 2026. The Telecom Edition (RA, Fraud, NOC) is the least-contested pack space. (MA-201, MA-202, MA-105, MA-110)
- **Price the seat at market and put sovereignty in the platform tier.** Seats have settled at about $20/month. Pricing has moved to seat plus pooled, metered usage, with Lite/Core/Power seat weights. A flat unlimited seat loses money on agent users. Sovereignty belongs in a platform-fee tier set by deployment model, not in a per-seat premium. (MA-401, MA-402, MA-403, MA-404, MA-406, MA-407)
- **Reconciled market size (Estimate):** the bank-and-telco SAM is about **$23M/yr**. Including government seats, SAM is about **$111M/yr**. SOM is about **$6.5M ARR by end of year 3** (10 customers). Government is upside only. Bank sales cycles of 9–15 months are the main risk to the SOM timeline. (MA-203, MA-210, MA-307, and the reconciliation notes below)
- **Compliance baseline:** ISO 27001 plus SOC 2 Type II, plus national control mappings (Qatar NIA first). Deploying on customer or partner clouds keeps Ralysa from having to become a licensed cloud provider. Residency rules are still changing, so residency and routing must be declarative policy. (MA-306, MA-307, MA-308)

## Positioning statement (proposed refinement of spec §1.3)

> **Ralysa is the governed agent layer for regulated Gulf enterprises.** It gives every department Claude-Code-grade agents, starting with Technology and a Telecom Edition for Revenue Assurance, Fraud and NOC. The agents run in the customer's own tenancy and country: dedicated in-country cloud, on-prem, or air-gapped. The user's SSO group and the data tier decide which model, tools and data an agent may use. Every MCP call is allow-listed, approval-gated and audited, and T3 data is routed only to in-country or local models. An AI system register and a regulator evidence pack come out of the box. Ralysa works *alongside* the Microsoft Copilot or ChatGPT seats customers already own; it does not replace them for generic chat. The seat is priced like theirs, and sovereignty is priced in the platform tier.

Suggested tagline for §1.3: *"Ralysa — Claude Code for the whole enterprise: department agents governed by your SSO, routed to the model your data tier allows, hosted where your data must stay."* (MA-101, MA-102, MA-103, MA-105, MA-109, MA-204, MA-302, MA-305, MA-401). This follows the §1.5 brand rule: "Copilot" appears only as a competitor name in copy, never in a product name.

## Segments & beachhead

| Segment | Industry | Region | Size | Buyer | Why now | Priority |
|---|---|---|---|---|---|---|
| S1 Qatar Telecom | Telecom | Qatar | 2 operators, ~2,100 addressable seats (Estimate) | CTO/CIO + Head of RA/Fraud + NOC; CISO veto | Qatar has no in-country global AI workspace; Ooredoo sovereign GPU cloud; the Telecom Edition fits directly (MA-101, MA-201, MA-310) | **1 Beachhead (lighthouse)** |
| S2 Qatar Banking | Banking | Qatar | 9 Qatari banks, ~7,200 seats (Estimate) | CIO + CISO + CDO; Compliance | QCB AI Guideline register/approval and QCB Cloud Reg Art. 21.4 in-country processing (MA-202, MA-301) | **2** |
| S3 UAE Banking | Banking | UAE | 24 national banks, ~23,400 seats | CAIO/CDO champion, CISO veto | Most AI-mature buyers, but the most contested. Lead with T3 departments (MA-208, MA-110) | **3** |
| S4 KSA Telecom | Telecom | KSA | 3 MNOs, ~14,900 seats | CTO, CISO, RA/Fraud, NOC | Azure KSA (Nov 2026) and AWS KSA (Dec 2026). HUMAIN bundles squeeze horizontal seats (MA-205, MA-209) | **4** |
| S5 KSA Banking | Banking | KSA | 15 domestic banks | CIO, CISO | SAMA §3.4.3: on-prem/private cloud is the low-friction path (MA-301) | 5 |
| S6 Government | Government | GCC | Largest seat pool (~72% of TAM seats, mostly Estimate) | CIO, CAIO | Microsoft-dominated; needs sovereign cloud or air-gapped (MA-204, MA-303, MA-210) | Upside only; department packs on top of Copilot via partners |

## Market sizing (reconciled, see Reconciliation note R1)

| Level | Value | Calculation | Assumptions (labelled) |
|---|---|---|---|
| TAM | ≈ $348M/yr (segments stream, $360/seat); **not recomputed** | 968k seats × $360 (MA-203) | Kept as an order-of-magnitude figure. The blended net ARPU below ($347/seat/yr) is within 4% of $360, so the TAM stands to within rounding. |
| SAM (bank + telco core) | **≈ $22.6M/yr** (Estimate) | 45,118 seats × $347 + 55 entities × $126.6K | Excludes government (MA-210). **This is the planning figure.** |
| SAM (incl. government seats) | **≈ $111M/yr** (Estimate) | 300,000 seats × $347 + 55 × $126.6K | Government platform fees not estimated (upside). |
| SOM (3 yr) | **≈ $6.5M ARR** (Estimate); ≈ $5.2M at a 40% discount | 15,000 seats × $347 + 10 × $126.6K | 10 customers × 1,500 seats (MA-203 customer mix). Excludes usage/overage margin. |

## Competitor matrix (condensed, full matrix and sources in [competitors.md](competitors.md))

| Vendor | In-country Gulf | On-prem / air-gapped | BYO model | MCP | Dept packs | Arabic/RTL | Pricing | MA |
|---|---|---|---|---|---|---|---|---|
| Microsoft Copilot + Studio | UAE (2026) only | ❌ (disconnected stack excludes Copilot) | ◐ (Anthropic models outside in-country commitment) | ✅ | Broad, no telecom | ✅ | $30 seat + Studio credits | 101, 102, 109 |
| ChatGPT Enterprise | UAE storage + inference | ❌ | ❌ | ✅ | General + Frontier | ◐ | Not published | 101, 107 |
| Claude Enterprise / Code | ❌ (US/global; Bedrock ME is global cross-region) | ❌ | ◐ | ✅ native | No packs | Model ✅, RTL ? | $20 + API usage | 109, 302 |
| Gemini Enterprise | ❌ | Models only (GDC) | ◐ | ✅ governed | Broad | ◐ | $21–50 (stale) | 101, 102 |
| Glean / Dust / Writer | ❌ | ❌ / ❌ / ◐ (stale) | ✅ / ◐ / ◐ | ✅ | Cross-functional | Early access / ? / ? | Glean ≈$99K median/yr; Dust €24/€120 | 102, 106, 405 |
| Core42/Inception42, e&+OI, Humain, stc, Ooredoo, Arabic.AI | ✅ | ✅ (OI, Arabic.AI, Core42 private) | ✅ mostly | Mostly not documented | Humain One (HR/Fin/Proc) and Arabic.AI assistants only | Arabic-first (several) | Not published | 104, 108, 110 |

## Regulation & buying constraints (condensed, detail in [regulation.md](regulation.md))

| Country | Regulator / law | Requirement | Impact on Ralysa | MA |
|---|---|---|---|---|
| Qatar | QCB Cloud Reg Arts. 21.4/21.5; QCB AI Guideline | PII/financial data "processed within Qatar only"; prior QCB approval; AI register | Dedicated/on-prem + local models; register export | 301, 202 |
| Qatar | NCSA classification (C0–C4), NIA | C4 never in cloud; NIA baseline for CII | Air-gapped SKU for C4; NIA mapping before first pilot | 303, 306 |
| UAE | CBUAE Outsourcing + AI Guidance Note (Feb 2026); DIFC Reg 10; Abu Dhabi 100% sovereign cloud | Master records in UAE; non-objection; audit rights and kill-switch; AI register | Kill-switch, register, audit clauses; government only via a sovereign partner | 301, 305, 303 |
| KSA | SAMA CSF §3.4.3 + Outsourcing; NDMO; NCA ECC/CCC; CST classes; PDPL SCCs | Prior approval for public cloud; private cloud out of scope; classification drives location | On-prem/private cloud is the fastest path for banks; ECC/CCC mapping | 301, 303, 304, 306 |
| EU (multinationals) | AI Act + Digital Omnibus | Art. 50 now; Annex III (HR) from 2027-12-02 | Keep HR pack out of the pilot; AI-output labelling | 309 |

**All streams agree on one point:** every beachhead segment accepts dedicated in-country, on-prem and local-model deployment, and none accepts foreign multi-tenant SaaS (MA-301, MA-302, MA-303; deployment-acceptance matrix in [regulation.md](regulation.md#deployment-acceptance-matrix)).

---

## Recommendations

| # | Area | Recommendation | Evidence | Decision owner |
|---|---|---|---|---|
| R-1 | Positioning | Adopt the positioning statement above. Lead with Qatar/KSA sovereignty, T3 governance and Telecom Edition packs. In the UAE, lead with on-prem/T3 rather than residency. Never lead with "MCP" on its own. | MA-101, MA-103, MA-110, MA-204 | Founder / Product owner |
| R-2 | Beachhead + next 3 | **Qatar × Telecom** as the lighthouse pilot, then **Qatar × Banking**, **UAE × Banking** (Fraud, Compliance, Internal Audit first), then **KSA × Telecom** (timed to Azure/AWS KSA going live). Government only as department packs on existing Copilot estates, through a sovereign partner. Depends on warm access to Ooredoo/Vodafone Qatar (open question Q-B1). | MA-201, MA-202, MA-110, MA-209, MA-303 | Founder |
| R-3 | Pilot pack (§15 Q5) | **Technology pack (IT Service Management + Release Management functions) as the Phase 1 pilot pack, landed at a Qatar telco. Revenue Assurance is the committed second pack**, as a read-only "usage vs billing" proof slice on a replica with a local model, shipped with the Data Workspace in Phase 2. Reasons: (a) Technology is T1 (non-prod) under §7.7, so it can use in-region models while RA is T3 and needs local models, and there is no in-country frontier inference in Qatar (MA-302), which would put local-model tool-use quality (§14) on the pilot's critical path; (b) the spec makes the RA pack require the Data Workspace (§6.15.3), which is Phase 2, whereas Technology reuses the Phase 1 Code workspace and DB connectors; (c) the regulation stream points to Technology first (MA-310). But Technology is contested (MA-109, MA-411) and RA carries the differentiation story (MA-105, MA-201), so RA must follow fast. **Alternative:** if the pilot sponsor is the telco's Head of RA, pilot RA instead and pull the Data Workspace and local-model routing into Phase 1. | MA-105, MA-201, MA-302, MA-310, MA-109, MA-411 | Product owner (with pilot customer) |
| R-4 | Launch deployment | **Must-have at launch:** (1) customer-dedicated in-country cloud (Terraform/Helm for Azure Qatar Central/UAE North, Google Doha/Dammam, AWS me-central-1, and one sovereign partner cloud); (2) on-prem Kubernetes with a bundled local-model runtime. **Plan at launch, ship by Y1:** air-gapped (offline licence and updates). **Nice-to-have:** in-region multi-tenant SaaS for non-regulated buyers. **Do not offer** foreign-hosted multi-tenant SaaS to regulated Gulf segments. Lead with customer-operated deployment so Ralysa stays out of the scope of material-outsourcing rules. | MA-301, MA-302, MA-303, MA-304, MA-307 | Tech lead / Product owner |
| R-5 | Must-have launch capabilities | (a) Model Gateway routing by data tier × customer classification (C0–C4 / NDMO) × allowed regions, with non-local calls for T3 blocked by default; (b) Arabic + English PII masking before any non-local call; (c) inference region recorded in every audit record; (d) vLLM/Ollama plus at least one Arabic open or sovereign model; (e) **identity-scoped MCP governance** (per-group allowlists, approvals, audit export); (f) **AI system register + regulator evidence pack** export and a tenant-wide agent kill-switch; (g) pooled usage metering with spend limits; (h) RTL UI and Arabic document handling in the pilot; (i) exit/export bundle. | MA-302, MA-103, MA-202, MA-305, MA-402, MA-407, MA-106 | Product owner / Tech lead |
| R-6 | Partners | One sovereign hosting partner per country (Ooredoo/Syntys in Qatar; SCCC, stc or HUMAIN in KSA; Core42 in the UAE), which can also act as a reseller. Copilot/M365 interop (MCP or agent-to-agent) so Ralysa sits next to Copilot. Evaluate Arabic.AI or JAIS/ALLaM as BYO Arabic models or skills. Treat telcos as hosting partners *and* customers. Leave list-price room for integrator margin (open question Q-B4). | MA-104, MA-108, MA-204, MA-209, MA-212 | Founder |
| R-7 | Pricing stance | Platform fee by deployment tier (Estimate: SaaS $30–60K, dedicated $75–150K, on-prem/air-gapped $150–300K per year) + **named** Lite ($5–8) / Core ($18–25, with about $6 of pooled credit) / Power (about $80–100) seats + Workspace and department-pack add-ons (T3 packs $25–40) + org-pooled credits at $0.01 per credit + overage at list price plus 10–20% + BYOM seat price without the allowance. Annual billing by default, monthly +20%. Consider publishing a "from" price to stand out against the unpublished regional prices. | MA-401 to MA-411, MA-107 | Founder / Product owner |
| R-8 | Seat model (§15 Q8) | Named seats only, in three weights. Pay-per-use for unlicensed users of published agents. **No concurrent/pooled seats**: pool the *usage*, not the seats, because pooled seats conflict with per-user entitlements and audit. | MA-403, MA-404 | Product owner |
| R-9 | Certifications | Start ISO 27001 now (audit booked by launch, certified by Y1). SOC 2 Type I at launch, Type II by Y1. Qatar NIA mapping and a QCB outsourcing-annex template (with a data-location schedule that includes the **model inference location**) before the first Qatar pilot. NCA ECC/CCC and UAE IA mappings by Y1. ISO 42001 in Y1–Y2. Defer CST registration and hosted NIA certification. | MA-306, MA-301, MA-305 | Founder / CISO advisor |

## Proposed changes to the spec / roadmap (proposals only; the spec is not edited)

| Spec section | Current text (summary) | Proposed change | MA evidence |
|---|---|---|---|
| §1.3 Positioning | "Claude Code for the whole enterprise… governed by SSO, hosted where your data must stay" | Refine per the positioning statement: model choice decided by SSO group × data tier; works alongside existing assistants; register/evidence pack | MA-103, MA-204, MA-305 |
| §1.4 Target customers | Regulated Gulf telcos, banks and government; Telecom Edition | Name the beachhead (Qatar × Telecom) and the sequence (R-2). Government only via sovereign partners / on top of Copilot estates | MA-201, MA-204, MA-303 |
| §6.5.3 Model Gateway functions | Policy check incl. residency; size-based routing; metering; budgets | Add routing by tier × classification × region, default-deny non-local for T3, inference region in the audit record, masking before any non-local call | MA-302, MA-303 |
| §6.7 Connectors | M365 pack (Phase 2) as a data connector | Add a "Copilot coexistence" interop story (M365 MCP / agent-to-agent) | MA-108, MA-204 |
| §6.13 / §6.14 Console, audit | Immutable audit log, SIEM export | Add AI system register export, regulator evidence pack, tenant-wide agent stop, explainability logs | MA-202, MA-305 |
| §6.15.2 Catalog | Core mandatory + module subscriptions | Add Lite/Core/Power seat weights, a platform fee per deployment tier, connector packs per org, pay-per-use for unlicensed agent users | MA-403, MA-405, MA-406 |
| §6.15.3 Plan properties | `usage_allowance`: "included tokens or credits per seat" | **Pooled org-level allowance** (optional department pools), no rollover, $0.01 credit unit, org and user spend limits, alert → soft cap → block; BYOM removes the allowance | MA-404, MA-411, MA-402 |
| §7.7 Sensitivity tiers | T1–T3 defaults | Map T1–T3 to Qatar C0–C4 and NDMO levels; C4 / Top Secret → air-gapped only | MA-303 |
| §8 Compliance targets | "ISO 27001, SOC 2 Type II readiness" | Replace "readiness" with the R-9 timeline; add national mappings, ISO 42001, outsourcing annex, EU AI Act Art. 50 labelling | MA-306, MA-309 |
| §9 Deployment models | Four models, no launch priority | Mark Dedicated + On-prem (with local-model runtime) as launch; air-gapped by Y1; in-region multi-tenant SaaS for non-regulated buyers only; no foreign multi-tenant SaaS for regulated Gulf buyers | MA-301, MA-302, MA-304 |
| §13 Phase 1 | Chat + Code; LiteLLM + one local model; 3 DB connectors; subs v1; one pilot pack | **Pull in from Phase 4:** dedicated in-country + on-prem packaging (Helm/Terraform). **Add:** tier-based routing with vLLM + an Arabic open model; register/evidence export + kill-switch; pooled metering + spend limits (budgets are Phase 2 today); RTL UI baseline. Pilot pack = Technology (R-3) | MA-102, MA-301, MA-302, MA-305, MA-407, MA-106 |
| §13 Phase 2 / 3 | Data workspace Phase 2; RA and Fraud in Phase 3 wave 1; NOC in Phase 4 wave 3 | Telecom Edition core (read-only BSS/CDR connectors + RA pack) in **Phase 2** alongside the Data Workspace; Fraud in Phase 3 wave 1; NOC moved up to Phase 3. HR stays later (EU AI Act Annex III, strictest masking) | MA-105, MA-201, MA-309, MA-310 |
| §13 Phase 4 | On-prem/air-gapped packaging, ISO/SOC readiness, Telecom Edition, multi-tenant SaaS | Keep HA, hardened air-gapped build (target Y1), DLP labels, multi-tenant SaaS (in-region). On-prem, ISO/SOC and Telecom Edition move earlier (above) | MA-303, MA-304, MA-306 |
| §14 Regional model availability | Impact **Medium** | Raise to **High**; mitigation = tier routing + local models + vendor verification (Vertex Doha/Dammam, Azure Qatar Central) | MA-302 |
| §14 Crowded market | Mitigation: sovereign/on-prem, governance, packs, telecom | Add: MCP is not a differentiator; coexist with Copilot; watch Qatar/KSA residency catch-up | MA-103, MA-101, MA-204 |
| §14 New rows | — | Suite + sovereign bundles (High); regulator approval cycles (Medium–High); regulatory churn (Medium); seat-price anchoring and token margin (Medium) | MA-108, MA-209, MA-307, MA-308, MA-401, MA-407 |
| §15 Q5 / Q7 / Q8 | Open | Proposed answers: R-3, R-7, R-8 | See rows |
| §15 New | — | Add: does masked PII sent to a foreign model satisfy QCB Art. 21.4 / CBUAE / SAMA? (legal) | MA-302 |

---

## Reconciliation notes

**R1. Price per seat ($360 vs the pricing architecture), with SAM/SOM recomputed.** [segments-and-sizing.md](segments-and-sizing.md) prices every seat at $360/yr (M365 Copilot list). [pricing-benchmarks.md](pricing-benchmarks.md) recommends a platform fee + Core $18–25 + packs + pooled usage. Recomputed below. **All figures are Estimates, using midpoints of the MA-401 to MA-411 ranges.**

*Blended list per seat per month (Assumptions: seat mix 30% Lite / 60% Core / 10% Power; 70% of Core+Power seats attach one department pack; pack mix 60% T2 / 40% T3; Power seats add one workspace):*
- Seats: 0.30 × $6.50 (Lite) + 0.60 × $21.50 (Core) + 0.10 × $90 (Power) = 1.95 + 12.90 + 9.00 = **$23.85**
- Packs: blended pack = 0.6 × $20 (T2 mid) + 0.4 × $32.50 (T3 mid) = $25; attach = 0.70 × 0.70 = 49% of seats → 0.49 × $25 = **$12.25**
- Workspace: 0.10 × $25 (Code/Data mid) = **$2.50**
- List = **$38.60/mo = $463/yr**. Net after a 25% enterprise/partner discount (**Assumption**, between the 20% negotiated savings on Glean and the 15–30% partner margin in MA-405 and pricing open question 7) = **$347/seat/yr (≈ $29/mo)**.

*Platform fee per customer (Assumption: 50% dedicated, midpoint $112.5K; 50% on-prem, midpoint $225K):* list $168.75K, net 25% off = **$126.6K/yr**.

*SAM, bank + telco core:* seats (Qatar + UAE + KSA) = banks 109,995 × 60% = 65,997 plus telcos 40,400 × 60% = 24,240, so 90,237 × 50% governed-agent share = **45,118 seats**. 45,118 × $347 = $15.7M. Platform fees: 55 entities (48 national banks: Qatar 9 + UAE 24 + KSA 15; 7 MNOs) × $126.6K = $7.0M. **Total ≈ $22.6M/yr.** The same seats at $360 would give $16.2M.

*SAM, including government seats:* 300,000 × $347 = $104.2M + $7.0M = **≈ $111M/yr** (vs $108M in MA-203). Government platform fees are not estimated because the entity count is too uncertain (MA-210).

*SOM, year 3:* 10 customers × 1,500 seats = 15,000 × $347 = $5.2M + 10 × $126.6K = $1.3M → **≈ $6.5M ARR**. At a 40% discount: 15,000 × $278 + 10 × $101K = $4.2M + $1.0M = **≈ $5.2M ARR**. Usage/overage margin is excluded in both cases, as in MA-203.

**Which figures this summary uses:** SAM ≈ **$22.6M** (bank + telco) for planning, SAM ≈ $111M as the upside-inclusive headline, and SOM ≈ **$6.5M ARR** (range $5.2M–6.5M). TAM stays at ≈ $348M (MA-203) because the net ARPU is within 4% of $360. The key finding: the pricing architecture barely changes revenue per seat, but it **adds platform-fee revenue (about 20% of SOM)** and protects margin through pooled usage (MA-407).

**R2. Core seat anchor.** MA-203 and the segments recommendations anchor Core at "Copilot parity (~$30)". MA-401 (H confidence, broader and fresher benchmark set) puts it at $18–25. **Resolved in favour of MA-401.** The premium comes from packs and the platform tier. The blended net ARPU (≈ $29/mo) ends up near Copilot parity anyway, so MA-203's revenue logic still holds.

**R3. Pilot pack.** Segments (MA-201) says RA/Fraud/NOC first. Competitors (MA-105) says Telecom Edition + Technology. Regulation (MA-310) says Technology first on T1/T2. **Resolved** as R-3: Technology pilot at a telco, with RA as the committed second pack.

**R4. "In-country hosting removes the blocker" (MA-205) vs "Qatar has no in-country option" (MA-101).** Both are true, at different layers. Qatar has in-country cloud *infrastructure* (Azure Qatar Central, Google Doha), but no in-country global AI *workspace* processing and no in-country frontier *inference* (MA-101, MA-302). This summary uses the MA-302 framing: MA-205 holds for infrastructure, and for AI processing only in the UAE.

**R5. On-prem and air-gapped timing.** MA-102 calls on-prem/air-gapped a "Phase 1 must-have". The regulation stream says on-prem at launch and air-gapped by Y1. **Resolved:** dedicated + on-prem + local model in Phase 1; air-gapped by Y1 (government C4 is not a pilot segment, MA-303).

**R6. HUMAIN.** The competitors stream records HUMAIN ONE on AWS Marketplace (secondary source). The segments stream also records the Microsoft + HUMAIN bundle with a 1M-user target (vendor press release, Aug 2026), which the competitors stream does not list. They don't contradict each other, so both are used (MA-108, MA-209). Prefer the segments stream's primary source for the AWS launch.

**R7. Timeline tensions (flagged, not resolved).** (a) MA-206 targets a pilot live in H1 2027, but R-5 adds scope to Phase 1. The tech lead should re-estimate Phase 1 against that date. (b) The SOM needs about 10 customers by year 3, while bank cycles run 9–15 months (MA-307, Estimate). That means the first bank contracts must be signed in year 1.

**R8. Minor date wording.** UAE Copilot in-country processing is "in 2026" in MA-101 and "early 2026" in MA-205. Both rest on sources more than 6 months old, and neither confirms general availability. Verify before quoting in sales material.

**Stream-file edits:** none. The arithmetic in all four streams was re-checked and found consistent (TAM seats 968k, SAM 300k, tenant token example $13.3K/month).

## Top risks (market view)

| # | Risk | Likelihood / impact | Mitigation | MA |
|---|---|---|---|---|
| 1 | Microsoft or OpenAI add Qatar/KSA in-country processing within 12 months, weakening the residency message for T1/T2 | M / H | Lead on T3, on-prem, governance and packs, not residency alone | MA-101, MA-205 |
| 2 | Suite + sovereign bundles (Inception42 + Copilot, HUMAIN + Copilot, e&/OI with the UAE CSC) are preferred or mandated in government and KSA | H / H | Partner rather than fight; sell department packs on top; lead KSA with telecom | MA-108, MA-209, MA-110 |
| 3 | No in-country Claude path; local models may underperform on agent tool use for T3 packs | H / H | Eval-gate local models per pack; ask Anthropic about a Gulf in-region roadmap; keep the engine swappable | MA-109, MA-302 |
| 4 | Regulator approval steps stretch bank cycles to 9–15 months, putting the SOM timeline at risk | M / H | Customer-operated deployment; ready-made outsourcing annex and evidence pack | MA-307, MA-301 |
| 5 | The beachhead is small (~$0.8M ceiling), so a pilot success may not fund the company | H / M | Plan the Qatar-bank follow-on from day 1 | MA-201 |
| 6 | Price anchoring at $20 and token costs on agent users squeeze margin | M / M | Pooled metered usage, Power seats, routing/caching, BYOM | MA-401, MA-407 |
| 7 | Regulatory churn (UAE PDPL regulations, new UAE AI and Data Authority, NDMO, DIFC Reg 10) | H / M | Declarative per-jurisdiction policy; quarterly regulatory review | MA-308 |
| 8 | If counsel says masked PII still counts as "processing", foreign frontier models are unusable for bank T2 | M / H | Design for local/in-country first; get a legal opinion early (Q-L1) | MA-301, MA-302 |
| 9 | Evidence quality: government sizing is mostly Estimate; many competitor prices are secondary or stale | — | Treat government as upside; re-verify before G2 | MA-210, MA-203, MA-107 |

## Open questions (consolidated, de-duplicated)

**Needs legal counsel** ⚖️
- **Q-L1** Does masked or pseudonymised text sent to a foreign model satisfy QCB Art. 21.4 "processed within Qatar only"? The same question applies to CBUAE confidential data and SAMA. This decides whether foreign frontier models can serve bank T2. (regulation OQ1; MA-302)
- **Q-L2** Is Ralysa software running in the customer's own tenancy "outsourcing" under QCB, SAMA or CBUAE, or is only the model provider the outsourced party? (regulation OQ2; MA-307)
- **Q-L3** What counts as "high-risk" under the QCB AI Guideline, and does an internal productivity agent need prior approval? (regulation OQ4)
- **Q-L4** What is CRA Qatar's current localisation stance for telcos, and are there lawful-intercept or consumer-data limits on CDR data used by the RA/Fraud packs? (regulation OQ8; MA-310)
- **Q-L5** What do Anthropic's commercial terms say about embedding the Agent SDK in a resold product and reselling Claude tokens at a margin? (spec §15 Q4; competitors OQ2; pricing OQ4)
- **Q-L6** Are UAE/KSA government buyers required or steered to use national sovereign platforms? (competitors OQ6; MA-108)
- **Q-L7** Items not yet researched or still pending: NDMO localisation for private-sector Restricted data; UAE PDPL Executive Regulations and the Federal AI and Data Authority; ADGM and Dubai government rules; newer NIA/UAE IA versions; whether partner cloud certifications (CST Class C, NIA) are inherited by Ralysa deployments. (regulation OQ5, 6, 7, 9, 10)

**Vendor verification**
- **Q-V1** Will M365 Copilot in-country processing add Qatar and KSA? Does Anthropic plan Gulf in-region inference? (competitors OQ1, OQ2)
- **Q-V2** Which models support in-region processing on Vertex Doha/Dammam, and what is the Azure Qatar Central model roadmap? (regulation OQ3)
- **Q-V3** Can the Gemini Enterprise *app* run on GDC air-gapped? Is Writer's self-hosted option still offered? (competitors OQ3, OQ7)
- **Q-V4** How deep are MCP, BYO-model and governance support in Humain One, Core42 and OI? What are the real prices for ChatGPT Enterprise, Glean, Writer and the regional players? (competitors OQ4, OQ5; pricing OQ6)

**Buyer / pilot validation**
- **Q-B1** Is the founding team Qatar-based, with warm access to Ooredoo or Vodafone Qatar? Who is the pilot customer and sponsor (CIO vs Head of RA)? This decides R-2 and R-3. (segments OQ1; spec §15 Q5)
- **Q-B2** Will Gulf procurement accept a platform fee plus seats, or does it expect one all-in seat price? Is ~$20–29 per seat acceptable next to Copilot? (pricing OQ1; segments OQ5)
- **Q-B3** What are real token use and cache-hit ratios? Instrument the pilot before fixing allowance sizes. (pricing OQ2)
- **Q-B4** Enter KSA through partners or direct, and how much partner margin (15–30%) to leave? (segments OQ7; pricing OQ7)
- **Q-B5** Price in USD or local currency, with or without VAT? What are the sovereign GPU prices from Ooredoo, stc and HUMAIN? (pricing OQ3, OQ5)
- **Q-B6** Is the 9–15 month bank sales cycle realistic? Validate against pipeline data. (regulation sales-cycle Estimate; MA-307)

**Data gaps**
- **Q-D1** Sourced government civil-service headcounts; domestic telco and small-market bank headcounts; UAE/KSA bank counts from the CBUAE and SAMA registers. (segments OQ2–OQ4; MA-210)
- **Q-D2** Set up tender monitoring (Etimad, Monaqasat, UAE portals). (segments OQ6; MA-212)
- **Q-D3** Re-check sources older than 6 months: IDC, Gartner, Argaam, GASTAT, QCB guideline status, Gemini prices, the Microsoft in-country list. (segments OQ8; competitors matrix)

## Insights index

| ID | One-line title | File | Confidence |
|---|---|---|---|
| MA-101 | Global AI workspaces offer in-country processing in the UAE only; not in Qatar, and not yet in KSA | [competitors.md](competitors.md#insights) | H |
| MA-102 | No global vendor ships its agent workspace on-prem or air-gapped | [competitors.md](competitors.md#insights) | H |
| MA-103 | MCP and multi-model are table stakes; lead with identity-scoped MCP | [competitors.md](competitors.md#insights) | H |
| MA-104 | Gulf sovereign players are infrastructure/model-first; partner with them | [competitors.md](competitors.md#insights) | M |
| MA-105 | No competitor publishes telecom department packs | [competitors.md](competitors.md#insights) | M |
| MA-106 | Arabic model quality is good; the workspace/RTL layer lags | [competitors.md](competitors.md#insights) | M |
| MA-107 | Pricing converges on a low seat fee plus metered usage | [competitors.md](competitors.md#insights) | M |
| MA-108 | Suite + sovereign partnerships are forming | [competitors.md](competitors.md#insights) | M |
| MA-109 | Anthropic is both Ralysa's engine and a competitor | [competitors.md](competitors.md#insights) | H |
| MA-110 | e&/OI (UAE government) and Humain One (KSA) are the closest substitutes | [competitors.md](competitors.md#insights) | M |
| MA-201 | Qatar × Telecom is the best beachhead, with a ~$0.76M ARR ceiling | [segments-and-sizing.md](segments-and-sizing.md#insights) | M |
| MA-202 | The QCB AI Guideline turns governance into a compliance purchase | [segments-and-sizing.md](segments-and-sizing.md#insights) | H |
| MA-203 | TAM ≈ $348M, SAM ≈ $108M, SOM ≈ $5.4M at $360/seat (superseded for SAM/SOM by R1) | [segments-and-sizing.md](segments-and-sizing.md#insights) | M / L |
| MA-204 | Microsoft is taking whole-of-government productivity seats | [segments-and-sizing.md](segments-and-sizing.md#insights) | H |
| MA-205 | In-country hyperscaler regions go live 2025–Dec 2026 (see R4) | [segments-and-sizing.md](segments-and-sizing.md#insights) | H |
| MA-206 | Capital and policy push peaks in 2026; target a pilot in H1 2027 | [segments-and-sizing.md](segments-and-sizing.md#insights) | M |
| MA-207 | 84% of GCC firms use AI, 31% have scaled; cybersecurity/privacy are the top concerns | [segments-and-sizing.md](segments-and-sizing.md#insights) | M |
| MA-208 | CAIO/CDO is a formal buyer; CISO holds the veto | [segments-and-sizing.md](segments-and-sizing.md#insights) | M |
| MA-209 | The HUMAIN + Microsoft bundle compresses KSA horizontal seat pricing | [segments-and-sizing.md](segments-and-sizing.md#insights) | M |
| MA-210 | Government is ~72% of TAM seats but mostly estimated | [segments-and-sizing.md](segments-and-sizing.md#insights) | H / L |
| MA-211 | UAE and Qatar have above-average Claude usage; KSA, Kuwait and Oman are at or below average | [segments-and-sizing.md](segments-and-sizing.md#insights) | M |
| MA-212 | No public GCC agent-workspace tender found; buying runs through partnerships | [segments-and-sizing.md](segments-and-sizing.md#insights) | L |
| MA-301 | Gulf central banks require in-country handling and prior approval | [regulation.md](regulation.md#insights) | H |
| MA-302 | LLM inference location is the binding constraint; raise the §14 risk to High | [regulation.md](regulation.md#insights) | H / M |
| MA-303 | Government needs sovereign cloud or on-prem; top classification tiers need air-gapped | [regulation.md](regulation.md#insights) | M–H |
| MA-304 | General privacy laws allow cross-border transfer with safeguards | [regulation.md](regulation.md#insights) | M |
| MA-305 | AI guidance converges on register, oversight, audit and a kill-switch | [regulation.md](regulation.md#insights) | H |
| MA-306 | ISO 27001 + SOC 2 II + national mappings; avoid becoming a CSP | [regulation.md](regulation.md#insights) | M |
| MA-307 | Regulator approval steps add months to bank deals | [regulation.md](regulation.md#insights) | M |
| MA-308 | Residency rules are moving; policy must be declarative | [regulation.md](regulation.md#insights) | M |
| MA-309 | The EU AI Act reaches Ralysa mainly via the HR pack and Art. 50 | [regulation.md](regulation.md#insights) | M |
| MA-310 | Telcos are the most flexible regulated beachhead | [regulation.md](regulation.md#insights) | L–M |
| MA-401 | Horizontal AI seats have settled at ~$20/user/month | [pricing-benchmarks.md](pricing-benchmarks.md#insights) | H |
| MA-402 | The market has moved to hybrid seat + metered usage | [pricing-benchmarks.md](pricing-benchmarks.md#insights) | H |
| MA-403 | Standard/premium seat tiers at ~1x/5x are standard | [pricing-benchmarks.md](pricing-benchmarks.md#insights) | H |
| MA-404 | Included usage is pooled at org level, no rollover | [pricing-benchmarks.md](pricing-benchmarks.md#insights) | H |
| MA-405 | Governance platforms land $60K–110K/yr entry contracts, unpublished | [pricing-benchmarks.md](pricing-benchmarks.md#insights) | M |
| MA-406 | Residency is priced at ~+10% on tokens; nobody publishes on-prem pricing | [pricing-benchmarks.md](pricing-benchmarks.md#insights) | M |
| MA-407 | Agent use makes flat seats unprofitable (token-cost Estimate) | [pricing-benchmarks.md](pricing-benchmarks.md#insights) | M |
| MA-408 | Open-weight models cost ~10–15x less; local T3 inference is cost-competitive | [pricing-benchmarks.md](pricing-benchmarks.md#insights) | M |
| MA-409 | Incumbents bundle AI into suites; Agent 365 at $15 is a governance anchor | [pricing-benchmarks.md](pricing-benchmarks.md#insights) | M |
| MA-410 | Monthly billing costs 16–25% more than annual | [pricing-benchmarks.md](pricing-benchmarks.md#insights) | H |
| MA-411 | Developer seats run $19–40 with pooled credits at $0.01 | [pricing-benchmarks.md](pricing-benchmarks.md#insights) | H |

## Approval (G1)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner | Approved | 2026-09-25 | Approval given in chat; recorded by Claude on the approver's instruction. |
