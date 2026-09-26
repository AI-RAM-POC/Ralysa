#!/usr/bin/env node
// secret-scan entry point (F-001 design §6.2.3, §6.2.5). Dependency-free: it imports only
// node:* and lib/core.ts through secret-scan*.ts, so the CI `secret-scan` job runs it with no
// install and no build.
//   secret-scan pr --base <sha> --head <sha>   new commits of a PR (fails on an empty range)
//   secret-scan tree                           the working tree (repository config)
//   secret-scan history                        the full git history (repository config)
//   secret-scan artefacts                      every shipped artefact (artefact config; missing path fails)
//   secret-scan selftest                       dir, git, artefact and canary self-tests
//   secret-scan image (--dockerfile <path> | --image <ref>) [--exact-values <file>]
//                                              a container image: filesystem, config and history,
//                                              exact values, no dev stack or oidc-provider (F-002-T14)
//   secret-scan dir <path> [--exact-values <file>]
//                                              one folder (DB dump, logs) with the artefact config
// Options: --report-dir <dir> (default $RUNNER_TEMP/secret-scan-reports or .tools/reports).
// --exact-values reads KEY=VALUE lines from a file (never the command line, so no value reaches
// the process list or a shell's history); a finding names the KEY only.
// Exit codes: 0 clean, 1 findings or a failed self-test, 2 usage or scanner error.
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Finding, findRepoRoot, formatFindings } from './lib/core.ts';
import {
  type ScanContext,
  type ScanResult,
  SecretScanError,
  scanArtefacts,
  scanHistory,
  scanPr,
  scanTree,
  toFindings,
  verifiedGitleaks,
} from './secret-scan.ts';
import { scanDirectory, scanImage } from './secret-scan-image.ts';
import { runSelftests } from './secret-scan-selftest.ts';

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function report(
  results: ScanResult[],
  extra: { label: string; findings: Finding[] }[] = [],
): number {
  let failed = false;
  for (const { label, findings } of extra) {
    if (findings.length === 0) {
      console.log(`✓ secret-scan ${label}: 0 findings`);
      continue;
    }
    failed = true;
    console.error(`✗ secret-scan ${label}: ${String(findings.length)} finding(s)`);
    console.error(formatFindings(findings));
  }
  for (const result of results) {
    if (result.findings.length === 0) {
      console.log(`✓ secret-scan ${result.label}: 0 findings`);
      continue;
    }
    failed = true;
    console.error(`✗ secret-scan ${result.label}: ${String(result.findings.length)} finding(s)`);
    console.error(formatFindings(toFindings(result)));
  }
  if (failed) {
    console.error(
      'A credential may have been committed or shipped. Revoke and rotate it at the issuer first; removing it from git is not remediation (F-001 design §6.2.6).',
    );
  }
  return failed ? 1 : 0;
}

function main(argv: string[]): number {
  const [command, ...args] = argv;
  const root = findRepoRoot(process.cwd());
  const reportDir =
    flag(args, '--report-dir') ??
    (process.env.RUNNER_TEMP
      ? join(process.env.RUNNER_TEMP, 'secret-scan-reports')
      : join(root, '.tools', 'reports'));

  const commands = ['pr', 'tree', 'history', 'artefacts', 'selftest', 'image', 'dir'];
  if (command === undefined || !commands.includes(command)) {
    console.error(
      `usage: secret-scan <${commands.join('|')}> [--base <sha> --head <sha>] [--report-dir <dir>]`,
    );
    return 2;
  }

  try {
    const ctx: ScanContext = { root, binary: verifiedGitleaks(root), reportDir };
    switch (command) {
      case 'pr': {
        const base = flag(args, '--base');
        const head = flag(args, '--head');
        if (base === undefined || head === undefined) {
          console.error('usage: secret-scan pr --base <sha> --head <sha>');
          return 2;
        }
        return report([scanPr(ctx, base, head)]);
      }
      case 'tree':
        return report([scanTree(ctx)]);
      case 'history':
        return report([scanHistory(ctx)]);
      case 'artefacts':
        return report(scanArtefacts(ctx));
      case 'image': {
        const dockerfile = flag(args, '--dockerfile');
        const image = flag(args, '--image');
        const exactValues = flag(args, '--exact-values');
        if ((dockerfile === undefined) === (image === undefined)) {
          console.error(
            'usage: secret-scan image (--dockerfile <path> | --image <ref>) [--exact-values <file>]',
          );
          return 2;
        }
        const scanned = scanImage({
          ctx,
          ...(dockerfile === undefined ? {} : { dockerfile: resolve(root, dockerfile) }),
          ...(image === undefined ? {} : { image }),
          ...(exactValues === undefined ? {} : { exactValuesFile: resolve(exactValues) }),
        });
        return report(scanned.results, [
          { label: `image checks (${scanned.image})`, findings: scanned.findings },
        ]);
      }
      case 'dir': {
        const target = args[0];
        const exactValues = flag(args, '--exact-values');
        if (target === undefined || target.startsWith('--')) {
          console.error('usage: secret-scan dir <path> [--exact-values <file>]');
          return 2;
        }
        const scanned = scanDirectory(
          ctx,
          resolve(target),
          exactValues === undefined ? undefined : resolve(exactValues),
        );
        return report(scanned.results, [{ label: 'exact values', findings: scanned.findings }]);
      }
      default: {
        const results = runSelftests({
          root,
          binary: ctx.binary,
          reportDir: join(reportDir, 'selftest'),
        });
        for (const result of results) {
          if (result.ok) console.log(`✓ selftest ${result.name}`);
          else
            console.error(
              `✗ selftest ${result.name}\n${result.problems.map((p) => `  ✗ ${p}`).join('\n')}`,
            );
        }
        // Self-test reports hold only synthetic values (redacted anyway); don't keep them.
        rmSync(join(reportDir, 'selftest'), { recursive: true, force: true });
        return results.every((r) => r.ok) ? 0 : 1;
      }
    }
  } catch (error) {
    if (error instanceof SecretScanError) {
      console.error(`✗ secret-scan ${command}: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
