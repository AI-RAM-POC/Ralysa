---
name: implement
description: ADLC phase 5 - implement an approved feature design on a feature branch with tests, self-review via code-reviewer, and open a PR. Use when the user asks to build/implement/code a feature that has a design.
argument-hint: "F-nnn [task id, e.g. T03]"
disable-model-invocation: true
---

# Phase 5: Implement $ARGUMENTS

1. Open `docs/features/<F-nnn>-*/design.md`. **Stop** if the G4 approval is empty, unless the user explicitly overrides.
2. Make sure the working tree is clean, then create or check out `feat/<F-nnn>-<slug>` from an up-to-date `main`.
3. Launch the **developer** agent with the design and the task scope (the given task, or all tasks in order). Tasks that don't depend on each other and touch different packages can run as parallel developer agents in separate worktrees.
4. Launch the **code-reviewer** agent on `git diff main...HEAD`. Blocker or Major findings go back to the developer agent. Repeat, up to 3 rounds, until the verdict is Approve or Approve with nits.
5. Run `pnpm lint && pnpm test && pnpm build` yourself and keep the real output.
6. Ask the user before pushing and opening the PR. Once they say yes, push and run `gh pr create`, filling in `.github/pull_request_template.md` with F-nnn, the REQs, the design link, the test evidence and the reviewer verdict.
7. Update `status.md` to phase **5 – Development (PR open, awaiting G5)** and report the PR link. G5 is approved by the human PR reviewer. Next step: `/test <F-nnn>`.
