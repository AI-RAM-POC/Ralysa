// check-provider-hosts (F-001 design §6.1; SEC-F001-09 d; TC-F-001-42 hostname part): SR-03 at
// the network-string level. A raw fetch() to a model provider needs no SDK, so the import bans
// can't see it. This check greps for the PROVIDER_HOSTS in boundaries.js:
// - source mode (repo-check): every tracked file outside PROVIDER_HOSTS_ALLOWED_IN
//   (services/model-gateway/**, docs/**, requirements/**, *.md and the host list itself);
// - artefact mode (--artefacts, in the `quality` job after the build): every file of every
//   shipped artefact; a missing artefact path fails.
// Defence in depth only: a string split at runtime gets past it, and network egress policy
// (F-004, deploy/) is the authoritative SR-03 control.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  PROVIDER_HOSTS_ALLOWED_IN,
  globSource,
  providerHostSource,
} from '@ralysa/eslint-config/boundaries';
import { type Finding, listRepoFiles, toPosix } from './lib/repo.ts';
import { shippedArtefacts } from './secret-scan.ts';

/** Files larger than this are still scanned, but only their first bytes (bundles are smaller). */
const MAX_BYTES = 32 * 1024 * 1024;

const allowedSource = new RegExp(`^(?:${PROVIDER_HOSTS_ALLOWED_IN.map(globSource).join('|')})$`);

/** Every provider hostname in `text`, with its 1-based line number. */
export function findProviderHosts(text: string): { host: string; line: number }[] {
  const hits: { host: string; line: number }[] = [];
  for (const match of text.matchAll(new RegExp(providerHostSource(), 'gi'))) {
    const line = text.slice(0, match.index).split('\n').length;
    hits.push({ host: match[0].toLowerCase(), line });
  }
  return hits;
}

function scanFile(full: string, shown: string, rule: string, findings: Finding[]): void {
  if (!existsSync(full) || !statSync(full).isFile()) return;
  const text = readFileSync(full).subarray(0, MAX_BYTES).toString('latin1');
  for (const hit of findProviderHosts(text)) {
    findings.push({
      rule,
      path: `${shown}:${String(hit.line)}`,
      message: `${hit.host} is a model-provider API host; only services/model-gateway may call providers (SR-03, SEC-F001-09 d). Call the Model Gateway instead.`,
    });
  }
}

export function isProviderHostAllowed(path: string): boolean {
  return allowedSource.test(path);
}

/** Source mode: tracked (and untracked-not-ignored) files outside the allowed paths. */
export function checkProviderHosts(root: string, repoFiles = listRepoFiles(root)): Finding[] {
  const findings: Finding[] = [];
  for (const file of repoFiles) {
    if (isProviderHostAllowed(file)) continue;
    scanFile(join(root, file), file, 'provider-hosts/source', findings);
  }
  return findings;
}

/**
 * Every file under an artefact folder (posix, relative), skipping only `.git`. Unlike the
 * repo walker it does NOT skip node_modules: whatever sits in a shipped artefact ships
 * (code review finding 4).
 */
export function artefactFiles(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...artefactFiles(root, full));
    else files.push(toPosix(relative(root, full)));
  }
  return files.sort();
}

/** Artefact mode: every file of every shipped artefact. A missing artefact path fails. */
export function checkProviderHostsInArtefacts(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const artefact of shippedArtefacts(root)) {
    const dir = join(root, artefact.path);
    if (!existsSync(dir)) {
      findings.push({
        rule: 'provider-hosts/artefact-missing',
        path: artefact.path,
        message: 'shipped artefact path missing; build first (a scan of nothing proves nothing)',
      });
      continue;
    }
    const files = statSync(dir).isDirectory()
      ? artefactFiles(dir).map((f) => [join(dir, f), `${artefact.path}/${f}`])
      : [[dir, artefact.path]];
    for (const [full, shown] of files) {
      scanFile(full as string, shown as string, 'provider-hosts/artefact', findings);
    }
  }
  return findings;
}
