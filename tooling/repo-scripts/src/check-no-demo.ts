// check-no-demo (F-001 design §7.6 AC-13 guard 2; TC-F-001-27): the demo screen and its
// synthetic sample data never reach a shipped build. Runs in the `quality` job after the build,
// outside Turbo, like the other artefact checks.
//   - Fingerprints: the sentinel `__RALYSA_DEMO_ONLY__` and every sample string in
//     apps/ui-lab/src/samples/*.json (each file must carry the sentinel field).
//   - Every file of every shipped artefact (`ralysa.shipped: true`) is searched for each
//     fingerprint in every form a bundler may emit it: UTF-8, and JavaScript \uXXXX escapes in
//     lower- and upper-case hex. 0 matches expected; a missing artefact path fails.
//   - Positive control: the ui-lab build must contain the sentinel and every sample in at least
//     one of those forms. If a bundler starts emitting another form, the control fails first,
//     rather than the shipped scan silently finding nothing.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { artefactFiles } from './check-provider-hosts.ts';
import { type Finding, isRecord } from './lib/core.ts';
import { shippedArtefacts } from './secret-scan.ts';

export const DEMO_SENTINEL = '__RALYSA_DEMO_ONLY__';
/** The internal demo app (design §7.6). Nothing may depend on it (boundaries.js). */
export const DEMO_WORKSPACE = 'apps/ui-lab';
export const DEMO_SAMPLES_DIR = `${DEMO_WORKSPACE}/src/samples`;
export const DEMO_BUILD = `${DEMO_WORKSPACE}/dist`;
/** Shorter sample strings are not fingerprints: they could occur by chance. */
export const MIN_FINGERPRINT_LENGTH = 12;

export interface Fingerprint {
  /** `sentinel`, or `<file>#<sample id>`. */
  id: string;
  text: string;
}

// Non-ASCII per UTF-16 code unit, so a character outside the BMP becomes its surrogate pair, as
// in JS source.
const escapeNonAscii = (text: string, hex: (unit: number) => string): string =>
  Array.from({ length: text.length }, (_, index) => {
    const code = text.charCodeAt(index);
    return code <= 0x7e ? text.charAt(index) : `\\u${hex(code)}`;
  }).join('');

/**
 * Every byte form of `text` a bundle may contain: the raw text and its string-literal form
 * (`\n`, `\"`, `\\` escaped), each as UTF-8 and with non-ASCII as \uXXXX (lower and upper case).
 */
export function encodings(text: string): Buffer[] {
  const literal = JSON.stringify(text).slice(1, -1);
  const forms = new Set(
    [text, literal].flatMap((base) => [
      base,
      escapeNonAscii(base, (code) => code.toString(16).padStart(4, '0')),
      escapeNonAscii(base, (code) => code.toString(16).toUpperCase().padStart(4, '0')),
    ]),
  );
  return [...forms].map((form) => Buffer.from(form, 'utf8'));
}

/** Reads the sentinel and sample fingerprints; reports sample files that break the contract. */
export function loadFingerprints(root: string): {
  fingerprints: Fingerprint[];
  findings: Finding[];
} {
  const findings: Finding[] = [];
  const fingerprints: Fingerprint[] = [{ id: 'sentinel', text: DEMO_SENTINEL }];
  const dir = join(root, DEMO_SAMPLES_DIR);
  if (!existsSync(dir)) {
    findings.push({
      rule: 'no-demo/samples-missing',
      path: DEMO_SAMPLES_DIR,
      message: 'the demo sample folder is missing, so there is nothing to fingerprint',
    });
    return { fingerprints, findings };
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  for (const file of files) {
    const path = `${DEMO_SAMPLES_DIR}/${file}`;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      findings.push({ rule: 'no-demo/sample-file', path, message: 'not valid JSON' });
      continue;
    }
    if (!isRecord(doc) || doc[DEMO_SENTINEL] !== true) {
      findings.push({
        rule: 'no-demo/sample-without-sentinel',
        path,
        message: `every sample file must carry "${DEMO_SENTINEL}": true (design §7.6)`,
      });
      continue;
    }
    const samples = Array.isArray(doc.samples) ? doc.samples : [];
    if (samples.length === 0) {
      findings.push({ rule: 'no-demo/sample-file', path, message: 'has no "samples" array' });
    }
    for (const [index, sample] of samples.entries()) {
      const id = isRecord(sample) && typeof sample.id === 'string' ? sample.id : String(index);
      if (!isRecord(sample) || typeof sample.text !== 'string') {
        findings.push({
          rule: 'no-demo/sample-file',
          path: `${path}#${id}`,
          message: 'a sample needs "id", "category" and "text" strings',
        });
        continue;
      }
      // Length in characters (code points), not UTF-16 units.
      if (Array.from(sample.text).length >= MIN_FINGERPRINT_LENGTH) {
        fingerprints.push({ id: `${file}#${id}`, text: sample.text });
      }
    }
  }
  return { fingerprints, findings };
}

function filesOf(dir: string): { full: string; rel: string }[] {
  if (!statSync(dir).isDirectory()) return [{ full: dir, rel: '' }];
  return artefactFiles(dir).map((rel) => ({ full: join(dir, rel), rel }));
}

/** Which fingerprints occur anywhere under `dir`, with the first file each was found in. */
export function scanForFingerprints(
  dir: string,
  fingerprints: readonly Fingerprint[],
): Map<string, string> {
  const found = new Map<string, string>();
  const needles = fingerprints.map((fingerprint) => ({
    id: fingerprint.id,
    forms: encodings(fingerprint.text),
  }));
  for (const file of filesOf(dir)) {
    const bytes = readFileSync(file.full);
    for (const needle of needles) {
      if (found.has(needle.id)) continue;
      if (needle.forms.some((form) => bytes.includes(form))) found.set(needle.id, file.rel);
    }
  }
  return found;
}

export function checkNoDemo(root: string): Finding[] {
  const { fingerprints, findings } = loadFingerprints(root);

  for (const artefact of shippedArtefacts(root)) {
    const dir = join(root, artefact.path);
    if (!existsSync(dir)) {
      findings.push({
        rule: 'no-demo/artefact-missing',
        path: artefact.path,
        message: 'shipped artefact path missing; build first (a scan of nothing proves nothing)',
      });
      continue;
    }
    for (const [id, file] of scanForFingerprints(dir, fingerprints)) {
      findings.push({
        rule: 'no-demo/shipped',
        path: file === '' ? artefact.path : `${artefact.path}/${file}`,
        message: `demo content (${id}) is in a shipped build (AC-13): the ui-lab demo and its sample data must never ship`,
      });
    }
  }

  // Positive control (TC-F-001-27): the scan must see the demo where it is.
  const control = join(root, DEMO_BUILD);
  if (!existsSync(control)) {
    findings.push({
      rule: 'no-demo/control-missing',
      path: DEMO_BUILD,
      message: 'the ui-lab build is the positive control; build it first',
    });
  } else {
    const seen = scanForFingerprints(control, fingerprints);
    for (const fingerprint of fingerprints) {
      if (!seen.has(fingerprint.id)) {
        findings.push({
          rule: 'no-demo/control-missed',
          path: DEMO_BUILD,
          message: `the scan can't find ${fingerprint.id} in the ui-lab build, so it would miss that content in a shipped build too; update encodings() for the form the bundler emits`,
        });
      }
    }
  }
  return findings;
}
