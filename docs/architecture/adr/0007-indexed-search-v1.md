# ADR-0007: Indexed search: not in v1; designed for, pgvector-first when built

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Proposed by architect agent (stream A). Decision owner: Tech lead (G3) with Product owner (OQ-13).
- **Related:** spec §6.7.3, §6.15.2 (Indexed Enterprise Search add-on), §10.3 (pgvector optional), §13 Phase 3, §15 Q9; PRD OQ-3, OQ-13; REQ-036, REQ-040, REQ-042, REQ-043, REQ-044, REQ-096; F-026, F-027, F-039

## Context & forces

Spec §15 Q9 asks whether indexed search is in v1. Spec §6.7.3 makes **live access the default**, with an optional per-source **indexed mode** that stores ACLs and re-syncs permissions. The PRD keeps REQ-044 as **Could, Phase 3**, and the roadmap places it in F-039 (OQ-13).

Forces:

- **Permission correctness.** An index is a copy. Any lag in ACL sync can show a user content they can no longer access. Live access is permission-trimmed by the source at query time (§6.7.3).
- **Residency.** An index is another store of tenant content and derived embeddings that must stay in region (REQ-096). Embeddings of T3 content must come from a **local** embedding model through the Model Gateway, audited like any model call.
- **Operations.** Every extra stateful system has to be packaged, backed up, upgraded and patched in each customer-operated deployment (ADR-0003), including air-gapped ones.
- **Arabic retrieval quality.** Bilingual lexical plus semantic retrieval needs evaluation. We haven't verified Arabic stemming support in PostgreSQL full-text search.
- **Capacity.** Phase 1 is overloaded (OQ-3). The pilot (Technology: ITSM + Release) searches ServiceNow and Jira, which have their own search APIs. The M365 and Google connectors come in Phase 2 (REQ-040/041), DMS in Phase 3 (REQ-043).
- **Commercial.** Indexed Enterprise Search is a paid add-on (§6.15.2), so it's optional by design.

## Options considered

| Criterion | A. No index in v1 (Phases 1–2): live, permission-trimmed source search; index built in Phase 3 | B. pgvector index in v1 (Phase 2, with M365/Google) | C. OpenSearch (or similar engine) in v1 |
|---|---|---|---|
| Permission correctness | Source enforces ACLs at query time | Our ACL copy and re-sync; lag risk | Our ACL copy; document-level security queries per role ([OpenSearch DLS](https://docs.opensearch.org/latest/security/access-control/document-level-security/)); lag risk |
| Residency footprint | No new copy of content | New copy in the existing PostgreSQL | New stateful cluster with a copy |
| Extra systems to operate on-prem / air-gapped | None | None: extension in PostgreSQL; HNSW/IVFFlat indexes; iterative index scans for filtered queries ([pgvector](https://github.com/pgvector/pgvector)) | A new cluster per deployment |
| Cross-source relevance ("find anything") | Weaker: per-source search, merged by the agent | Good | Best: hybrid lexical plus vector |
| Arabic lexical search | Whatever each source provides | PostgreSQL FTS; Arabic support unverified | Analyzer plugins; not assessed |
| Scale ceiling | Source APIs' limits and latency | Tens of millions of chunks is the point to re-measure (assumption) | Highest |
| Phase 1–2 delivery cost | None | Medium: sync workers, ACL mapping, re-sync, embeddings pipeline | High |
| Fit with pilot | Good: ServiceNow and Jira have search | Not needed by the pilot | Not needed by the pilot |

All links above were accessed 2026-09-25.

## Decision

**Option A for v1.** No indexed search in Phases 1–2. Agents use live, permission-trimmed search through connector tools (`files.search`, `mail.search`, source-native search) via the MCP Gateway.

Design rules now, so Phase 3 is additive:

1. `services/extraction` outputs **chunked, source-referenced text with the source's ACL identifiers and sensitivity label** attached (REQ-042). Live use ignores the ACL fields; a future indexer consumes them.
2. Search is a **capability interface** in skills (`files.search`), never a specific index. Skills must not assume an index exists.
3. Embedding generation is a model call through the Model Gateway (tier routing, audit). The local runtime's embeddings endpoint serves T3 (ADR-0006).
4. Guardrails for Phase 3:
   - indexing a T3 source needs platform-admin approval (REQ-044d);
   - the index is stored in region;
   - ACL re-sync must meet the REQ-044b target (≤ 15 min, proposed), and results are **re-checked against the source or the MCP Gateway policy at read time** before they reach the model.

**For Phase 3 (F-039):** spike **option B (pgvector plus PostgreSQL full-text, hybrid) first**, behind a `search` port, with a bilingual retrieval eval. Move to option C only if the eval or the scale measurements fail. That choice gets its own ADR at F-039 design.

## Consequences

- Positive:
  - No stale-ACL leak risk and no extra copy of tenant content in the pilot phases.
  - No new stateful system for on-prem and air-gapped installs in Phases 1–2.
  - Phase 1 capacity stays on pilot-critical work.
- Negative / risks:
  - Cross-source "search everything" is weaker until Phase 3. That puts us behind competitors that lead with enterprise search (for example Glean, spec §14).
  - Source search APIs vary in quality and latency. Some DMS/CMIS back ends may have poor search, which could hurt the Docs workspace in Phase 2.
  - Agents may make more tool calls per question (search, then read), which costs tokens (REQ-079).
- What would make us revisit:
  - The pilot or the committed second pack (RA) shows live search failing: too slow, too many calls, or poor Arabic results.
  - A signed customer requires cross-source search in Phase 2.
  - A Phase 2 connector's source offers no usable search API.
  - Competitive pressure (MA-101 to MA-110) moves Indexed Enterprise Search up in the roadmap.

## References

- pgvector (HNSW, IVFFlat, iterative index scans for filtered queries): https://github.com/pgvector/pgvector (accessed 2026-09-25)
- OpenSearch document-level security: https://docs.opensearch.org/latest/security/access-control/document-level-security/ (accessed 2026-09-25)
- PostgreSQL text search dictionaries (Snowball; Arabic not confirmed on the page): https://www.postgresql.org/docs/current/textsearch-dictionaries.html (accessed 2026-09-25)
- Spec §6.7.3, §15 Q9; PRD REQ-044, OQ-13; roadmap F-039

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
