# Market Analysis: Pricing and packaging benchmarks

> Phase 1 · Owner: market-analyst · Last updated: 2026-09-24
> Stream: pricing and packaging benchmarks. Feeds spec §6.15 (Subscriptions & Licensing) and §15 open questions 7 (pricing per subscription) and 8 (seat model).
> Insight block: MA-401 to MA-411.

## Decision questions

1. What price architecture should Ralysa launch with: seat-only, usage-only, or a hybrid of platform fee, seats and metered usage?
2. What seat model should Ralysa use (spec §15 Q8): named seats only, or also pooled or concurrent seats for occasional users?
3. How much model usage can Ralysa include in a seat before gross margin is at risk, and how should overage, BYO-model and sovereign or on-prem deployment be priced?

## Executive summary

- **Horizontal AI assistant seats now cost about $20 per user per month on annual terms.** Claude Enterprise is $20, ChatGPT Business $20, Gemini Enterprise Business from $21, and Microsoft 365 Copilot Business $21 (on promotion at $18). Microsoft 365 Copilot for enterprises stays at $30. A Ralysa Core seat priced far above this band needs a governance or sovereignty reason the buyer can see (MA-401).
- **The market has moved to hybrid pricing: a seat price plus metered usage.** Claude Enterprise now charges a $20 seat plus usage at API rates. GitHub Copilot, Copilot Studio, Dust and Gemini Enterprise all meter usage through credits or quotas. The spec's `usage_allowance` + overage design (§6.15.3) fits the market (MA-402).
- **Included usage is pooled across the whole tenant, not held per user.** GitHub, Gemini Enterprise, Copilot Studio and Claude Enterprise all do this. Ralysa should pool allowances per organisation (with optional per-department pools), not per seat (MA-404).
- **A flat unlimited seat does not work for agent users.** **Estimate:** a medium agent user costs about $16–34 per month in model tokens on mid-tier models with caching. A heavy user (Code or Data Workspace) costs about $90–340 per month. Both can exceed a $20 seat (MA-407).
- **Premium or power seats at about 5x the price for about 5x the usage are standard.** Claude Team ($100), ChatGPT Business Premium ($100) and Dust Max (€120) all follow this pattern. Ralysa should offer a Power seat rather than raising Core (MA-403).
- **Sovereignty is priced as a surcharge of about 10% on tokens, and nobody publishes on-prem software prices.** Anthropic, OpenAI, Bedrock and Vertex all add 10% for regional or residency endpoints. Gulf sovereign players (Core42, Ooredoo, HUMAIN) publish GPU or infrastructure pricing only, or nothing. Ralysa can set the market reference for sovereign agent-platform pricing (MA-406).
- **Recommended architecture (Estimate):** an annual platform fee tiered by deployment model, named Core seats with a cheaper named Lite seat, Workspace and department-pack add-ons, a pooled usage allowance, overage at list price plus margin, and a BYO-model price that removes the included usage (see *Recommended price architecture*).

## Segments & beachhead

This stream reuses the segmentation from the main market analysis. For pricing, the relevant buyer split is:

| Segment | Industry | Region | Size | Buyer | Why now | Priority |
|---|---|---|---|---|---|---|
| Regulated Gulf enterprise (beachhead) | Telecom, banking, government | Qatar, UAE, KSA | 1,000–20,000 staff | CIO/CISO signs platform fee; department heads fund packs | Incumbent seat prices have settled, so buyers now compare total cost of ownership and residency | 1 |
| Multinational regulated subsidiary | Banking, telecom | GCC + EU | 5,000+ | Group CIO, procurement | Already pays for M365 Copilot or ChatGPT Enterprise; needs an in-country option for T2/T3 data | 2 |
| Mid-market regional enterprise | Mixed | GCC | 300–1,000 | CIO/COO | Self-serve seat pricing of about $20 is now the reference price | 3 |

## Market sizing

Out of scope for this stream. See the market-sizing documents in `docs/market/`. The price ranges below are inputs to bottom-up SAM/SOM.

## Competitor matrix (pricing view)

All prices in USD unless stated otherwise. "Annual" means per user per month on an annual commitment. All sources accessed 2026-09-24 unless stated otherwise. **Weaker source** = third-party or search-result snippet because the vendor page blocked fetching or does not publish the price.

