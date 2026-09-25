// TC-F-001-27 (AC-13, design §7.6 guard 2): check-no-demo finds 0 demo fingerprints in shipped
// builds and fails on each form a leak can take; the positive control must see the demo in the
// ui-lab build. Fixture repositories only; CI runs the CLI on the real builds (`quality`).
import { describe, expect, it } from 'vitest';
import { checkNoDemo, DEMO_SENTINEL, encodings, loadFingerprints } from '../src/check-no-demo.ts';
import { findRepoRoot } from '../src/lib/core.ts';
import { makeFixtureRepo, validWorkspacePackage } from './fixture-repo.ts';

const PURE = 'مرحبًا بكم في مساحة العمل';
const MIXED = 'افتح Ralysa Desktop ثم اختر مساحة جديدة';
const SHORT = 'نعم';

const samplesJson = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    [DEMO_SENTINEL]: true,
    samples: [
      { id: 'pure01', category: 'pure', text: PURE },
      { id: 'mixed01', category: 'mixed', text: MIXED },
      { id: 'short01', category: 'pure', text: SHORT },
    ],
    ...extra,
  });

/** JS \uXXXX escaping of every non-ASCII code unit, the way a minifier may emit a string. */
const jsEscape = (text: string, upper = false): string =>
  Array.from({ length: text.length }, (_, index) => {
    const code = text.charCodeAt(index);
    if (code < 0x80) return text.charAt(index);
    const hex = code.toString(16).padStart(4, '0');
    return `\\u${upper ? hex.toUpperCase() : hex}`;
  }).join('');

function repo(options: {
  web?: Record<string, string> | null;
  labBuild?: Record<string, string> | null;
  samples?: string | null;
}) {
  const labFiles: Record<string, string> = {};
  if (options.samples !== null)
    labFiles['src/samples/arabic-samples.json'] = options.samples ?? samplesJson();
  const labBuild =
    options.labBuild === undefined
      ? {
          'dist/index.html': `<div data-demo-sentinel="${DEMO_SENTINEL}"></div>`,
          'dist/assets/index-abc123.js': `const a=${JSON.stringify(PURE)};const b="${jsEscape(MIXED)}";`,
        }
      : (options.labBuild ?? {});
  const web =
    options.web === undefined
      ? {
          'dist/index.html': '<div id="root"></div>',
          'dist/assets/index-def456.js': 'console.log(1);',
        }
      : (options.web ?? {});
  const fixture = makeFixtureRepo({
    workspaces: [
      {
        dir: 'apps/web',
        pkg: validWorkspacePackage('@ralysa/web', {
          ralysa: { kind: 'app', shipped: true, ui: true, artefacts: ['dist'] },
        }),
        files: web,
      },
      {
        dir: 'apps/ui-lab',
        pkg: validWorkspacePackage('@ralysa/ui-lab', {
          ralysa: { kind: 'app', shipped: false, ui: true },
        }),
        files: { ...labFiles, ...labBuild },
      },
    ],
  });
  return checkNoDemo(fixture.root);
}

const rules = (findings: { rule: string; path: string; message: string }[]): string[] =>
  findings.map((f) => `${f.rule} ${f.path}`);

