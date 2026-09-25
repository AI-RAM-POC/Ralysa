# ADR-0020: Web sandbox isolation (gVisor/Kata via RuntimeClass) and orchestration (agent-sandbox with warm pools)

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Architect (proposal); Tech lead (G3)
- **Related:** spec §6.3, §8 Isolation, §12 Web runtime; REQ-013, REQ-014, REQ-096; DV-16; F-016, F-024; `docs/architecture/workspace-runtime.md`

## Context & forces

- Web users run the Agent Host server-side. From Phase 2 it also runs user and agent-generated code (shell, git, toolchains). The code and the content the agent reads are untrusted (prompt injection).
- NFRs: cold start p95 < 15 s, resume p95 < 5 s. Isolation: no cross-sandbox access. Egress: allow-list with audited denials.
- The runtime must work on AKS, GKE and EKS in Gulf regions, on customer on-prem Kubernetes, and air-gapped, often **without nested virtualization**.
- Small team: building a custom sandbox controller is expensive.
- Lock-in: avoid a design that works only on one cloud's managed feature.

## Options considered

**Isolation runtime**

| Criterion | A. runc + hardening (seccomp, AppArmor, non-root) | B. gVisor (`runsc`) | C. Kata Containers (VM per pod) | D. Firecracker microVMs outside Kubernetes |
|---|---|---|---|---|
| Kernel isolation | Shared host kernel; weakest | User-space kernel intercepts syscalls | Separate guest kernel | Separate guest kernel |
| Needs nested virtualization or bare metal | No | No (systrap platform)[^gvisor] | Yes: AKS needs Gen2 sizes with nested virtualization[^aks]; AWS nested virtualization only on C8i/M8i/R8i[^aws] | Yes |
| Managed offering | n/a | GKE Sandbox[^gke] | AKS Pod Sandboxing[^aks] | None in K8s |
| Syscall and IO compatibility | Full | Good, some IO overhead | Near full; IOPS caveats on AKS[^aks] | Full |
| On-prem / air-gapped | Yes | Yes | Hardware-dependent | Needs a custom platform |
| Fit with the spec (§6.3 names gVisor or Kata) | No | Yes | Yes | No |

**Orchestration**

| Criterion | E. kubernetes-sigs **agent-sandbox** CRDs | F. Custom controller | G. Plain StatefulSet per user |
|---|---|---|---|
| Warm pools | `SandboxWarmPool`; assignment "typically <1s" per GKE docs[^gke-as] | Build it | No |
| Pause/resume, persistent storage, stable identity | Yes[^k8s-as] | Build it | Partial |
| Maturity | v1beta1 API, upstream SIG Apps, v1.0.x releases[^k8s-as] | Ours to maintain | Stable but insufficient |
| Portability | Generic Kubernetes; GKE adds managed extras | Full | Full |

## Decision

1. Sandboxes run under a Ralysa-named **RuntimeClass `ralysa-sandbox`** that maps per platform to **gVisor by default** (GKE Sandbox; self-installed `runsc` on EKS, on-prem and air-gapped) or **Kata** where the platform offers it and the customer prefers VM isolation (AKS Pod Sandboxing). An admission policy rejects sandbox pods that do not use this class.
2. Orchestrate with **kubernetes-sigs agent-sandbox** (`Sandbox`, `SandboxTemplate`, `SandboxClaim`, `SandboxWarmPool`) behind the `services/workspace-runtime` Sandbox Manager API, so the CRDs never leak into other services.

gVisor is the only option that gives kernel-level isolation on every target, including VMs without nested virtualization and air-gapped hardware. Kata stays available through the same RuntimeClass indirection. agent-sandbox provides warm pools and pause/resume, which the latency NFRs need, without a custom controller.

## Consequences

- Positive: one runtime abstraction across clouds and on-prem. Warm pools make the < 15 s cold start realistic (design target ≤ 5 s). No custom controller in Phase 2.
- Negative / risks: gVisor IO and syscall overhead for heavy builds; some toolchains may hit unsupported syscalls, so a compatibility test suite is needed. agent-sandbox is beta, so API changes are possible; the Sandbox Manager API absorbs them. Kata on AKS rounds CPU up to whole vCPUs and uses fixed VM memory, which raises cost.
- What would make us revisit: agent-sandbox stalls or breaks compatibility; the gVisor compatibility suite fails for pilot toolchains; security review requires VM isolation for T3 on every platform (then Kata-only, with hardware constraints); Phase 1 benchmarks show resume > 5 s that pause/resume cannot fix.

## References

All accessed 2026-09-25.

[^gvisor]: https://gvisor.dev/docs/architecture_guide/platforms/
[^gke]: https://docs.cloud.google.com/kubernetes-engine/docs/concepts/sandbox-pods
[^gke-as]: https://docs.cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox
[^k8s-as]: https://github.com/kubernetes-sigs/agent-sandbox
[^aks]: https://learn.microsoft.com/en-us/azure/aks/use-pod-sandboxing
[^aws]: https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual

Also: Kubernetes RuntimeClass, https://kubernetes.io/docs/concepts/containers/runtime-class/

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
