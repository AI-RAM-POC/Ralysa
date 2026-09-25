// TC-F-001-17 (AC-8): every bundled font's licence is in the allow-list (OFL-1.1, no Reserved
// Font Name), and the build output carries each OFL text and THIRD_PARTY_NOTICES. The Vite case
// builds fonts.css for real (offline) with the fontLicenses() plugin, as an app does.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FONT_PACKAGES,
  fontLicenses,
  fontPackageDir,
  fontPackageOf,
  licensePath,
  licenseProblems,
  NOTICES_FILE,
  readFontLicenses,
  writeFontLicenses,
} from '../scripts/font-licenses.ts';

const FONTS_CSS = fileURLToPath(new URL('../src/styles/fonts.css', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'ralysa-font-licence-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const OFL_BODY =
  'This Font Software is licensed under the SIL Open Font License, Version 1.1.\n\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n\n"Reserved Font Name" refers to any names specified as such after the copyright statement(s).\n';

describe('licence allow-list (§7.2)', () => {
  it('each bundled font package is OFL-1.1 with no Reserved Font Name', () => {
    const fonts = readFontLicenses();
    expect(fonts.map((f) => [f.name, f.license])).toEqual([
      ['@fontsource-variable/noto-sans', 'OFL-1.1'],
      ['@fontsource-variable/noto-sans-arabic', 'OFL-1.1'],
      ['@fontsource-variable/noto-sans-mono', 'OFL-1.1'],
    ]);
    for (const font of fonts) {
      expect(font.copyright).toMatch(/^Copyright 2022 The Noto Project Authors/);
      expect(font.copyright).not.toMatch(/reserved font name/i);
    }
  });

  it('accepts the OFL whose body defines the term, without an RFN in the notice', () => {
    expect(
      licenseProblems({ license: 'OFL-1.1' }, `Copyright 2022 Someone\n\n${OFL_BODY}`),
    ).toEqual([]);
  });

  it.each([
    [
      'a Reserved Font Name in the notice',
      { license: 'OFL-1.1' },
      `Copyright 2022 Someone, with Reserved Font Name "Plex".\n\n${OFL_BODY}`,
      /Reserved Font Name/,
    ],
    [
      'another licence in package.json',
      { license: 'Apache-2.0' },
      `Copyright 2022 Someone\n\n${OFL_BODY}`,
      /not in the allow-list/,
    ],
    ['no licence field', {}, `Copyright 2022 Someone\n\n${OFL_BODY}`, /not in the allow-list/],
    [
      'a licence file that is not the OFL',
      { license: 'OFL-1.1' },
      'Copyright 2022 Someone\nPermission is hereby granted, free of charge…',
      /not the SIL Open Font License/,
    ],
    ['no copyright notice', { license: 'OFL-1.1' }, OFL_BODY, /no copyright notice/],
  ])('rejects %s', (_what, pkg, text, problem) => {
    expect(licenseProblems(pkg, text).join('; ')).toMatch(problem);
  });

  it('readFontLicenses fails for a package whose licence is not acceptable', () => {
    const fake = join(scratch, 'fake-package');
    const dir = fontPackageDir('@fontsource-variable/noto-sans', fake);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', license: 'MIT' }));
    writeFileSync(join(dir, 'LICENSE'), `Copyright 2022 Someone\n\n${OFL_BODY}`);
    expect(() => readFontLicenses(fake)).toThrow(/noto-sans: package.json licence "MIT"/);
  });
});

describe('licence files in the output (TC-F-001-17)', () => {
  it('writeFontLicenses writes each OFL text and THIRD_PARTY_NOTICES', () => {
    const out = join(scratch, 'dist');
    const written = writeFontLicenses(out);
    expect(written).toEqual([
      'licenses/fonts/noto-sans/OFL.txt',
      'licenses/fonts/noto-sans-arabic/OFL.txt',
      'licenses/fonts/noto-sans-mono/OFL.txt',
      NOTICES_FILE,
    ]);
    for (const font of FONT_PACKAGES) {
      expect(readFileSync(join(out, licensePath(font)), 'utf8')).toBe(
        readFileSync(join(fontPackageDir(font.name), 'LICENSE'), 'utf8'),
      );
    }
    const notices = readFileSync(join(out, NOTICES_FILE), 'utf8');
    for (const font of FONT_PACKAGES) {
      expect(notices).toContain(font.name);
      expect(notices).toContain(licensePath(font));
    }
    expect(notices).toContain('no Reserved Font Name');
  });

  it('fontPackageOf matches a bundled file by its original path, never a look-alike', () => {
    const file = (name: string, sub: string): string =>
      `../../node_modules/.pnpm/x@5.3.0/node_modules/${name}/files/${sub}`;
    expect(fontPackageOf([file('@fontsource-variable/noto-sans-arabic', 'a.woff2')])?.slug).toBe(
      'noto-sans-arabic',
    );
    expect(fontPackageOf([file('@fontsource-variable/noto-sans', 'a.woff2')])?.slug).toBe(
      'noto-sans',
    );
    expect(fontPackageOf(['src/fonts/noto-sans-latin.woff2'])).toBeUndefined();
    expect(fontPackageOf([file('@fontsource-variable/noto-sans-jp', 'a.woff2')])).toBeUndefined();
    expect(fontPackageOf([])).toBeUndefined();
  });

  async function viteBuild(name: string, css: string): Promise<string> {
    const root = join(scratch, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'entry.css'), css);
    writeFileSync(join(root, 'entry.js'), "import './entry.css';\n");
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [fontLicenses()],
      build: {
        outDir: 'dist',
        emptyOutDir: true,
        rollupOptions: { input: join(root, 'entry.js') },
      },
    });
    return join(root, 'dist');
  }

  const walk = (dir: string, base = dir): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name), base)
        : [join(dir, entry.name).slice(base.length + 1)],
    );

  it('an app build of fonts.css bundles the fonts locally, with every licence', async () => {
    const dist = await viteBuild('app', `@import '${FONTS_CSS}';\n`);
    const files = walk(dist);
    const fonts = files.filter((f) => f.endsWith('.woff2'));
    // Every subset of all three families is emitted; a browser downloads only what a page uses.
    for (const slug of ['noto-sans-latin', 'noto-sans-arabic-arabic', 'noto-sans-mono-latin']) {
      expect(
        fonts.some((f) => f.includes(`${slug}-wght-normal`)),
        slug,
      ).toBe(true);
    }
    for (const font of FONT_PACKAGES) {
      expect(readFileSync(join(dist, licensePath(font)), 'utf8')).toMatch(
        /SIL OPEN FONT LICENSE Version 1\.1/,
      );
    }
    expect(existsSync(join(dist, NOTICES_FILE))).toBe(true);
    // No font CDN, no remote URL: every url() in the CSS points at a bundled file.
    const css = files
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(dist, f), 'utf8'));
    const urls = css.flatMap((text) =>
      [...text.matchAll(/url\(\s*['"]?([^)'"]+)/g)].map((m) => m[1]),
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).not.toMatch(/^(?:[a-z]+:)?\/\//i);
  }, 60_000);

  it('a font from anywhere else fails the build', async () => {
    const root = join(scratch, 'foreign');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'foreign.woff2'), Buffer.from('wOF2 fixture, not a real font'));
    await expect(
      viteBuild(
        'foreign',
        "@font-face { font-family: 'Foreign'; src: url(./foreign.woff2) format('woff2'); }\nbody { font-family: 'Foreign'; }\n",
      ),
    ).rejects.toThrow(/outside the reviewed font packages/);
  }, 60_000);
});

describe('fonts.css (§7.2 delivery)', () => {
  const css = readFileSync(FONTS_CSS, 'utf8');

  it('imports exactly the reviewed font packages, from the packages', () => {
    const imports = [...css.matchAll(/@import\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(FONT_PACKAGES.map((font) => `${font.name}/wght.css`));
  });

  it('has no remote URL (no font CDN)', () => {
    expect(css).not.toMatch(/https?:|\/\/fonts\.|googleapis|gstatic/i);
  });

  it('every @font-face of the imported files uses font-display: swap and a local file', () => {
    for (const font of FONT_PACKAGES) {
      const faces = readFileSync(join(fontPackageDir(font.name), 'wght.css'), 'utf8');
      const blocks = [...faces.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).toContain('font-display: swap');
        expect(block).toMatch(/src:\s*url\(\.\/files\//);
      }
    }
  });
});