| Vendor / product | List price | Billing unit | Minimums / caps | Included usage | Overage model | Annual vs monthly | Source (accessed) |
|---|---|---|---|---|---|---|---|
| Microsoft 365 Copilot (enterprise add-on) | $30.00 annual | Seat (add-on to a qualifying M365 plan) | Requires a qualifying M365 base licence | Copilot Studio agent use by licensed users is "No charge" (fair-use limits) | Not applicable to seat; agents used by unlicensed users bill Copilot Credits | Pay yearly or pay monthly options shown | [microsoft.com enterprise pricing](https://www.microsoft.com/en-us/microsoft-365-copilot/pricing/enterprise) (2026-09-24); [Copilot Studio page](https://www.microsoft.com/en-us/microsoft-copilot/microsoft-copilot-studio) (2026-09-24) |
| Microsoft 365 Copilot Business (add-on, SMB) | $21.00 annual; **$18.00 promotional** 1 Jul–31 Dec 2026; $25.20 monthly | Seat | Up to 300 users; requires an M365 Business plan | As above | As above | Monthly is 20% higher | [microsoft.com M365 Copilot pricing](https://www.microsoft.com/en-us/microsoft-365-copilot/pricing) (2026-09-24) |
| Microsoft 365 E7 "Frontier Suite" | $99 per user per month | Seat bundle (E5 + M365 Copilot + Agent 365 + Entra Suite) | n/a | Includes Copilot | n/a | Not stated | [Official Microsoft Blog, 2026-03-09](https://blogs.microsoft.com/blog/2026/03/09/introducing-the-first-frontier-suite-built-on-intelligence-trust/) (2026-09-24). **Announcement is more than 6 months old** |
| Microsoft Agent 365 (standalone) | $15 per user per month | Seat (agent governance) | n/a | n/a | n/a | Not stated | Same blog (2026-09-24). **More than 6 months old** |
| Microsoft Copilot Studio | $200 per pack per month for 25,000 Copilot Credits (about $0.008/credit); pay-as-you-go also available | Credits (capacity pack or PAYG), pooled per tenant | Needs an Azure subscription | Pack credits reset monthly | Enforcement at 125% of prepaid capacity (agents disabled) unless a PAYG meter is attached. Rates: classic answer 1 credit, generative answer 2, agent action 5, tenant graph grounding 10, premium reasoning 10 credits per 1K tokens | Pack is monthly on subscription | [Copilot Studio page](https://www.microsoft.com/en-us/microsoft-copilot/microsoft-copilot-studio) and [Microsoft Learn billing rates (updated 2026-09-14)](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management) (2026-09-24). PAYG rate $0.01/credit: **weaker source**, [CloudZero](https://www.cloudzero.com/blog/copilot-studio-pricing/) (Azure page showed "$-") |
| ChatGPT Business, Standard seat | $20 annual / $25 monthly | Seat | 2-seat minimum (per third-party) | Plan usage limits | Shared workspace credits can be added when limits are hit | Monthly is 25% higher | Search-result snippets from [help.openai.com Business overview](https://help.openai.com/en/articles/8792828-what-is-chatgpt-business) and [OpenAI premium seats post](https://openai.com/index/premium-seats-chatgpt-business/) (2026-09-24). **Weaker source**: direct fetch returned 403. The April 2026 price cut is reported by [CloudZero](https://www.cloudzero.com/blog/how-much-does-chatgpt-cost/) |
| ChatGPT Business, Premium seat | $100 annual / $125 monthly | Seat | Mix-and-match with Standard | "5x more usage than Standard", no 5-hour limit | Workspace credits | Monthly is 25% higher | Same OpenAI sources (2026-09-24). **Weaker source** (403) |
| ChatGPT Enterprise | **Not published** | Seat + flexible credits | Reported 150-seat minimum (third-party) | Not published | Flexible credit pricing ([help article](https://help.openai.com/en/articles/11487671-flexible-pricing-for-the-enterprise-edu-and-business-plans), 403 on fetch) | Annual (reported) | Third-party estimate of $45–75 per seat, entry about $108K/yr: [Coworker](https://coworker.ai/blog/chatgpt-enterprise-pricing) (2026-09-24). **Weak, not vendor-confirmed** |
| Claude Team, Standard seat | $20 annual / $25 monthly | Seat | 2–150 users | More usage than Pro | Not detailed | Monthly is 25% higher | [claude.com/pricing](https://claude.com/pricing) (2026-09-24) |
| Claude Team, Premium seat | $100 annual / $125 monthly | Seat | Same | 5x Standard | Not detailed | Monthly is 25% higher | [claude.com/pricing](https://claude.com/pricing) (2026-09-24) |
| Claude Enterprise (includes Claude Code and Cowork) | $20 per seat per month, billed annually, **plus usage at API rates** | Hybrid: seat + metered tokens | No minimum stated | **None**: seats include no tokens; usage drawn from an org-wide pool | Self-serve: prepaid credits. Sales-assisted: monthly in arrears. US-only inference at 1.1x. Org and user spend limits | Annual | [claude.com/pricing](https://claude.com/pricing) and [Claude Help Center: Enterprise billing](https://support.claude.com/en/articles/11526368-how-am-i-billed-for-my-enterprise-plan) (2026-09-24) |
| Claude Code | No separate seat; included in Team/Enterprise seats and shares plan limits | See above | See above | See above | See above | See above | [claude.com/pricing](https://claude.com/pricing) (2026-09-24) |
| Google Workspace (Gemini included) | Starter $7, Standard $14, Plus $22 per user per month (flexible); Enterprise not published | Seat (AI bundled) | Up to 300 users on the published plans | Gemini in Gmail/Docs/etc. depending on tier | n/a | Annual saves about 16% | [workspace.google.com/pricing](https://workspace.google.com/pricing) (2026-09-24) |
| Gemini Enterprise, Business | From $21 per seat per month | Seat | 1–500 seats | 25 GiB pooled storage per user | Not stated | Not stated | Price from a [cloud.google.com](https://cloud.google.com/gemini-enterprise/business) search snippet (page truncated on fetch); seat cap from [editions doc](https://docs.cloud.google.com/gemini/enterprise/docs/editions) (2026-09-24) |
| Gemini Enterprise, Standard / Plus | Standard about $30 per seat per month; Plus **not published by Google** (third-party: $50 annual / $60 monthly) | Seat + pooled quotas + overage | No seat cap | Standard: 160 assistant queries/day, 3 Deep Research/day, 30 GiB. Plus: 200 queries/day, 10 Deep Research/day, 75 GiB (all pooled per project and location) | Storage $5/GiB/month; other overages at Agent Platform rates. Needs an invoiced billing account | Not stated | [Quotas & overages doc](https://docs.cloud.google.com/gemini/enterprise/docs/quotas-and-overages) (2026-09-24). $30 from a [Cloud Billing doc](https://docs.cloud.google.com/billing/docs/how-to/reports/gemini-enterprise-costs) snippet. Plus price: [WorkAgent](https://workagent.ai/gemini-enterprise-pricing), **weak** |
| Glean | **Not published** | Seat + FlexCredits (per third-party) | Often 100–250 users minimum | Not published | FlexCredits (third-party) | Annual | [glean.com/pricing](https://www.glean.com/pricing) shows no price (2026-09-24). Vendr: median contract **$98,890/yr** over 174 purchases, about 20% negotiated savings, [Vendr](https://www.vendr.com/marketplace/glean), data dated **Feb 2026 (more than 6 months old)** |
| Dust | Pro €24 annual / €30 monthly; Max €120 annual / €150 monthly; Enterprise custom | Hybrid: seat + credits | No minimum stated | Pro 8,000 credits/seat/month; Max 40,000; Enterprise pooled credits. No rollover | Programmatic usage $0.01/credit (Business) | Monthly is 25% higher | [dust.tt/home/pricing](https://dust.tt/home/pricing) (2026-09-24) |
| Writer | Starter: per-seat price **not shown** on the page; Enterprise **not published** | Seat with fixed credit limits; Enterprise has Pro seats + unlimited free Lite seats + solution packs | Starter up to 5 users | Fixed credit limits | Not published | Monthly or annual | [writer.com/pricing](https://writer.com/pricing/) (2026-09-24). Third-party: Starter $29–39, [search summary](https://www.vendr.com/marketplace/writer), **weak** |
| GitHub Copilot Business / Enterprise | $19 / $39 per granted seat per month | Hybrid: seat + GitHub AI Credits | n/a | 1,900 / 3,900 credits per user per month, **pooled** across the org, no rollover | $0.01 per credit when additional usage is enabled (the default); otherwise blocked until reset | Not stated | [GitHub Docs: plans](https://docs.github.com/en/copilot/get-started/plans) and [usage-based billing](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises) (2026-09-24) |
| Cursor Teams / Enterprise | Teams $40 per user per month; Enterprise custom | Hybrid: seat + included model usage | n/a | "A set amount of model usage" (amount not shown) | On-demand usage billed in arrears | Monthly or yearly | [cursor.com/pricing](https://cursor.com/pricing) (2026-09-24) |
| Mistral (Le Chat / Vibe) Team / Enterprise | Team $24.99 per user per month; Enterprise custom | Seat | n/a | Not stated | Not stated | Not stated | [mistral.ai/pricing](https://mistral.ai/pricing) (2026-09-24). Self-hosted/on-prem offered, **price not published** |
| Cohere North (private / air-gapped) | **Not published** | Custom enterprise agreement | n/a | n/a | n/a | n/a | [cohere.com/pricing](https://cohere.com/pricing) via search summary (2026-09-24) |
| Core42 Compass / AI Cloud (UAE sovereign) | Tokens: **not published** ("pay-as-you-go or tokens-per-minute"). GPU: H100 from $2.50/hr, H200 from $4.00/hr, B200 from $5.00/hr, MI300X from $3.50/hr | Usage (tokens or GPU-hours) | n/a | n/a | n/a | n/a | [core42.ai/products/ai-cloud](https://www.core42.ai/products/ai-cloud) (2026-09-24) |
| HUMAIN Chat (KSA), Ooredoo Sovereign AI Cloud (QA), e& UAE Sovereign AI Platform | **Not published** | n/a | n/a | n/a | n/a | n/a | [Saudipedia on HUMAIN Chat](https://saudipedia.com/en/humain-chat-application); [Oracle–Ooredoo announcement, 2026-02-16](https://www.oracle.com/ae/news/announcement/ooredoo-oracle-collaborating-to-provide-ai-and-cloud-computing-services-2026-02-16/) (**more than 6 months old**); [Security MEA, 2026-05-21](https://securitymea.com/2026/05/21/e-csc-and-oi-launch-the-uae-sovereign-ai-platform/) (2026-09-24) |

## Packaging patterns

| Pattern | Who uses it (evidence above) | How it works | Fit for Ralysa |
|---|---|---|---|
| **Per-seat, usage bundled** | M365 Copilot, Google Workspace, Claude/ChatGPT Team Standard | A flat seat with fair-use limits | Good for Core chat and light users. Risky for agent-heavy workspaces (MA-407) |
| **Per-seat + metered usage (hybrid)** | Claude Enterprise ($20 + API rates), GitHub Copilot (seat + pooled credits, $0.01 overage), Dust (seat + credits), Cursor, Gemini Enterprise (seat + pooled quotas + overage) | Seat pays for access, governance and support. Usage is metered from a pool | **Best fit**: matches spec §6.15.3 `billing` + `usage_allowance` |
| **Pure consumption / capacity packs** | Copilot Studio (credits), Core42 Compass (tokens, GPU-hours), cloud model APIs | Prepaid packs or pay-as-you-go. No user licence needed | Good for occasional or unlicensed users and scheduled agents (Automation add-on) |
| **Standard vs premium seat tiers** | Claude Team ($20/$100), ChatGPT Business ($20/$100), Dust Pro/Max (€24/€120) | Same features, about 5x usage for about 5x price. Seat types can be mixed and reassigned | Add a **Power** seat for Code/Data users |
| **Free or light seats alongside paid seats** | Writer Enterprise (unlimited free Lite seats), Microsoft Copilot Chat (free with M365; agents metered), Gemini Frontline edition (150-seat minimum, 2 GiB) | Wide reach at low cost. Monetised by usage or by paid seats | Answers spec Q8: a named **Lite** seat instead of concurrent seats |
| **Suite bundles** | M365 E7 $99 (E5 + Copilot + Agent 365 + Entra) | Discount compared with à-la-carte, tied to the incumbent suite | Ralysa cannot match on bundle price. Use department **suites** (e.g. Finance Suite) at 20–30% off packs |
| **Role / department bundles** | Writer "solution packs", Dust Enterprise (per-workspace), Copilot Studio agents | Priced per use-case pack | Ralysa department packs are a differentiator; few competitors price by department |
| **Platform fee + consumption** | Enterprise platforms with unpublished pricing and large entry contracts (Glean median $98,890/yr, Vendr; ChatGPT Enterprise reported entry about $108K) | Annual platform commitment, then seats or credits | Use a platform fee for control plane, gateways and deployment tier |
| **Residency / sovereign premium** | Anthropic `inference_geo` 1.1x; OpenAI regional endpoints +10%; Bedrock/Vertex regional endpoints +10% | Token surcharge | Pass through at cost plus margin; price in-country deployment through the platform-fee tier |
| **On-prem / private deployment premium** | Cohere North, Mistral self-hosted, Dust single-tenant (Enterprise): **all custom, none published** | Custom quote | Open field for Ralysa to set a published "from" price, which is a trust signal in RFPs |
| **BYO-model discount** | Copilot Studio: BYO-model / Azure Foundry models "billed separately" and excluded from credit rates; Claude Enterprise effectively passes tokens through at API rates | Vendor charges for the platform. Customer pays the model provider | Offer a BYOM seat price that excludes the included allowance |
| **Monthly premium** | Claude, ChatGPT, Dust +25%; M365 Copilot Business +20%; Workspace annual saves about 16% | Annual default; monthly costs 16–25% more | Annual default; monthly +20% |

## Token-cost model (Estimate)

**Published API prices** (per 1M tokens, standard tier, accessed 2026-09-24):

| Model | Input | Cached input (read) | Output | Source |
|---|---|---|---|---|
| Claude Haiku 4.5 | $1.00 | $0.10 | $5.00 | [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Claude Sonnet 5 | $2.00 | $0.20 | $10.00 | same (the $2/$10 introductory price is now standard; the planned rise to $3/$15 was cancelled) |
| Claude Opus 5.5 | $4.00 | $0.20 | $20.00 | same |
| OpenAI GPT-5.6-Terra (mid-tier) | $2.00 | $0.20 | $12.00 | [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) |
| OpenAI GPT-6-Sol / GPT-6-Luna | $2.00 / $0.10 | $0.20 / $0.01 | $10.00 / $0.50 | same |
| Gemini 3.1 Pro Preview (≤200K context) | $2.00 | not verified | $12.00 | [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Gemini 3.8 Flash | $0.75 (until 2026-12-31, then $1.50) | not verified | $3.75 (then $7.50) | same |
| Open-weight: OpenAI gpt-oss-120b on Amazon Bedrock (Sydney) | $0.1545 | n/a | $0.618 | [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) |
| Open-weight: Qwen3 235B on Amazon Bedrock (US) | $0.53 | n/a | $2.66 | same |

Modifiers: Anthropic US-only inference 1.1x. OpenAI regional/data-residency processing +10% for eligible models released on or after 2026-03-05. Bedrock/Vertex regional endpoints +10% for Claude. Batch API -50%. Claude 4.7+ tokenizer produces about 30% more tokens for the same text (sources as above).

**Usage profiles (Assumptions).** Each profile is per *active* user per month, over 21 working days. "Turn" means one model call inside an agent loop (a user request can trigger several turns).

| Profile | Typical user | Turns/day | Input tokens/turn (system prompt, tools, context, history) | Output tokens/turn | Monthly input | Monthly output |
|---|---|---|---|---|---|---|
| Light | Chat, policy Q&A, short drafts (Core only) | 10 | 15,000 | 800 | 3.15M | 0.17M |
| Medium | Department pack user: documents, tickets, a few tool calls | 40 | 30,000 | 1,500 | 25.2M | 1.26M |
| Heavy | Code/Data Workspace, long agent loops | 150 | 50,000 | 2,000 | 157.5M | 6.3M |

Caching assumption: 70% of input tokens are cache reads (stable system prompt, tools and skills, per spec §6.11). Cache-write premiums are ignored, so add about 10% as a buffer.

**Estimated model cost per active user per month (USD, Estimate):**

| Model | Light (no cache / 70% cache) | Medium (no cache / 70% cache) | Heavy (no cache / 70% cache) |
|---|---|---|---|
| Claude Haiku 4.5 | 3.99 / **2.01** | 31.50 / **15.62** | 189.00 / **89.78** |
| Claude Sonnet 5 | 7.98 / **4.01** | 63.00 / **31.25** | 378.00 / **179.55** |
| Claude Opus 5.5 | 15.96 / **7.58** | 126.00 / **58.97** | 756.00 / **337.05** |
| GPT-5.6-Terra | 8.32 / **4.35** | 65.52 / **33.77** | 390.60 / **192.15** |
| Gemini 3.1 Pro Preview (no cache price verified) | 8.32 | 65.52 | 390.60 |
| Gemini 3.8 Flash (introductory price, no cache price verified) | 2.99 | 23.62 | 141.75 |
| gpt-oss-120b on Bedrock (open-weight) | 0.59 | 4.67 | 28.23 |
| Qwen3 235B on Bedrock (open-weight) | 2.12 | 16.71 | 100.23 |
| **Routed mix** (60% Haiku, 35% Sonnet, 5% Opus, cached) | **2.99** | **23.26** | **133.56** |

Arithmetic example (Sonnet 5, medium, cached): 25.2M × (0.3 × $2 + 0.7 × $0.20) = $18.65 for input, plus 1.26M × $10 = $12.60 for output, giving **$31.25**.

**Tenant example (Estimate):** 1,000 Core seats, 60% monthly active. Of the active users, 60% are light, 30% medium and 10% heavy, all on the routed mix. Cost = 360 × 2.99 + 180 × 23.26 + 60 × 133.56 = **about $13.3K per month**, or about **$13 per seat per month** (about $160 per seat per year). A 10% residency surcharge adds about $1.3 per seat. So a $20 seat that includes unlimited usage leaves little margin for the platform, support and in-country hosting. Heavy users drive about 60% of the cost.

## Recommended price architecture (Estimate)

All prices below are **Estimates** for validation with pilot customers. None are published competitor prices.

| Layer | What it covers | Unit | Indicative list price (Estimate) | Market anchor |
|---|---|---|---|---|
| **Platform fee** | Control plane, SSO/SCIM, policy engine, audit, Model and MCP gateways, admin consoles, Platform Admin, support tier | Per organisation per year, tiered by deployment (§9) | SaaS in-region: **$30K–60K/yr**. Dedicated in-country cloud: **$75K–150K/yr**. On-prem / air-gapped (signed licence file, offline updates): **$150K–300K/yr**, customer provides infrastructure | Glean median $98,890/yr (Vendr, Feb 2026); ChatGPT Enterprise reported entry about $108K (weak) |
| **Core seat (named)** | Chat workspace, all surfaces, memory, common skills + **pooled usage allowance** | Per named user per month, annual | **$18–25** with about **$6/user/month** of pooled model credit | Claude Ent $20 + usage; ChatGPT Business $20; Gemini Business $21; M365 Copilot $30 |
| **Lite seat (named)** | Chat + read-only skills, small allowance, no workspaces or T3 packs | Per named user per month | **$5–8** | Writer free Lite seats; Gemini Frontline; Copilot Chat free + metered agents |
| **Power seat upgrade** | About 5x the Core allowance | Per named user per month | **+$60–80** (total about $80–100) | Claude/ChatGPT premium $100; Dust Max €120 |
| **Workspace add-ons** | Code / Data / Docs, each with an extra pooled allowance | Per named user per month | Code **$19–35** (+about $20 credit); Data **$15–30** (+about $15 credit); Docs **$8–15** | GitHub Copilot Business $19 / Enterprise $39; Cursor Teams $40 |
| **Department packs** | Skills, agents, connectors, tier controls | Per named user per month | T1 packs **$8–15**; T2 **$15–25**; T3 (RA, Fraud, SOC, HR, Audit) **$25–40**. **Suites** (e.g. Finance Suite) 20–30% off the sum of packs | Agent 365 $15/user as a governance anchor; no direct department-pack comparator is published |
| **Connector packs** | M365, Google, email, DMS, DB | Per organisation per year (flat), or included in department packs | **$5K–20K/yr per pack** (Estimate) | Connector cost scales with the tenant, not the user. Keeps seat SKUs simple |
| **Platform add-ons** | Advanced Models, Indexed Search, Automation, Custom Skills authoring | Mix: Advanced Models as a usage multiplier; Indexed Search per GB or document; Automation from a credit pool | Advanced Models: priced by consumption (no seat). Indexed Search: storage-based (Gemini charges $5/GiB/month over quota) | Copilot Studio credits; Gemini storage overage |
| **Usage / overage** | Model tokens beyond the pooled allowance, sandbox hours | Ralysa credits, $0.01 each, tenant-pooled with optional department pools and spend limits | List API price **+10–20% margin**; residency surcharge passed through (+10%); monthly in arrears or prepaid packs at about 20% off | GitHub $0.01/credit; Copilot Studio $0.008 prepaid vs PAYG; Dust $0.01/credit |
| **BYO-model (BYOM)** | Customer's own keys or local models through the Model Gateway | Same seats, minus the included allowance | Core BYOM **about $14–19** (Core minus the credit value); a small gateway fee can apply per 1M tokens routed (Estimate: $0–0.10) | Copilot Studio bills BYO models separately; Claude Ent passes tokens through |
| **Terms** | | | Annual default; monthly +20%; multi-year 5–10% off; 14-day trial seats (§6.15.4) | Vendors charge 16–25% more for monthly billing |

**Seat model answer (spec §15 Q8):** use **named seats only**, in three weights (Lite, Core, Power), plus **metered pay-per-use** for unlicensed or occasional access to published agents. Do not use concurrent or pooled seats. They conflict with identity-based entitlements and per-user audit (§6.4, §6.15.5), and no benchmarked vendor uses them. Pool the **usage**, not the seats.

## Insights

| ID | Insight | Evidence (source, date) | Confidence (H/M/L) | Implication |
|---|---|---|---|---|
| MA-401 | Horizontal enterprise AI seat prices have settled at about $20/user/month annual (enterprise M365 Copilot at $30 is the high end). | [claude.com/pricing](https://claude.com/pricing); [OpenAI Business, snippet](https://help.openai.com/en/articles/8792828-what-is-chatgpt-business); [Gemini Business](https://cloud.google.com/gemini-enterprise/business); [M365 Copilot pricing](https://www.microsoft.com/en-us/microsoft-365-copilot/pricing), all 2026-09-24 | H | Price the Ralysa Core seat at $18–25. Justify any premium through packs and governance, not the base seat. |
| MA-402 | The market is moving to hybrid seat + metered usage. Anthropic moved Enterprise to $20 seat + API-rate usage with no included tokens. | [Claude Help Center](https://support.claude.com/en/articles/11526368-how-am-i-billed-for-my-enterprise-plan); [GitHub usage-based billing](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises); [Copilot Studio billing](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management); [Dust](https://dust.tt/home/pricing), 2026-09-24 | H | Keep §6.15.3 `usage_allowance` + overage. Metering in the Model Gateway is a launch requirement, not a later feature. |
| MA-403 | Standard/premium seat tiers at about 1x/5x price for about 1x/5x usage are standard and can be mixed within a workspace. | [claude.com/pricing](https://claude.com/pricing); [OpenAI premium seats, snippet](https://openai.com/index/premium-seats-chatgpt-business/); [Dust](https://dust.tt/home/pricing), 2026-09-24 | H | Add Lite / Core / Power seat weights to the plan catalogue. Admins can reassign them (§6.15.4). |
| MA-404 | Included usage is pooled at org level, not per user, and does not roll over. | [GitHub](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises); [Gemini quotas](https://docs.cloud.google.com/gemini/enterprise/docs/quotas-and-overages); [Claude Help Center](https://support.claude.com/en/articles/11526368-how-am-i-billed-for-my-enterprise-plan), 2026-09-24 | H | Change §6.15.3 so allowances pool per organisation (optionally per department for chargeback), with org and user spend limits. |
| MA-405 | Governance and knowledge platforms do not publish prices and land around $60K–110K/yr entry contracts. | [Glean page](https://www.glean.com/pricing) (no price); [Vendr Glean](https://www.vendr.com/marketplace/glean) (Feb 2026, more than 6 months old); [Coworker on ChatGPT Ent](https://coworker.ai/blog/chatgpt-enterprise-pricing) (weak), 2026-09-24 | M | A platform fee in the $30K–150K band is normal for buyers. Publishing a "from" price could be a differentiator. |
| MA-406 | Data residency is priced as about +10% on tokens by every major model provider. No vendor publishes on-prem or sovereign agent-platform pricing; Gulf sovereign clouds publish GPU-hour rates only. | [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing); [OpenAI pricing](https://developers.openai.com/api/docs/pricing); [Core42](https://www.core42.ai/products/ai-cloud); [Cohere](https://cohere.com/pricing); [Mistral](https://mistral.ai/pricing), 2026-09-24 | M | Price sovereignty through platform-fee tiers (SaaS / in-country / on-prem) plus a pass-through token surcharge. Do not add a per-seat sovereign premium. |
| MA-407 | **Estimate:** agent use makes flat seats unprofitable. On a routed, cached model mix, light ≈ $3, medium ≈ $23 and heavy ≈ $134 per active user per month. Heavy users on Sonnet/Opus reach $180–340. | Token-cost model above, using [Claude](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI](https://developers.openai.com/api/docs/pricing), [Gemini](https://ai.google.dev/gemini-api/docs/pricing) prices, 2026-09-24 | M (arithmetic H, usage assumptions M) | Never sell unlimited usage. Give Code/Data Workspaces their own allowances. Model routing and caching (§6.11) are margin levers, not just features. |
| MA-408 | Hosted open-weight models cost about 10–15x less than frontier mid-tier models (gpt-oss-120b: $0.15/$0.62 per 1M). Self-hosting one 8×H100 node on Core42 costs about $14.6K/month (8 × $2.50 × 730 h, Estimate). | [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/); [Core42](https://www.core42.ai/products/ai-cloud), 2026-09-24 | M | A local model for T3 data is cost-competitive at scale. Offer it through BYOM or on-prem tiers. Local inference costs sit with the customer or in the platform fee, not in seats. |
| MA-409 | Incumbents bundle AI into suites (M365 E7 $99 includes Copilot + Agent 365; Workspace includes Gemini). Microsoft prices agent governance alone (Agent 365) at $15/user. | [Microsoft blog 2026-03-09](https://blogs.microsoft.com/blog/2026/03/09/introducing-the-first-frontier-suite-built-on-intelligence-trust/) (more than 6 months old); [Workspace pricing](https://workspace.google.com/pricing), 2026-09-24 | M | Do not compete on bundle price. Position as the governed agent layer for non-M365 systems and T2/T3 departments. $15/user is a reference for governance value. |
| MA-410 | Monthly billing costs 16–25% more than annual at every vendor that publishes both. | [claude.com/pricing](https://claude.com/pricing); [M365 Copilot pricing](https://www.microsoft.com/en-us/microsoft-365-copilot/pricing); [Dust](https://dust.tt/home/pricing); [Workspace](https://workspace.google.com/pricing), 2026-09-24 | H | Default to annual terms. Monthly at +20% for trials and small departments. |
| MA-411 | Developer-seat reference is $19–40 per user per month with pooled credits: GitHub Copilot Business $19 (1,900 credits), Enterprise $39 (3,900 credits), overage $0.01/credit; Cursor Teams $40. | [GitHub Docs](https://docs.github.com/en/copilot/get-started/plans); [Cursor](https://cursor.com/pricing), 2026-09-24 | H | Price the Code Workspace add-on at $19–35 with its own credit pool. Adopt the $0.01 credit as Ralysa's billing unit because buyers already know it. |

## Recommendations

- **Positioning:** Do not compete on seat price. Match the market at about $20 and win on sovereignty tiers, department packs and per-department chargeback (MA-401, MA-409).
- **Pack priority:** Price T3 packs (RA, Fraud, SOC, HR, Audit) highest. Their controls and in-country and local-model needs are what incumbents do not offer (MA-406, MA-408).
- **Pricing stance:** Launch with **platform fee (by deployment tier) + named seats (Lite / Core / Power) + add-on workspaces and packs + pooled credit allowance + metered overage at list plus 10–20%**. Offer BYOM as a lower seat price. Default to annual terms (MA-402, MA-403, MA-404, MA-410).
- **Roadmap changes:**
  - Update spec §6.15.3/§6.15.7: allowances pool at org level (optional department pools), a $0.01 credit unit, org and user spend limits, and an enforcement policy (alert, then soft cap, then block) (MA-404, MA-411).
  - Add Lite and Power seat weights and a pay-per-use path for unlicensed users of published agents (§6.15.2, answers §15 Q8) (MA-403).
  - Treat Model Gateway metering, routing and caching as Phase 1 requirements because they protect margin (MA-407).
  - Price connector packs per organisation, not per seat (Recommendation, Estimate).

## Open questions

1. **Pilot validation:** will a Gulf telecom or bank buyer accept a separate platform fee plus seats, or does procurement expect one per-seat all-in price? This needs 3–5 pilot conversations.
2. **Actual token consumption:** the light/medium/heavy profiles are Assumptions. Instrument the Phase 1 pilot to measure real turns per day and cache-hit ratio before fixing allowance sizes.
3. **Local currency and VAT:** list prices in USD or QAR/AED/SAR? Should government buyers get in-country price lists?
4. **Anthropic resale terms (spec §15 Q4):** can Ralysa resell Claude tokens at a margin, or must Claude usage be BYOM or pass-through? This changes the overage design.
5. **Sovereign GPU cost:** on-prem and in-country tiers depend on local GPU pricing. Core42 publishes H100 from $2.50/hr, but Ooredoo, stc and HUMAIN rates are not published. Request quotes.
6. **Evidence gaps:** ChatGPT Business/Enterprise pages returned 403 (figures come from search snippets and third parties). The Gemini Enterprise Plus price is third-party only. Glean and Writer Enterprise have no published prices. Re-verify before G2.
7. **Partner margin:** Gulf deals often go through integrators. Should list prices leave room for a 15–30% partner discount (Assumption)?

## Approval (G1)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
