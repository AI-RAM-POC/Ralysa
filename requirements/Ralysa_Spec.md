# Ralysa — Product & Architecture Specification

> **Product name:** Ralysa — *every department, one AI.* (see Section 1.5 — Brand)
> **Version:** 0.3 (Draft)
> **Date:** 24 September 2026
> **Author:** Ram Mohan Rao Adduri
> **Status:** Draft for review

---

## Table of Contents

1. [Overview](#1-overview)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [Users, Personas and Surfaces](#3-users-personas-and-surfaces)
4. [Key Architecture Decisions](#4-key-architecture-decisions)
5. [System Architecture](#5-system-architecture)
6. [Module Specifications](#6-module-specifications)
   - 6.1 Surfaces & UI (CLI, Desktop, Web)
   - 6.2 Agent Host & Agent Protocol
   - 6.3 Workspace Runtime (Web mode)
   - 6.4 Identity & Access Control
   - 6.5 Model Gateway (Bring Your Own Model)
   - 6.6 MCP / Data Gateway
   - 6.7 Productivity & Content Connectors
   - 6.8 Skills
   - 6.9 Memory
   - 6.10 Plugins, Marketplace & Department Packs
   - 6.11 Token & Prompt Optimization
   - 6.12 Hooks, Approvals & Safety
   - 6.13 Web Console (Profile, Department Admin, Platform Admin)
   - 6.14 Observability, Audit & Cost
   - 6.15 Subscriptions & Licensing
7. [Department Pack Catalog](#7-department-pack-catalog)
8. [Security, Privacy & Compliance](#8-security-privacy--compliance)
9. [Deployment Models](#9-deployment-models)
10. [Technology Stack](#10-technology-stack)
11. [Core Data Model](#11-core-data-model)
12. [Non-Functional Requirements](#12-non-functional-requirements)
13. [Delivery Roadmap](#13-delivery-roadmap)
14. [Risks and Mitigations](#14-risks-and-mitigations)
15. [Open Questions](#15-open-questions)
16. [Glossary](#16-glossary)

---

## 1. Overview

### 1.1 Vision

An **AI-native workspace for the whole enterprise**: an agent that works like Claude Code — plans, uses tools, reads and writes files, queries data, drafts documents — made available to **every department**, not only developers. What each person can see and do is decided by their **enterprise login**.

### 1.2 Problem

- Coding agents (Claude Code, Cursor, Copilot, Codex, Antigravity) serve developers only.
- Business departments (Finance, HR, Procurement, Marketing, Revenue Assurance, Fraud) have no governed way to let AI agents reach their systems and data.
- Enterprises in regulated industries (telecom, banking, government) need **data residency, identity-based access, full audit and control over which models are used** — requirements that general consumer AI tools do not fully meet.

### 1.3 Positioning

> *"Ralysa — Claude Code for the whole enterprise: every department gets an agent with the right skills, memory and data access, governed by SSO, hosted where your data must stay."*

### 1.4 Target Customers

- Large and mid-size enterprises with multiple departments and legacy + cloud systems.
- **Primary beachhead:** regulated Gulf enterprises — telecom operators, banks, government and semi-government entities — that require in-country hosting and on-prem options.
- **Industry edition:** a Telecom Edition (BSS/OSS, CDRs, Revenue Assurance, Fraud, TM Forum APIs).

### 1.5 Brand

**Name:** **Ralysa** (pronounced *ra-LEE-sa*)

**Origin:** built from the names of the founder's family, one letter from each:

| Letter | From |
|---|---|
| **R** | **R**am Mohan Rao |
| **A** | **A**adya Vaishnavi |
| **L** | Uma A**l**ekhya |
| **Y** | Puj**y**a Sritha |
| **S** | Pujya **S**ritha |
| **A** | Uma **A**lekhya |

The name also echoes *analysis*, fitting an AI that reads data, documents and systems across the enterprise.

**Naming architecture:**

| Use | Name |
|---|---|
| Product / platform | **Ralysa** |
| AI assistant inside it | **Ralysa** — "Ask Ralysa" (product and assistant share the name) |
| Optional descriptor | Ralysa Agent · Ralysa Assist · Ralysa Workspace |
| Workspaces | Ralysa Code · Ralysa Data · Ralysa Docs · Ralysa Chat |
| Department packs | Ralysa for Finance · Ralysa for HR · Ralysa for NOC · … |
| Web console | Ralysa Console |
| Surfaces | Ralysa CLI (`ralysa`) · Ralysa Desktop · Ralysa Web |

**Brand rules:**
- Do not use "Copilot" or "Gen AI" in product names (Microsoft trademark risk; generic, dated descriptor). "copilot" may appear as a lowercase common word in marketing copy only.
- **Tagline:** *"Ralysa — every department, one AI."*
- Formal trademark clearance required before launch (WIPO, USPTO, EUIPO, India, GCC; classes 9 and 42).

---

## 2. Goals and Non-Goals

### 2.1 Goals

| # | Goal |
|---|---|
| G1 | One AI workspace across **CLI, Desktop and Web**, with a consistent look and behavior. |
| G2 | **Identity-driven access:** SSO login + group membership decides models, tools, data, connectors and actions. |
| G3 | **Bring your own model:** org, department or personal LLM keys and enterprise endpoints (Vertex AI, Azure, Bedrock, Anthropic, OpenAI, local). |
| G4 | **MCP as the universal connector** to databases, SaaS, email, documents and internal systems. |
| G5 | Claude-grade agent capabilities: **skills, memory, plugins, hooks, subagents, prompt caching, context compaction**. |
| G6 | **Department Packs** that make the product useful out of the box for Technology, Product, Marketing, Procurement, Planning, HR, Finance, Legal & Compliance, Customer Care, Sales, Network Operations, Information Security, Internal Audit and Enterprise Risk. |
| G7 | Central **web console** for self-service profile, department admin and platform admin. |
| G8 | **Enterprise governance:** approvals, audit, PII masking, DLP labels, budgets, data residency. |
| G9 | Arabic and English, including **RTL UI** and Arabic document handling. |

### 2.2 Non-Goals (v1)

- Training or fine-tuning foundation models.
- Replacing systems of record (ERP, CRM, HCM, BSS) — the product connects to them, it does not replace them.
- Autonomous decisions in high-risk areas (hiring, fraud blocking, payments, production deployment) — AI recommends, humans approve.
- Mobile native apps (the web app is responsive; native apps are a later phase).
- A general public consumer product.

---

## 3. Users, Personas and Surfaces

### 3.1 Personas

| Persona | Typical user | Primary surface | Needs |
|---|---|---|---|
| **Developer / Engineer** | Dev, QA, DevOps, Architect | Desktop, CLI | Code editor, terminal, git, CI/CD, test tools |
| **Technology Manager** | PM, Release Manager, Demand Manager | Web, Desktop | Jira/ServiceNow, reports, documents, email |
| **Business Analyst / Data user** | Finance, RA, Fraud, Planning | Web | SQL, data grids, charts, reports |
| **Business user** | HR, Marketing, Procurement, Legal, Compliance, Sales | Web | Chat, documents, email, approvals |
| **Frontline / Operations user** | Customer Care agents, NOC engineers, SOC analysts | Web (side panel / agent-assist) | Fast summaries, next-best-action, ticket enrichment |
| **Assurance user** | Internal Audit, Enterprise Risk | Web | Read-only data access, evidence, workpapers, reports |
| **Department Admin** | Department head / delegate | Web console | Manage team access, budgets, approvals, dept skills |
| **Platform Admin** | IT / Security | Web console | Policies, providers, connectors, audit, cost |

### 3.2 Surfaces

| Surface | Description | Default for |
|---|---|---|
| **CLI** | Terminal agent, same commands as Claude Code style (`/skills`, `/plugins`, `/usage`, `/profile`) | Developers, automation, CI pipelines |
| **Desktop** | Full IDE-style app (Electron) with local files and terminal | Developers, power users |
| **Web** | Same UI as Desktop, served from the server; agent runs in a server-side sandbox | Non-technical departments, zero-install environments |

All three use the same account, policies, skills, memory, plugins and connectors.

---

## 4. Key Architecture Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Build a custom AI workspace, not a VS Code fork.** Use **Monaco** for code editing. | VS Code's UI is code-centric; business departments need chat, data and document layouts. |
| D2 | **Agent engine built on the Claude Agent SDK.** | Same harness as Claude Code: agent loop, tool use, MCP client, skills, subagents, hooks, compaction. Avoids rebuilding the hardest layer. |
| D3 | **SSO login decides access** via a central policy engine, enforced server-side at gateways. | Client-side permissions can be bypassed; server enforcement is auditable. |
| D4 | **Bring your own model** through a Model Gateway; credentials held in a vault. | Enterprises have existing cloud contracts (Vertex, Azure, Bedrock) and residency needs. |
| D5 | **MCP is the standard for all connectors.** Plugins are bundles of MCP servers + skills + commands + UI. | One integration model; reuse the public MCP ecosystem. |
| D6 | **Claude-style skills, memory, plugins, hooks, prompt caching, compaction.** | Proven patterns for quality and token efficiency. |
| D7 | **Web console** for profile and administration; IDE opens its pages by deep link. | Build once, update without shipping clients, central security. |
| D8 | **Three surfaces on one Agent Protocol.** Agent Host runs locally (CLI/Desktop) or in a server sandbox (Web). | One agent codebase; session handoff; consistent policy. |
| D9 | **UI stack mirrors Claude's apps:** React + TypeScript web app, Electron for desktop, Ink for CLI. | Proven pattern; ~95% UI reuse between web and desktop. |
| D10 | **Productivity & Content connector pack** with a common mail/files/calendar interface. | Skills work across Outlook, Gmail, IMAP, Exchange, SharePoint, Drive, DMS. |
| D11 | **Department Packs** as a first-class product concept. | Makes the product useful per department with pre-built connectors, skills and policies. |
| D12 | **Arabic RTL and bilingual support from day one.** | Core requirement for the Gulf market. |
| D13 | **Every module is sold as a subscription.** Admins assign subscriptions to users; one user can hold several. Access = subscriptions held **AND** policy allows. | Flexible commercial model; customers pay only for the modules each user needs. |

---

## 5. System Architecture

### 5.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                 SURFACES                                     │
│   CLI (Ink)            Desktop (Electron)            Web IDE (Browser)        │
│      │                        │                              │               │
│      └──────── Agent Protocol (WebSocket + JSON-RPC, typed) ─┘               │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼───────────────────────────────────────────┐
│                               AGENT HOST                                     │
│   Local (CLI / Desktop)   or   Server Workspace Runtime (K8s sandbox, Web)   │
│   Built on Claude Agent SDK:                                                  │
│   agent loop · tools · MCP client · skills · memory · subagents ·            │
│   hooks (policy + audit) · context compaction · deferred tool loading        │
└───────────────┬──────────────────────────────┬───────────────────────────────┘
                │                              │
┌───────────────▼──────────────┐  ┌────────────▼─────────────────────────────────┐
│        MODEL GATEWAY          │  │            MCP / DATA GATEWAY                │
│ policy check · vault creds ·  │  │ per-call policy check · identity pass-through│
│ routing · caching · budgets · │  │ · result limits · PII masking · audit        │
│ fallback · usage metering     │  │                                              │
└───────────────┬──────────────┘  └────────────┬─────────────────────────────────┘
                │                              │
  Claude (Anthropic API / Vertex /    Databases · M365 · Google Workspace ·
  Bedrock / Foundry) · Azure OpenAI · IMAP/Exchange · SharePoint/Drive/DMS ·
  OpenAI · Ollama / vLLM · others     ServiceNow · Jira · SAP · BSS/OSS · ...

┌──────────────────────────────────────────────────────────────────────────────┐
│                              CONTROL PLANE                                   │
│  SSO (OIDC/SAML) · Policy Engine (OPA/Cedar) · Profiles · Skills Library ·   │
│  Plugin Marketplace · Prompt Registry · Memory Service · Approvals ·         │
│  Access Requests · Usage & Budgets · Audit                                   │
│                                                                              │
│  Web Console:  /me (profile)   /dept (department admin)   /admin (platform)  │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                               PLATFORM                                       │
│   Postgres · Redis · Object storage · Vector store (optional) · Vault ·      │
│   OpenTelemetry · Audit store                                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Request Flow (example)

A Finance analyst asks: *"Compare last month's billed revenue with rated usage and flag gaps over 1%."*

1. User is signed in via SSO; token carries `groups: [Finance-RA]`.
2. Control Plane resolves the user's **subscriptions** (e.g., `Core`, `Data Workspace`, `Finance – Revenue Assurance Pack`) and profile `finance-revenue-assurance` → allowed model(s), tools, connectors, skills (only what is both subscribed and permitted).
3. Agent Host loads only permitted tools (deferred) and the relevant skill (*RA reconciliation*).
4. Agent plans; calls `db.query` on the **billing replica** via the MCP/Data Gateway.
5. Gateway checks policy (read-only, allowed tables), runs the query **as the user**, limits rows, masks PII, writes audit.
6. Agent calls the Model Gateway → Claude via the org's approved endpoint (e.g., Vertex, in-region), usage metered to the Finance budget.
7. Agent produces a variance table, chart and an investigation note; any export or email requires approval per policy.

---

## 6. Module Specifications

### 6.1 Surfaces & UI

#### 6.1.1 Principles

- **One UI codebase** (React + TypeScript) for Web and Desktop; Desktop = Web UI inside Electron + local Agent Host.
- **CLI** is a separate terminal UI (Ink) sharing the protocol, commands and types.
- **Department-aware layouts:** the SSO profile selects the default layout.
- **Accessible, bilingual, RTL-ready.**

#### 6.1.2 Workspaces (layout presets)

| Workspace | Panels | Default for |
|---|---|---|
| **Code** | File tree · Monaco editor · Terminal · Chat · Git · Diff | Developers, QA, DevOps |
| **Data** | Chat · SQL editor · Results grid · Chart · Saved queries | Finance, RA, Fraud, Planning |
| **Docs** | Chat · Document preview/editor · Sources · Export | HR, Marketing, Procurement, PMO |
| **Chat** | Full-width chat · Attachments · Approvals | All business users |
| **Approvals** | Inbox of pending actions · Diff / preview · Approve / reject | Managers, admins |

#### 6.1.3 Common UI Elements

- Command palette (Ctrl/Cmd+K) for all actions.
- Streaming chat with tool-call cards (what the agent is doing, inputs, results).
- Inline approval cards ("Agent wants to send an email — Approve / Edit / Reject").
- Blocked-action cards with **"Request access"** deep link to the web console.
- Usage indicator (tokens / budget remaining).
- Theme: light/dark; brand tokens configurable per customer.

#### 6.1.4 CLI Commands (initial set) — `ralysa`

| Command | Purpose |
|---|---|
| `/login` | SSO login (device code flow) |
| `/profile` | Opens `/me` in browser |
| `/skills` | List / invoke available skills |
| `/plugins` | List installed / available plugins |
| `/models` | Show allowed models, switch model |
| `/usage` | Token and cost usage vs budget |
| `/memory` | View / edit personal and project memory |
| `/connections` | List connected data sources |
| `/approve` | List and act on pending approvals |
| `/compact` | Manually compact context |

### 6.2 Agent Host & Agent Protocol

#### 6.2.1 Agent Host

- Built on the **Claude Agent SDK** (TypeScript preferred to share types with UI and CLI).
- Responsibilities: session lifecycle, agent loop, tool execution, MCP client, skill loading, memory access, hooks, subagents, context compaction, streaming.
- **Location:**
  - CLI / Desktop → local process on the user's machine (local files, local terminal).
  - Web → server-side container per user/workspace (see 6.3).
- All model calls go through the **Model Gateway**; all external tools through the **MCP/Data Gateway**. The Agent Host holds no provider keys.

#### 6.2.2 Agent Protocol

Transport: WebSocket, JSON-RPC 2.0, versioned schema in `packages/protocol`.

**Client → Host (requests)**

| Method | Description |
|---|---|
| `session.create` | Start a session (workspace, profile, model) |
| `session.resume` | Resume an existing session (enables handoff Desktop ↔ Web for remote hosts) |
| `session.send` | Send a user message / attachments |
| `session.cancel` | Stop current turn |
| `approval.respond` | Approve / reject / edit a pending action |
| `skill.invoke` | Explicitly run a skill |
| `session.compact` | Force context compaction |

**Host → Client (notifications)**

| Event | Description |
|---|---|
| `message.delta` | Streaming text |
| `tool.started` / `tool.completed` | Tool call lifecycle with inputs/outputs (redacted per policy) |
| `approval.required` | Action paused awaiting approval |
| `access.denied` | Blocked action with request-access link |
| `usage.update` | Tokens, cost, budget remaining |
| `session.compacted` | Context summarized |
| `artifact.created` | File, document, chart or report produced |

### 6.3 Workspace Runtime (Web mode)

| Aspect | Specification |
|---|---|
| Isolation | One container per user/workspace on Kubernetes; hardened runtime (gVisor or Kata Containers) |
| Resources | CPU/memory limits per profile; command timeouts |
| Storage | Persistent volume per workspace; snapshots; configurable retention |
| Network | Egress allow-list per policy; no container-to-container traffic |
| Lifecycle | Auto-suspend when idle; resume on reconnect |
| Git | Clone/push using SSO-linked Git provider OAuth (GitHub, GitLab, Bitbucket, Azure DevOps) |
| Terminal | xterm.js in browser ↔ container shell |
| Files | Upload/download via browser; no direct local disk access |

### 6.4 Identity & Access Control

#### 6.4.1 Authentication

- OIDC / SAML with enterprise IdP: **Microsoft Entra ID, Okta, Ping, Keycloak, Google Workspace**.
- CLI: OAuth device code flow. Desktop: system browser + PKCE. Web: standard OIDC.
- Short-lived access tokens; refresh handled by the Control Plane.
- SCIM provisioning for users and groups (optional, recommended).

#### 6.4.2 Authorization Model

```
IdP groups ──► Profile(s) ──► Policy ──┐
                                       ├──► Effective permissions
Admin-assigned Subscriptions ──────────┘    (subscribed AND allowed)
```

Subscriptions decide **which modules a user is licensed for**; policy decides **what they may do inside those modules**. See 6.15.

- **Profile:** named bundle of permissions (e.g., `finance-analyst`, `developer`, `hr-officer`).
- **Policy:** declarative rules evaluated by a policy engine (**OPA** or **AWS Cedar**).
- A user may match several profiles; permissions merge with **deny overrides allow**.
- **Tools the user may not use are never loaded into the agent** (hidden, not merely blocked).

#### 6.4.3 Policy Scope

| Dimension | Examples |
|---|---|
| Models | allowed list, default, residency requirement, personal keys allowed |
| Tools | terminal, file edit, web fetch, code execution |
| Connectors | which MCP servers; read / write / approval per operation |
| Data | tables, schemas, SharePoint sites, DMS cabinets; PII masking; sensitivity labels |
| Skills / Plugins | which skills and packs are available |
| Actions | which actions need approval and by whom |
| Budgets | monthly cost, per-request token caps |
| Workspace | default layout, runtime resources |

#### 6.4.4 Example Policy

```yaml
profile: finance-analyst
match: { groups: ["Finance"] }
models:
  allowed: [vertex/claude-sonnet, azure/gpt-4.1]
  default: vertex/claude-sonnet
  personal_keys: deny
  data_residency: in-country
tools:
  terminal: deny
  file_edit: allow
  web_fetch: allow
connectors:
  billing-db:  { access: read-only, tables: [invoices, payments], replica: true }
  sap-erp:     { read: allow, write: require_approval, approver: manager }
  m365:        { mail: read+draft, send: require_approval, sharepoint: [Finance-Site] }
data:
  mask_pii: true
  block_labels_to_external: [Confidential, Restricted]
skills: [finance/*, common/*]
budget:
  monthly_usd: 200
  per_request_max_tokens: 50000
workspace:
  default_layout: data
audit: full
```

#### 6.4.5 Access Requests

- When an action is blocked, the user gets a **Request access** link (pre-filled with the tool/connector).
- Request routes to the department admin / manager; on approval the policy updates immediately (time-boxed grants supported).

### 6.5 Model Gateway (Bring Your Own Model)

#### 6.5.1 Key Levels

| Level | Added by | Scope |
|---|---|---|
| Organization | Platform admin | Everyone, filtered by policy |
| Department | Department admin | That department |
| Personal | User (if allowed by policy) | That user only |

#### 6.5.2 Supported Providers (initial)

| Provider | Auth |
|---|---|
| Anthropic API (Claude) | API key (vault) |
| Google Vertex AI (Claude, Gemini) | Service account / workload identity federation |
| AWS Bedrock (Claude, others) | IAM role |
| Microsoft Foundry / Azure OpenAI | Entra ID managed identity / key |
| OpenAI | API key |
| Local / self-hosted (Ollama, vLLM, any OpenAI-compatible) | Internal endpoint + token |

**Primary model family:** Claude (best fit with the Claude Agent SDK). Other models are optional; tool-use quality is validated per model through evals before enabling.

#### 6.5.3 Functions

- Policy check per request (user, model, residency, budget).
- Credential retrieval from vault; **keys never reach clients**.
- Normalization to a single internal message format; tool-calling translation between providers.
- **Prompt caching** support passthrough.
- **Model routing:** small/fast model for classification, summarization, titles; larger model for reasoning and code.
- Fallback on provider failure (policy-permitted models only).
- Usage metering: tokens, cost, cache hits — per user, department, model.
- Rate limits and budget enforcement (soft warning → hard stop).

#### 6.5.4 Implementation

- Base on **LiteLLM Proxy** (open source; broad provider coverage, virtual keys, budgets) behind a custom policy layer, or a custom gateway if requirements outgrow it.

### 6.6 MCP / Data Gateway

#### 6.6.1 Functions

- Registry of approved MCP servers (internal and third-party), with versions.
- **Per-call policy enforcement** using the user's token.
- **Identity pass-through:** calls execute as the user (OAuth on-behalf-of, per-user DB roles) so source-system permissions and row-level security apply.
- Result shaping: row limits, pagination, truncation, large results written to files.
- PII masking and sensitivity-label enforcement on results.
- Full audit of each call (who, what, inputs, result size, outcome).
- Transport: MCP over Streamable HTTP for remote servers; stdio for local servers on Desktop/CLI (still policy-checked by hooks).

#### 6.6.2 Database Connectors (initial)

PostgreSQL, Microsoft SQL Server, Oracle, MySQL/MariaDB, Snowflake, BigQuery, Databricks, Teradata (via MCP servers).

Rules:
- **Read-only by default;** write requires explicit policy + approval.
- **Query replicas / reporting DBs** for analytics workloads, never production OLTP by default.
- Query cost/timeout limits.

### 6.7 Productivity & Content Connectors

#### 6.7.1 Coverage

| Category | Systems | API / Protocol | Auth |
|---|---|---|---|
| Microsoft 365 | Outlook mail, calendar, contacts, OneDrive, SharePoint, Teams | Microsoft Graph | Entra ID SSO, on-behalf-of |
| Exchange on-prem | Exchange Server 2016/2019/SE | EWS | Kerberos/NTLM or service account |
| Google Workspace | Gmail, Calendar, Drive, Docs, Sheets | Google Workspace APIs | Per-user OAuth or domain-wide delegation |
| Generic email | Any IMAP/SMTP mailbox (POP3 read-only fallback) | IMAP, SMTP, POP3 | Vault credentials; OAuth2 (XOAUTH2) where supported |
| Cloud storage | Box, Dropbox | REST APIs | OAuth |
| Document management | OpenText, iManage, M-Files, Alfresco, Documentum, NetDocuments | Vendor REST or **CMIS** | Service account or SSO |

> Note: for **Exchange Online** use Microsoft Graph — Microsoft is retiring EWS for Exchange Online starting October 2026. EWS remains for on-prem Exchange.

#### 6.7.2 Common Capability Interface

Skills call provider-independent tools; each provider implements them.

```
mail.search · mail.read · mail.draft · mail.send · mail.move
files.search · files.read · files.upload · files.move · files.share
calendar.list · calendar.create · calendar.update
```

#### 6.7.3 Rules

- Always act **as the user**; results are permission-trimmed by the source.
- **Live access by default.** Optional **indexed mode** (vector search) per data source, admin-enabled, storing ACLs and re-syncing permissions.
- **Extraction pipeline:** PDF, Word, Excel, PowerPoint, .eml/.msg, attachments; **OCR including Arabic**; chunking and size limits.
- **Approval required** for send, delete, move, external share.
- Respect **Microsoft Purview / Google DLP sensitivity labels**.
- Users manage their connections at `/me/connections`; admins control which connectors each department may use.

### 6.8 Skills

#### 6.8.1 Format

Claude-compatible skill folders:

```
skill-name/
  SKILL.md        # name, description (frontmatter) + instructions
  scripts/        # optional executable helpers
  templates/      # optional templates (docx, xlsx, prompts)
  references/     # optional reference material
```

#### 6.8.2 Behavior

- **Progressive disclosure:** only name + description are in context; full content loads when relevant.
- Scopes: **Organization · Department · Team/Project · Personal**.
- Availability governed by policy.

#### 6.8.3 Lifecycle (Skills Library in web console)

Draft → Review → Publish → Version → Deprecate. Usage analytics (invocations, success rate, feedback). Evals attached to skills where applicable.

### 6.9 Memory

| Scope | Content examples | Edited by |
|---|---|---|
| Organization | Company terminology, compliance rules, standards | Platform admin |
| Department | Fiscal calendar, reporting conventions, approval chains | Department admin |
| Project / Workspace | Repo conventions, schema notes, decisions | Team members |
| Personal | Preferences (format, language, depth) | User |

Rules:
- Stored **server-side** (follows the user across surfaces; auditable).
- Agent reads/writes through a memory tool rather than loading everything each turn.
- **Privacy filter:** never store government IDs, card/account numbers, credentials, or sensitive personal attributes.
- Users can view, edit and delete their personal memory at `/me/memory`.

### 6.10 Plugins, Marketplace & Department Packs

#### 6.10.1 Plugin Structure

A plugin bundles any of:
- MCP server definitions (connectors)
- Skills
- Slash commands
- Subagents
- Hooks
- UI panels / workspace layouts
- Policy templates

#### 6.10.2 Internal Marketplace

- Browse, install, update, remove plugins.
- **Admin approval** before a plugin is available to users.
- Policy decides which departments may install which plugins.
- Signed packages; version pinning; changelog.
- Compatible with public Claude skills and MCP servers where licensing permits.

#### 6.10.3 Department Packs

A Department Pack = connectors + skills + agents + default layout + policy template for one department. See [Section 7](#7-department-pack-catalog).

### 6.11 Token & Prompt Optimization

#### 6.11.1 Token Optimization

| Technique | Description |
|---|---|
| Prompt caching | Stable prefix first (base prompt, org memory, tools), dynamic content last |
| Deferred tool loading | Load tool names only; fetch full schemas when needed |
| Context compaction | Automatic summarization of older turns at a threshold |
| Subagents | Large searches in separate context; only conclusions return |
| Model routing | Small model for simple tasks, large for complex |
| Tool output trimming | Row limits, pagination, file outputs for large results |
| Skill progressive disclosure | Full skill loaded only when relevant |

#### 6.11.2 Prompt Assembly

```
Base system prompt (product behavior)            ← cached
+ Organization policy & memory                   ← cached
+ Department profile, skills index               ← cached
+ Tool index (deferred)                          ← cached
+ Project / personal memory
+ Current task and conversation
```

#### 6.11.3 Prompt Registry & Evals

- Version-controlled system prompts per department/profile.
- **Eval suites** per department (golden tasks, expected outputs, rubric scoring).
- Every prompt or model change runs evals before rollout; A/B testing supported.
- Optional request-refinement step that restates vague requests as clear tasks.

### 6.12 Hooks, Approvals & Safety

#### 6.12.1 Hooks

| Hook | Use |
|---|---|
| Pre-tool | Policy check, PII masking of inputs, dangerous command blocking |
| Post-tool | Audit write, output scanning for secrets/PII, label enforcement |
| Pre-model | Redaction of sensitive content before external model calls |
| Session start/end | Load memory, write session summary |

#### 6.12.2 Approval Rules

| Action class | Default |
|---|---|
| Read / search / summarize | Auto |
| Create draft (email, document, ticket) | Auto |
| Send / publish / share externally | User approval |
| Write to business systems (ERP, CRM, HCM) | User + optional manager approval |
| Delete / move data | User approval; manager for bulk |
| Production deploy / config change | Change ticket + CAB/manager approval |
| Network element configuration (NOC) | Only via approved change process; agent drafts the MOP, engineers execute |
| Security containment / response (SOC) | Through SOAR playbooks with analyst approval |
| Customer-facing replies (Care) | Agent-assist drafts; autonomous replies only on channels explicitly approved |
| Regulatory submissions, legal opinions | Human review and sign-off required |
| Payments, hiring decisions, fraud blocking | **Never automated** — AI prepares, human decides |

### 6.13 Web Console

Single web app, same domain and login as the Web IDE.

| Area | Route | Features |
|---|---|---|
| **My Profile** | `/me` | Role, department, **my subscriptions**, allowed models/tools/connectors, usage & budget, personal keys (if allowed), connections, memory, activity history, access & subscription requests |
| **Department Admin** | `/dept` | Team members, **assign subscriptions from dept seat pool**, dept models & keys, dept skills & plugins, budgets, approvals, usage reports |
| **Platform Admin** | `/admin` | **Subscription catalog, seats & assignments**, profiles & policies, SSO/group mapping, model providers, MCP registry, plugin marketplace approvals, prompt registry, audit log, cost dashboards, system health |

IDE integration: deep links (e.g., `/me/usage`, `/me/requests/new?tool=sap-erp`), opened in the system browser (default) or an in-app webview with a one-time login code.

### 6.14 Observability, Audit & Cost

- **Tracing:** OpenTelemetry across surfaces, Agent Host, gateways; LLM tracing (e.g., Langfuse, self-hosted).
- **Audit log (immutable):** logins, prompts (configurable retention/redaction), tool calls, data accessed, approvals, policy changes, admin actions.
- **Usage & cost:** per user / department / model / connector; cache hit rate; chargeback reports.
- **Alerts:** budget thresholds, unusual access patterns, repeated policy denials, provider errors.
- **Export:** SIEM integration (Splunk, Sentinel, QRadar) via syslog/HTTP.

### 6.15 Subscriptions & Licensing

#### 6.15.1 Principles

- **Every module is a subscription.** A customer organization buys subscriptions (seats) per module.
- **Admins assign subscriptions to users** (Platform Admin, or Department Admin within their department's seat pool).
- **One user can hold multiple subscriptions** (e.g., a Release Manager with `Core` + `Code Workspace` + `Technology – Release Mgmt Pack` + `Microsoft 365 Pack`).
- **Effective access = subscribed AND permitted by policy.** A subscription never bypasses policy; policy never grants a module the user is not subscribed to.
- Unsubscribed modules are **hidden** from the user (not shown as errors), except an optional "Discover / Request" view.

#### 6.15.2 Subscription Catalog (initial)

| Category | Subscription (module) | Unlocks |
|---|---|---|
| **Base** | **Core** (mandatory for every user) | Chat workspace, CLI/Desktop/Web access, personal memory, `/me` console, common skills |
| **Workspaces** | Code Workspace | Monaco, terminal, git, code skills, web sandbox for code |
| | Data Workspace | SQL editor, results grid, charts, DB connectors |
| | Docs Workspace | Document editor/preview, extraction, export (docx/xlsx/pdf) |
| **Connector packs** | Microsoft 365 Pack | Outlook, Calendar, OneDrive, SharePoint, Teams |
| | Google Workspace Pack | Gmail, Calendar, Drive, Docs/Sheets |
| | Email (IMAP/POP/Exchange) Pack | Legacy and on-prem mailboxes |
| | Document Management Pack | OpenText, iManage, M-Files, Alfresco, CMIS |
| | Database Connectors Pack | Oracle, SQL Server, Postgres, Snowflake, BigQuery, … |
| **Department packs** | Technology – IT Service Mgmt / Demand / PMO / Release / Architecture / Testing | Per-function skills, agents, connectors |
| | Product Management Pack | Product skills and connectors |
| | Marketing Pack | Campaign, content, brand skills |
| | Procurement Pack | RFP, vendor, contract skills |
| | Planning Pack | EPM, forecasting, KPI skills |
| | HR Pack | HCM connectors, HR skills (T3 controls) |
| | Finance – Revenue Accounting / Revenue Assurance / Fraud / AP-AR-Treasury | Finance skills, connectors (T2/T3 controls) |
| | Legal Pack | CLM, DMS, e-signature connectors; contract & legal skills |
| | Compliance & Regulatory Pack | GRC connectors; regulatory tracking & policy skills |
| | Internal Audit Pack | Audit management connectors; audit skills (T3 controls) |
| | Enterprise Risk Pack | GRC/risk register connectors; risk & KRI skills |
| | Customer Care Pack | CRM, ticketing, contact center connectors; agent-assist skills |
| | Sales & B2B Pack | CRM, CPQ connectors; pipeline, proposal & quote skills |
| | Network Operations (NOC) Pack | OSS/fault/performance connectors; NOC skills (read-only) |
| | Security Operations (SOC) Pack | SIEM, SOAR, EDR connectors; SOC skills (T3 controls) |
| **Platform add-ons** | Advanced Models | Access to premium/large models beyond the Core default |
| | Indexed Enterprise Search | Vector search across document sources with ACL sync |
| | Automation & Scheduled Agents | Scheduled/background agent runs, CI/CLI automation |
| | Custom Skills & Plugin Authoring | Create and publish department/org skills and plugins |
| **Admin** | Department Admin | `/dept` console for a department |
| | Platform Admin | `/admin` console (usually included, not seat-billed) |

The catalog is **data-driven**: new modules (e.g., Telecom Edition, Legal Pack) are added by registering a subscription plan, not by code changes.

#### 6.15.3 Plan Properties

| Property | Description |
|---|---|
| `plan_id`, name, category | Identity of the module |
| `includes` | Workspaces, connectors, skills, plugins, features the plan unlocks |
| `requires` | Dependencies (e.g., all plans require `Core`; `Finance – RA Pack` requires `Data Workspace`) |
| `billing` | Per seat / month or year; optional usage allowance (tokens, sandbox hours) |
| `usage_allowance` | Included tokens or credits per seat; overage rules |
| `term` | Start, end, auto-renew, trial flag |
| `seats_purchased` | Seat count for the organization |
| `min_sensitivity_controls` | Tier defaults the plan enforces (e.g., HR Pack forces T3) |

#### 6.15.4 Assignment

| Method | Description |
|---|---|
| Manual | Admin assigns/unassigns plans to a user in the console |
| Bulk | CSV upload or multi-select in the console |
| Group-based (auto) | Rule: "members of IdP group `Finance-RA` get `Core` + `Data Workspace` + `Finance – RA Pack`" |
| Request-based | User requests a module from `/me/subscriptions`; approver (dept admin/manager) approves; seat assigned if available |
| Trial | Time-boxed assignment (e.g., 14 days) that expires automatically |

Rules:
- Seat pool per plan per organization; optional **department seat allocations**.
- Cannot assign beyond purchased seats (configurable: block, or allow overage with alert).
- Dependencies auto-checked (`requires`); assigning a pack prompts to add missing prerequisites.
- Unassigning revokes access at the next request; running sessions are notified and the module's tools unload.
- All assignment changes are audited.

#### 6.15.5 Enforcement

- The Control Plane issues an **entitlement claim** (list of active plans) with each session; entitlements are cached with short TTL and re-checked by gateways.
- **Agent Host** loads only workspaces, skills, plugins and tools from entitled plans.
- **Model Gateway** checks model tier entitlement (e.g., Advanced Models) and usage allowance.
- **MCP/Data Gateway** checks connector entitlement before policy evaluation.
- **UI** hides unentitled workspaces and menus; `/me/subscriptions` shows what the user has and what they can request.

#### 6.15.6 Console Features

| Console | Features |
|---|---|
| `/me/subscriptions` | My active subscriptions, expiry dates, usage vs allowance, request additional modules |
| `/dept/subscriptions` | Department seat allocations, assign/unassign within pool, pending requests, utilization |
| `/admin/subscriptions` | Plan catalog, purchased seats, org-wide assignments, group rules, trials, renewals, utilization and unused-seat reports, billing export |

#### 6.15.7 Billing & Reporting

- Seat utilization (assigned vs active users), unused seats, per-department chargeback.
- Usage-based overage (tokens, sandbox hours) per plan.
- Export to ERP/billing (CSV/API); invoice data per organization.
- For the vendor (SaaS mode): tenant-level license keys, plan catalog management, entitlement sync to on-prem installs (signed license file for air-gapped sites).

---

## 7. Department Pack Catalog

### 7.1 Technology

| Function | Systems to connect | Skills / Agents | Special controls |
|---|---|---|---|
| IT Service Management | ServiceNow, Jira Service Mgmt, ManageEngine, Entra/AD, Splunk, Dynatrace, Grafana | Ticket triage & routing, incident summaries, root-cause analysis from logs, KB article generation | No production changes without change ticket + approval |
| Demand Management | ServiceNow SPM, Jira, Azure DevOps, Clarity PPM, intake forms | Demand → BRD draft, duplicate detection, effort estimation, prioritization scoring | — |
| Project Management | MS Project, Jira, Smartsheet, Primavera, Teams | Status reports, RAID logs, schedule-risk alerts, minutes → action items | — |
| Release Management | Jira, Azure DevOps, GitLab/Jenkins, ServiceNow Change | Release notes, CAB pack, change risk assessment, go/no-go checklist | Deploy actions always approval-gated |
| Solution Design & Architecture | Confluence, Sparx EA, LeanIX/Ardoq, draw.io, TM Forum Open APIs | HLD/LLD drafts, ADRs, TOGAF artifacts, design review vs standards, diagram generation | — |
| Testing / QA | Jira + Xray/Zephyr, TestRail, ALM, Postman, Playwright/Selenium | Test cases from requirements, test data generation, automation scripts, defect triage, traceability matrix | Synthetic or masked test data only |
| Development | Git, CI/CD, IDE | Code workspace (edit, refactor, review, test, explain) | Branch protection respected; no direct push to protected branches |

### 7.2 Business Functions

| Department | Systems to connect | Skills / Agents | Special controls |
|---|---|---|---|
| Product Management | Jira Product Discovery, Productboard, Aha, analytics (GA/Mixpanel), BSS product catalog | PRDs, competitor analysis, tariff/offer design, feedback synthesis, prioritization | — |
| Marketing | Salesforce Marketing Cloud, HubSpot, Adobe, CMS, DAM, Meta/Google Ads, social tools | Campaign briefs, bilingual Arabic/English content, brand-voice checks, segment analysis, performance reports | No publishing without brand approval |
| Procurement | SAP Ariba, Oracle Procurement, Coupa, contract repository | RFP/RFQ drafting, vendor comparison, bid evaluation matrix, clause review, spend analysis | Bid isolation per tender; conflict-of-interest checks |
| Planning | Oracle EPM, SAP BPC, Anaplan, Power BI | Budget vs actual variance, forecast scenarios, business cases, KPI packs | Draft figures labeled until approved |
| HR | SuccessFactors, Oracle HCM, Workday, ATS, LMS | JD writing, CV screening support, policy Q&A, onboarding & training plans | Strictest PII masking; salary data restricted; no automated hiring decisions; bias checks |

### 7.3 Finance

| Function | Systems to connect | Skills / Agents | Special controls |
|---|---|---|---|
| Revenue Accounting | SAP/Oracle ERP, billing (BSS), GL | IFRS 15 support, reconciliations, journal explanations, month-end close checklist | ERP read-only; postings need approval |
| Revenue Assurance | Mediation, rating & billing, CDR/usage data, RA tools (Subex, Mobileum) | Usage vs billing reconciliation, leakage detection, rate-plan config audit, control KPIs, investigation reports | Read-only; replicas only |
| Fraud Management | FMS (Subex, Mobileum), CDR analytics, SIM registration / KYC | Anomaly investigation (SIM box, IRSF, Wangiri, subscription fraud), case summaries, rule-tuning suggestions | Highest sensitivity; isolated case data; full audit; no automated customer blocking |
| AP / AR / Treasury / Tax | ERP, bank portals, e-invoicing | Invoice matching, collections drafts, cash position reports, VAT support | Payments always require human approval |

### 7.4 Legal, Risk & Governance

| Department | Systems to connect | Skills / Agents | Special controls |
|---|---|---|---|
| Legal | Contract lifecycle management (Icertis, Ironclad, DocuSign CLM, SAP Ariba Contracts), DMS (iManage, NetDocuments), e-signature (DocuSign, Adobe Sign), legal research sources | Contract review vs. playbook, clause extraction & comparison, redlining suggestions, NDA triage, obligation & renewal tracking, legal memo drafts | Privileged content isolated per matter; no external sharing without approval; AI output marked as draft, never legal advice to customers |
| Compliance & Regulatory | Regulatory portals and circulars (e.g., CRA Qatar, QCB for fintech services), GRC platforms (ServiceNow GRC, Archer, MetricStream), policy repository | Regulatory change tracking & impact analysis, obligation registers, policy drafting & gap analysis, compliance evidence collection, regulator response drafts | Every regulatory submission human-approved; full audit trail of sources used |
| Internal Audit | Audit management (TeamMate+, AuditBoard, Archer), ERP/BSS read access, DMS | Audit planning, risk-based sampling, control testing scripts, workpaper drafting, findings & management-response tracking | Read-only everywhere; auditor independence (no edits to auditee data); evidence immutability |
| Enterprise Risk Management | GRC platforms, risk registers, KRI data sources, BI | Risk register maintenance, KRI monitoring & alerts, risk assessment workshops prep, board/committee risk reports | Board-level reports approval-gated |

### 7.5 Customer & Commercial

| Department | Systems to connect | Skills / Agents | Special controls |
|---|---|---|---|
| Customer Care / Contact Center | CRM (Salesforce Service Cloud, Microsoft Dynamics, Siebel), ticketing, contact center platforms (Genesys, Avaya, Cisco, Zoom Contact Center), call transcripts, knowledge base, BSS (billing, orders) | Case/ticket summarization, next-best-action, reply drafts (Arabic/English), complaint root-cause & trend analysis, call transcript QA, knowledge article generation | Customer PII masked; agent-assist only (no autonomous customer replies unless approved per channel); KYC data read-only |
| Sales / Enterprise B2B | CRM (Salesforce Sales Cloud, Dynamics 365), CPQ, product catalog, pricing tools, tender portals | Pipeline review & forecast notes, account research briefs, proposal & RFP response generation, quote support, win/loss analysis, meeting prep | Pricing/discount approvals follow commercial authority matrix; customer data scoped to account owners |

### 7.6 Operations & Security

| Department | Systems to connect | Skills / Agents | Special controls |
|---|---|---|---|
| Network Operations (NOC) | OSS / fault management (e.g., Nokia NetAct, Ericsson ENM, Huawei U2000/iMaster), performance management, inventory, trouble ticketing (ServiceNow, Remedy), TM Forum Open APIs | Alarm correlation & summarization, trouble-ticket enrichment, probable root-cause, MOP (method of procedure) drafting, capacity & utilization reports, shift handover notes | **Read-only on network elements**; any configuration change only via approved change process; no direct element commands from the agent |
| Information Security (SOC) | SIEM (Splunk, Microsoft Sentinel, QRadar), SOAR, EDR (Defender, CrowdStrike), threat intel feeds, vulnerability scanners | Alert triage & enrichment, incident timelines, threat-intel summaries, detection rule suggestions, vulnerability prioritization, incident reports | Restricted tier; containment/response actions only through SOAR playbooks with analyst approval; security data never sent to non-approved models |

### 7.7 Data Sensitivity Tiers

| Tier | Departments | Defaults |
|---|---|---|
| **T1 — Standard** | Marketing, Product, PMO, Technology (non-prod), Sales (non-customer content) | Normal logging, standard models |
| **T2 — Confidential** | Procurement, Planning, Finance (general), Legal, Compliance, Enterprise Risk, Sales (customer/pricing data), NOC | PII masking, in-region models, approval on external actions |
| **T3 — Restricted** | HR, Revenue Assurance, Fraud, Information Security (SOC), Internal Audit, Customer Care (customer PII/KYC) | Isolated data, replicas only, strict masking, in-country/local models, full audit, no personal keys |

---

## 8. Security, Privacy & Compliance

| Area | Requirement |
|---|---|
| Authentication | SSO only; MFA enforced by IdP; no local passwords |
| Secrets | All credentials in a vault (HashiCorp Vault, Azure Key Vault, GCP Secret Manager, AWS Secrets Manager); never on clients or in prompts |
| Encryption | TLS 1.2+ in transit; AES-256 at rest; customer-managed keys (option) |
| Data residency | In-country hosting option (e.g., Azure Qatar Central, Google Cloud Doha); model endpoints restricted by policy to approved regions — **model availability per region must be verified** |
| PII | Detection & masking before external model calls and in outputs (Arabic + English entity support) |
| DLP | Respect Microsoft Purview / Google DLP labels; block labeled content to non-approved destinations |
| Isolation | Per-user sandboxes (web); per-tenant data separation (SaaS mode) |
| Least privilege | Read-only defaults; hidden tools; time-boxed grants |
| Audit | Immutable, exportable to SIEM; retention configurable (1–7 years) |
| Prompt injection | Treat tool/connector content as untrusted data; hooks scan for injected instructions; high-risk actions always approval-gated |
| Supply chain | Signed plugins; admin approval; MCP server allow-list; dependency scanning |
| Compliance targets | ISO 27001, SOC 2 Type II readiness; alignment with local data-protection law (e.g., Qatar PDPPL) and sector regulators |

---

## 9. Deployment Models

| Model | Description | Best for |
|---|---|---|
| **SaaS (multi-tenant)** | Hosted by vendor; tenant isolation | SMEs, fast adoption |
| **Dedicated cloud (single-tenant)** | Customer's own cloud subscription / region | Mid-large enterprises needing residency |
| **On-premises** | Kubernetes in customer data center | Government, telecom, banks |
| **Air-gapped** | On-prem + local models only (vLLM/Ollama) | Highly restricted environments |

Packaging: Helm charts, container images, Terraform modules for major clouds.

---

## 10. Technology Stack

### 10.1 Frontend (Web + Desktop)

| Layer | Choice |
|---|---|
| Language / build | TypeScript, Vite, React |
| Styling / components | Tailwind CSS, shadcn/ui (Radix) |
| IDE layout | Dockview |
| Code editor | Monaco (incl. diff editor) |
| Terminal | xterm.js |
| AI chat UI | assistant-ui or Vercel AI SDK UI; Streamdown for streaming markdown |
| Data grids | TanStack Table (light), AG Grid (heavy) |
| Charts | ECharts or Recharts |
| Command palette | cmdk |
| State / data | Zustand, TanStack Query |
| Routing | TanStack Router |
| i18n / RTL | i18next, logical CSS properties |
| Desktop shell | Electron (node-pty for terminals) |

### 10.2 CLI

| Layer | Choice |
|---|---|
| Terminal UI | Ink (React for terminal), TypeScript |
| Shared | `packages/protocol`, `packages/auth` |

### 10.3 Backend

| Component | Choice |
|---|---|
| Agent Host | Claude Agent SDK (TypeScript) |
| Control Plane API | TypeScript (Fastify/NestJS) or Python (FastAPI) — see Open Questions |
| Policy engine | OPA or AWS Cedar |
| Model Gateway | LiteLLM Proxy + custom policy layer |
| MCP/Data Gateway | Custom service (MCP Streamable HTTP) |
| Database | PostgreSQL (+ pgvector for optional indexing) |
| Cache / queues | Redis |
| Object storage | S3-compatible (S3, Azure Blob, GCS, MinIO) |
| Secrets | HashiCorp Vault or cloud KMS/secret managers |
| Runtime | Kubernetes; gVisor/Kata for web sandboxes |
| Observability | OpenTelemetry, Prometheus, Grafana, Langfuse |
| Document extraction | Apache Tika / Unstructured, OCR with Arabic support |

### 10.4 Repository Structure

```
/apps
  web/          Vite SPA: /ide, /me, /dept, /admin
  desktop/      Electron wrapper + local Agent Host
  cli/          Ink terminal app
/packages
  ui/           Design system: tokens, components, themes, RTL
  workbench/    IDE shell: Dockview, Monaco, xterm, chat, command palette
  views/        Workspaces: Code, Data, Docs, Chat, Approvals
  protocol/     Typed Agent Protocol client/server schema
  auth/         OIDC/SSO helpers
  sdk/          Plugin & skill authoring SDK
/services
  agent-host/       Agent Host (local + server modes)
  control-plane/    Profiles, policies, skills, plugins, memory, approvals, audit API
  model-gateway/    LiteLLM + policy
  mcp-gateway/      MCP/Data gateway
  workspace-runtime/ K8s sandbox manager
  extraction/       Document extraction & OCR
/packs
  technology/ finance/ hr/ procurement/ marketing/ product/ planning/ productivity/
  legal/ compliance/ audit/ risk/ customer-care/ sales/ noc/ soc/
/deploy
  helm/ terraform/ docker/
```

Tooling: pnpm workspaces, Turborepo, Vitest/Playwright, ESLint/Prettier, GitHub Actions or GitLab CI.

---

## 11. Core Data Model

| Entity | Key fields |
|---|---|
| Organization | id, name, residency, settings |
| Department | id, org_id, name, sensitivity_tier |
| User | id, org_id, idp_subject, email, department_id, locale |
| Group | id, idp_group_id, name |
| Profile | id, name, match_rules, policy_ref, default_layout |
| Policy | id, version, document (YAML/Cedar/Rego), status |
| ModelProvider | id, scope (org/dept/user), type, endpoint, credential_ref, regions |
| Credential | id, vault_path, owner_scope (secret never stored in DB) |
| Connector | id, type, mcp_endpoint, version, status |
| ConnectorBinding | id, connector_id, scope, permissions |
| UserConnection | id, user_id, connector_id, token_ref, status |
| Skill / SkillVersion | id, scope, name, description, content_ref, version, status |
| Plugin / PluginVersion | id, name, components, signature, version, approval_status |
| DepartmentPack | id, department, plugin_ids, policy_template, layout |
| MemoryEntry | id, scope (org/dept/project/user), owner, content, updated_at |
| Workspace | id, user_id, type, runtime_ref, storage_ref |
| Session | id, user_id, workspace_id, model, started_at, status |
| ApprovalRequest | id, session_id, action, payload_ref, approver, status |
| AccessRequest | id, user_id, resource, justification, approver, status, expires_at |
| AuditEvent | id, ts, actor, action, resource, outcome, trace_id |
| UsageRecord | id, user_id, dept_id, model, tokens_in/out, cache_hits, cost |
| Budget | id, scope, period, limit, soft/hard |
| PromptVersion | id, profile/department, content_ref, eval_score, status |
| SubscriptionPlan | id, name, category, includes, requires, billing, usage_allowance, sensitivity_defaults |
| OrgSubscription | id, org_id, plan_id, seats_purchased, term_start, term_end, auto_renew, trial |
| SeatAllocation | id, org_subscription_id, department_id, seats |
| UserSubscription | id, user_id, org_subscription_id, assigned_by, method (manual/group/request/trial), start, end, status |
| AssignmentRule | id, org_id, idp_group_id, plan_ids, active |
| SubscriptionRequest | id, user_id, plan_id, justification, approver, status |

---

## 12. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Availability | Control plane & gateways 99.9% (SaaS); HA deployment option on-prem |
| Latency | Gateway overhead p95 < 100 ms; first streamed token dominated by model latency |
| Scale | 5,000 concurrent users per deployment (initial target); horizontal scaling of gateways and runtimes |
| Web runtime | Workspace cold start < 15 s; resume < 5 s |
| Security | See Section 8; annual penetration test |
| Accessibility | WCAG 2.1 AA |
| Localization | English + Arabic (RTL) at launch |
| Extensibility | New providers, connectors, skills, packs added by registration, not core changes |
| Recoverability | RPO ≤ 15 min, RTO ≤ 4 h for control plane data |
| Observability | 100% of tool calls and model calls traced and audited |

---

## 13. Delivery Roadmap

### Phase 0 — Foundations (≈4 weeks)
- Monorepo, CI, design system basics.
- SSO login (OIDC), control plane skeleton, Postgres schema.
- Agent Host on Claude Agent SDK (local mode).
- CLI with login, chat, one model provider.

### Phase 1 — MVP (≈8–12 weeks)
- Desktop + Web with **Chat** and **Code** workspaces.
- Model Gateway (LiteLLM): Claude via Anthropic / Vertex / Bedrock; one local model.
- MCP/Data Gateway with 3 DB connectors (Postgres, SQL Server, Oracle).
- Policy engine, profiles, approvals, audit log.
- **Subscriptions v1:** plan catalog, seats, manual + group-based assignment, entitlement enforcement in Agent Host and gateways.
- Web console: `/me` (profile, subscriptions, usage, connections) and `/admin` (subscriptions, profiles, providers, audit).
- Skills library v1, memory v1 (personal + org).
- **One pilot department pack** (recommended: Technology or Revenue Assurance).

### Phase 2 — Productivity & Web Scale (≈8 weeks)
- Productivity & Content pack: M365 (Graph), Google Workspace, IMAP/SMTP, Exchange (EWS), SharePoint/OneDrive/Drive.
- Web Workspace Runtime (K8s sandboxes), **Data** and **Docs** workspaces.
- Plugin marketplace with admin approval; department admin (`/dept`) with department seat pools; budgets.
- Subscription requests, trials, utilization reports, billing export.
- Document extraction pipeline incl. Arabic OCR.

### Phase 3 — Department Packs & Quality (≈10–12 weeks)
- Packs (wave 1): Technology suite, Finance (Revenue Accounting, RA, Fraud), HR, Procurement, Marketing, Product, Planning.
- Packs (wave 2): Customer Care, Sales & B2B, Legal, Compliance & Regulatory.
- DMS connectors (OpenText, iManage, M-Files, CMIS).
- Optional indexed search with ACL sync.
- Prompt registry, eval suites, A/B testing.
- Access-request workflow with time-boxed grants.

### Phase 4 — Enterprise Hardening & Editions
- On-prem and air-gapped packaging; HA.
- DLP label enforcement (Purview / Google), SIEM export.
- ISO 27001 / SOC 2 readiness.
- **Telecom Edition** (BSS/OSS, CDR analytics, TM Forum APIs).
- Packs (wave 3): Network Operations (NOC), Security Operations (SOC), Internal Audit, Enterprise Risk.
- Multi-tenant SaaS.

---

## 14. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Crowded market (Claude apps, ChatGPT Enterprise, Copilot Studio, Glean, Dust) | High | Focus on sovereign/on-prem, identity-driven governance, department packs, telecom edition |
| Dependency on Claude Agent SDK and vendor terms | Medium | Review Anthropic commercial terms early; keep Agent Host behind the Agent Protocol so the engine can be swapped |
| Multi-model tool-use quality varies | Medium | Claude as primary; eval-gate other models per department |
| Prompt injection via emails/documents | High | Untrusted-content handling, hooks, approval gates on all side-effecting actions |
| Data leakage to external models | High | Residency policies, PII masking, label enforcement, local-model option for T3 data |
| Connector breadth takes long | Medium | Reuse existing MCP servers; prioritize by pilot customer |
| Cost overruns (tokens) | Medium | Caching, routing, compaction, budgets, per-department chargeback |
| User adoption in non-tech departments | Medium | Web-first, department layouts, ready-made skills, training |
| Regional model availability | Medium | Verify per region; support local/self-hosted models |

---

## 15. Open Questions

1. **Brand assets:** logo, color palette, typography for **Ralysa**; trademark clearance.
2. **Business model:** product sold to many enterprises vs. internal platform for one organization? (Affects multi-tenancy, licensing, on-prem packaging in v1.)
3. **Control plane language:** TypeScript (shared types with UI/CLI/Agent Host) vs. Python (closer to LiteLLM and data tooling). *Recommendation: TypeScript for Agent Host and control plane; Python only where libraries require it.*
4. **Anthropic commercial terms** for embedding the Claude Agent SDK in a resold product.
5. **Pilot department and pilot customer** for Phase 1.
6. **Policy engine:** OPA (Rego) vs. Cedar.
7. **Pricing per subscription:** list prices per module, bundle discounts (e.g., "Finance Suite"), included usage allowance vs. pure usage-based overage, annual vs. monthly terms.
8. **Seat model:** named-user seats only, or also concurrent/pooled seats for occasional users?
9. **Indexed search:** in scope for v1 or deferred?
10. **Mobile:** responsive web only, or native apps later?

---

## 16. Glossary

| Term | Meaning |
|---|---|
| Agent Host | Process running the agent loop (local or server sandbox) |
| Agent Protocol | Typed WebSocket/JSON-RPC protocol between UI surfaces and Agent Host |
| MCP | Model Context Protocol — standard for connecting AI agents to tools and data |
| Skill | Folder with instructions/scripts the agent loads on demand |
| Plugin | Installable bundle of connectors, skills, commands, subagents, hooks, UI |
| Department Pack | Plugin set + policy template + layout for one department |
| Profile | Named permission bundle mapped from IdP groups |
| Hook | Code executed before/after tool or model calls (policy, masking, audit) |
| Compaction | Automatic summarization of long context |
| OBO | On-behalf-of token exchange so services act as the user |
| RA | Revenue Assurance |
| BSS / OSS | Business / Operations Support Systems (telecom) |
| CDR | Call Detail Record |
| CMIS | Content Management Interoperability Services (DMS standard) |
| EWS | Exchange Web Services |
| Subscription | A licensed module (workspace, connector pack, department pack, add-on) assigned to a user |
| Entitlement | The set of active subscriptions a user holds, enforced at runtime |
| Seat | One unit of a subscription that can be assigned to one user |

---

*End of document — v0.3 draft.*
