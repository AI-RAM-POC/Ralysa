---
name: market-analysis
description: ADLC phase 1 - run market and competitive analysis for Ralysa (whole product, a department pack, an edition, or a specific question) and produce evidence-backed MA-nnn insights in docs/market/. Use when the user asks for market research, competitor analysis, positioning, sizing, pricing benchmarks, or whether there is demand for something.
argument-hint: "[topic, e.g. 'whole product' | 'Finance pack' | 'Telecom Edition' | a question]"
---

# Phase 1: Market analysis

Topic: **$ARGUMENTS** (if blank, analyze the whole product against spec §1 and §14).

1. Read `docs/adlc/README.md`, spec §1, §2, §7 and §14, and everything in `docs/market/`. Find the highest existing `MA-nnn`.
2. Split the work and launch **market-analyst** subagents in parallel, one per stream. Each writes its own file:
   - `docs/market/competitors.md`: the competitor matrix and profiles
   - `docs/market/segments-and-sizing.md`: segments, beachhead, TAM/SAM/SOM with the arithmetic
   - `docs/market/regulation.md`: residency and AI regulation by target country
   - `docs/market/pricing-benchmarks.md`: published enterprise AI pricing (only if the topic involves pricing or subscriptions)
   For a narrow topic, use a single agent writing `docs/market/<topic-slug>.md`.
   Give each agent its own block of MA numbers (MA-100+, MA-200+, …) so numbers don't clash.
3. When they return, launch one more **market-analyst** to synthesize `docs/market/summary.md` from `docs/adlc/templates/market-analysis.md`. It should hold the top insights, positioning implications, recommended pack priority and pricing stance, and open questions.
4. **Verify** before reporting:
   - spot-check 5 sourced claims by opening their links
   - make sure every number is either sourced or labelled as an estimate
   - make sure the G1 approval block is empty
5. Report to the user: the 5–7 most decision-relevant insights, the recommendations, and the open questions. Ask them to review `docs/market/summary.md` and record the **G1** approval. Next step after that: `/requirements`.
