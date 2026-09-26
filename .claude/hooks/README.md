# Claude Code hooks

> Source: [F-001 design](../../docs/features/F-001-engineering-design-foundations/design.md) §6.3 (D-4; SEC-F001-10, -11, -12, -28 to -31). **Human-merge path:** an agent must not merge a change to anything under `.claude/`.

## `guard-bash.mjs`

A `PreToolUse` hook on the Bash tool, registered in `.claude/settings.json`. It is layer 2 behind the settings allow and deny lists: it parses each command (quotes, `;` `&&` `||` `|`, here-documents, wrappers such as `env`, `timeout` and `pnpm exec`) and blocks the forms the standing authorization forbids. Exit 0 hands the command back to the normal permission flow; exit 2 blocks it and tells the agent why, with the rule id in brackets:

| Rule | Blocks |
|---|---|
| parse | substitution, `eval`, `sh -c`, `xargs`, variables or globs in command position, `GIT_*`/`GH_*`/`TURBO_*`/`HOME` assignments, `source`, `sudo`, git aliases, inline interpreter code that mentions git/gh/push/merge/release |
| G-1 to G-5 | force, rewrite, mirror and prune pushes; any push that would update `main`; remote deletions; remotes other than `origin`, `--tags`, `--no-verify`, `--repo`, `--receive-pack`, `-o`; release-tag pushes that aren't one annotated `refs/tags/vX.Y.Z[-rc.N]` on `origin/main` with its release record and not yet on origin |
| G-7 | `git commit --no-verify` / `-n` |
| G-8 | `git diff/log/show --output`, `--ext-diff`, `--textconv` |
| G-9 | git config writes to aliases, remotes, URLs, credentials, push, includes, pagers, `core.hooksPath` (except `.githooks`); `git remote add/set-url/rename`, `send-pack`, `http-push`, `credential` |
| H-1 | `gh -R/--repo` naming another repository |
| H-2 | `gh pr merge` unless: `<n> --squash --match-head-commit <sha>`, open, not draft, into `main`, head matches, every check in `origin/main:.github/required-checks.json` passed and none failed or pending, the `code-reviewer: APPROVED head=<sha>` comment (plus `protected-paths-reviewed` for CODEOWNERS paths), and no human-merge path among the files git lists for the PR |
| H-3 | `gh api` other than a GET (no `-X`, `-f`, `-F`, `--input`, `graphql`, method-override header) |
| H-4 | any gh command outside the allow-list: `pr create/view/list/diff/checks/comment/merge`, `issue list/view/create/comment`, `run list/view/watch`, `api`, `auth status`, `repo view`, `release view/list/create --verify-tag` |
| P-1, P-2, P-3 | `publish`, `approve-builds`, `login`, `config set`, `npm token`, `--dangerously-allow-all-builds`; Turbo remote cache and tokens; `npx`, `pnpm dlx`, `npm exec`, and `pnpm exec` of anything but turbo, playwright, vitest, prettier, eslint |

Human-merge paths (H-2): `.claude/**`, any `CLAUDE.md`, `CODEOWNERS` (`.github/`, root, `docs/`), `.github/required-checks.json`, `.github/workflows/release.yml`, `.githooks/**`, `tooling/repo-scripts/bin/**`.

It is plain Node 24 ESM with no dependencies. It reads nothing from the environment beyond what git and gh themselves read; there are no configuration variables. The hook command in `settings.json` ends in `|| exit 2`, so a missing `node` or a crash blocks rather than passes.

**Limits.** Only commands Claude Code runs directly are seen. A script run by an allowed command (`pnpm test` runs `package.json` scripts) is not, and nothing here binds a client outside Claude Code. These controls stop mistakes and prompt-injected shortcuts; they are not a boundary against a deliberately hostile agent (accepted risk SEC-F001-01). A developer's `.claude/settings.local.json` can set `disableAllHooks` (see the T15 notes in `implementation-notes.md`).

## Tests

```sh
node --test '.claude/hooks/test/*.test.mjs'
```

`test/guard-bash.fixtures.json` lists every case (TC-F-001-41): the design's minimum set plus the review additions. Each case runs the real hook in a temp repository with a local bare `origin`; `test/stubs/gh` answers `gh pr view` and `gh pr checks` from `test/gh-scenarios.json`, so no test reaches GitHub. The CI `repo-checks` job runs them before any install.