describe('check-no-demo (TC-F-001-27)', () => {
  it('passes: no fingerprint in the shipped build, all of them in the ui-lab build', () => {
    expect(repo({})).toEqual([]);
  });

  it.each([
    ['the sentinel', `<meta name="x" content="${DEMO_SENTINEL}">`, 'sentinel'],
    ['a sample as UTF-8', `const s=${JSON.stringify(PURE)};`, 'arabic-samples.json#pure01'],
    [
      'a sample as lower-case \\u escapes',
      `const s="${jsEscape(MIXED)}";`,
      'arabic-samples.json#mixed01',
    ],
    [
      'a sample as upper-case \\u escapes',
      `const s="${jsEscape(PURE, true)}";`,
      'arabic-samples.json#pure01',
    ],
  ])('fails on %s in a shipped file', (_what, content, id) => {
    const findings = repo({
      web: { 'dist/index.html': '<div id="root"></div>', 'dist/assets/chunk-x1.js': content },
    });
    expect(rules(findings)).toEqual([`no-demo/shipped apps/web/dist/assets/chunk-x1.js`]);
    expect(findings[0]?.message).toContain(id);
  });

  it('scans every file of the artefact: source maps, HTML, JSON and node_modules too', () => {
    for (const file of [
      'dist/assets/index.js.map',
      'dist/demo.html',
      'dist/data/strings.json',
      'dist/node_modules/lib/index.js',
    ]) {
      const findings = repo({ web: { [file]: `x ${PURE} y` } });
      expect(rules(findings), file).toEqual([`no-demo/shipped apps/web/${file}`]);
    }
  });

  it('reports each fingerprint once per artefact, naming it', () => {
    const findings = repo({
      web: { 'dist/a.js': `${DEMO_SENTINEL} ${PURE}`, 'dist/b.js': MIXED },
    });
    expect(findings.map((f) => f.message.match(/\(([^)]+)\)/)?.[1]).sort()).toEqual([
      'arabic-samples.json#mixed01',
      'arabic-samples.json#pure01',
      'sentinel',
    ]);
  });

  it('short sample strings are not fingerprints (no false positives on common words)', () => {
    expect(repo({ web: { 'dist/a.js': `const yes=${JSON.stringify(SHORT)};` } })).toEqual([]);
  });

  it('a missing shipped artefact fails', () => {
    expect(rules(repo({ web: null }))).toEqual(['no-demo/artefact-missing apps/web/dist']);
  });

  describe('positive control', () => {
    it('fails without a ui-lab build', () => {
      expect(rules(repo({ labBuild: null }))).toEqual(['no-demo/control-missing apps/ui-lab/dist']);
    });

    it('fails when the ui-lab build lacks a fingerprint (the scan could not see it)', () => {
      const findings = repo({
        labBuild: {
          'dist/index.html': `<div data-demo-sentinel="${DEMO_SENTINEL}"></div>`,
          // The mixed sample in a form the scan doesn't know: HTML numeric entities.
          'dist/assets/index.js': `const a=${JSON.stringify(PURE)};const b="${Array.from(MIXED, (c) => `&#${String(c.codePointAt(0))};`).join('')}";`,
        },
      });
      expect(rules(findings)).toEqual(['no-demo/control-missed apps/ui-lab/dist']);
      expect(findings[0]?.message).toContain('mixed01');
    });
  });

  describe('sample files', () => {
    it('every sample file must carry the sentinel field', () => {
      const findings = repo({
        samples: JSON.stringify({ samples: [{ id: 'a', category: 'x', text: PURE }] }),
      });
      expect(rules(findings)).toContain(
        'no-demo/sample-without-sentinel apps/ui-lab/src/samples/arabic-samples.json',
      );
    });

    it('rejects invalid JSON, an empty sample list and a sample without text', () => {
      expect(rules(repo({ samples: '{' }))).toContain(
        'no-demo/sample-file apps/ui-lab/src/samples/arabic-samples.json',
      );
      expect(
        rules(repo({ samples: JSON.stringify({ [DEMO_SENTINEL]: true, samples: [] }) })),
      ).toContain('no-demo/sample-file apps/ui-lab/src/samples/arabic-samples.json');
      expect(
        rules(repo({ samples: JSON.stringify({ [DEMO_SENTINEL]: true, samples: [{ id: 'z' }] }) })),
      ).toContain('no-demo/sample-file apps/ui-lab/src/samples/arabic-samples.json#z');
    });

    it('a missing samples folder is reported', () => {
      expect(rules(repo({ samples: null }))).toContain(
        'no-demo/samples-missing apps/ui-lab/src/samples',
      );
    });
  });

  it('encodings: raw and string-literal forms, each as UTF-8 and as \\u escapes in both cases', () => {
    const forms = encodings('a\u0627\u{1F600}').map((form) => form.toString('utf8'));
    expect(forms).toEqual(['a\u0627\u{1F600}', 'a\\u0627\\ud83d\\ude00', 'a\\u0627\\uD83D\\uDE00']);
    expect(encodings('plain ascii').map(String)).toEqual(['plain ascii']);
    // A multi-line or quoted sample appears in a bundle with \n and \" escapes.
    expect(encodings('line one\nline "two"').map(String)).toEqual([
      'line one\nline "two"',
      'line one\\nline \\"two\\"',
    ]);
  });

  it('finds a multi-line sample the way a bundle stores it (\\n escape)', () => {
    const multi = 'first line of the sample\nsecond line';
    const samples = JSON.stringify({
      [DEMO_SENTINEL]: true,
      samples: [{ id: 'multi', category: 'code', text: multi }],
    });
    const lab = {
      'dist/index.html': DEMO_SENTINEL,
      'dist/a.js': `const c=${JSON.stringify(multi)};`,
    };
    expect(repo({ samples, labBuild: lab })).toEqual([]);
    expect(
      rules(repo({ samples, labBuild: lab, web: { 'dist/b.js': `x=${JSON.stringify(multi)}` } })),
    ).toEqual(['no-demo/shipped apps/web/dist/b.js']);
  });

  it('the real sample files fingerprint every sample and carry the sentinel', () => {
    const { fingerprints, findings } = loadFingerprints(findRepoRoot());
    expect(findings).toEqual([]);
    expect(fingerprints.filter((f) => f.id.startsWith('arabic-samples.json#'))).toHaveLength(20);
  });
});
