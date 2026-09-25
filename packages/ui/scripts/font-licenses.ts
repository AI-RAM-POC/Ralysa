#!/usr/bin/env node
// Font licences (F-001 design §7.2; AC-8, TC-F-001-17). The OFL lets us bundle and redistribute
// the fonts, provided the copyright and licence travel with them. This module:
//   - lists the bundled font packages and validates each one's licence: package.json says
//     OFL-1.1, the licence file is the SIL Open Font License 1.1, and its copyright notice
//     declares no Reserved Font Name (a RFN would force a rename of any subset or conversion);
//   - `node scripts/font-licenses.ts` writes dist/licenses/fonts/<font>/OFL.txt and
//     dist/THIRD_PARTY_NOTICES for this package's build;
//   - fontLicenses() is the Vite plugin an app adds to its build: it emits the same files next to
//     the bundle, and fails the build if a font file comes from anywhere else.
// Everything is read from the installed packages; nothing is fetched. Runs on Node 24 type
// stripping, and is bundled into an app's vite.config.ts by Vite.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export interface FontPackage {
  /** npm package name. */
  name: string;
  /** Folder under licenses/fonts/ in the build output. */
  slug: string;
  /** The family name the package's @font-face rules declare. */
  family: string;
}

/** Every font package @ralysa/ui bundles (fonts.css imports each). A new one needs a review. */
export const FONT_PACKAGES: readonly FontPackage[] = [
  { name: '@fontsource-variable/noto-sans', slug: 'noto-sans', family: 'Noto Sans Variable' },
  {
    name: '@fontsource-variable/noto-sans-arabic',
    slug: 'noto-sans-arabic',
    family: 'Noto Sans Arabic Variable',
  },
  {
    name: '@fontsource-variable/noto-sans-mono',
    slug: 'noto-sans-mono',
    family: 'Noto Sans Mono Variable',
  },
];

/** The only licence allowed for a bundled font (§7.2; licence allow-list for TC-F-001-17). */
export const FONT_LICENSE_ALLOWLIST = ['OFL-1.1'] as const;

/** File extensions treated as fonts in a build output. */
export const FONT_FILE = /\.(?:woff2?|ttf|otf|eot)$/i;

export interface FontLicense extends FontPackage {
  version: string;
  license: string;
  /** Absolute folder of the installed package. */
  dir: string;
  /** The package's licence file (the OFL text with the copyright notice). */
  text: string;
  /** The copyright lines above the licence body. */
  copyright: string;
}

// This package's own dependencies, by static path (the boundary rules ban createRequire).
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export function fontPackageDir(name: string, packageDir = PACKAGE_DIR): string {
  return join(packageDir, 'node_modules', name);
}

const OFL_TITLE = /SIL OPEN FONT LICENSE Version 1\.1/;
const OFL_GRANT = 'This Font Software is licensed under the SIL Open Font License, Version 1.1.';

/**
 * Checks one package's licence and returns its problems (empty = acceptable). The Reserved Font
 * Name clause, when present, sits in the copyright notice above the licence grant
 * ("… with Reserved Font Name X"); the licence body's own definition of the term doesn't count.
 */
export function licenseProblems(pkg: { license?: unknown }, text: string): string[] {
  const problems: string[] = [];
  if (!(FONT_LICENSE_ALLOWLIST as readonly unknown[]).includes(pkg.license)) {
    problems.push(
      `package.json licence ${JSON.stringify(pkg.license)} is not in the allow-list (${FONT_LICENSE_ALLOWLIST.join(', ')})`,
    );
  }
  const grant = text.indexOf(OFL_GRANT);
  if (grant === -1 || !OFL_TITLE.test(text)) {
    problems.push('the licence file is not the SIL Open Font License 1.1');
    return problems;
  }
  const notice = text.slice(0, grant);
  if (!/copyright/i.test(notice)) problems.push('the licence file has no copyright notice');
  if (/reserved\s+font\s+names?/i.test(notice)) {
    problems.push('the copyright notice declares a Reserved Font Name');
  }
  return problems;
}

/** Reads and validates every bundled font's licence; throws if any is not acceptable. */
export function readFontLicenses(packageDir = PACKAGE_DIR): FontLicense[] {
  return FONT_PACKAGES.map((font) => {
    const dir = fontPackageDir(font.name, packageDir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      version?: unknown;
      license?: unknown;
    };
    const text = readFileSync(join(dir, 'LICENSE'), 'utf8');
    const problems = licenseProblems(pkg, text);
    if (problems.length > 0) {
      throw new Error(`${font.name}: ${problems.join('; ')} (F-001 design §7.2)`);
    }
    return {
      ...font,
      version: String(pkg.version),
      license: String(pkg.license),
      dir,
      text,
      copyright: text.slice(0, text.indexOf(OFL_GRANT)).trim(),
    };
  });
}

export const licensePath = (font: FontPackage): string => `licenses/fonts/${font.slug}/OFL.txt`;
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES';

/** The THIRD_PARTY_NOTICES text for the given fonts. */
export function renderNotices(fonts: readonly FontLicense[]): string {
  const sections = fonts.map((font) =>
    [
      `${font.family} (${font.name} ${font.version})`,
      `License: SIL Open Font License 1.1 (${font.license}), no Reserved Font Name`,
      font.copyright,
      `Full license text: ${licensePath(font)}`,
    ].join('\n'),
  );
  return [
    'Third-party notices: fonts bundled with Ralysa',
    '',
    'These fonts are redistributed under the SIL Open Font License 1.1. The license text for',
    'each is included next to this file; the fonts may not be sold by themselves.',
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
}

/** Writes licenses/fonts/<slug>/OFL.txt and THIRD_PARTY_NOTICES under `outDir`. */
export function writeFontLicenses(outDir: string, fonts = readFontLicenses()): string[] {
  const written: string[] = [];
  for (const font of fonts) {
    const file = join(outDir, licensePath(font));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, font.text);
    written.push(licensePath(font));
  }
  writeFileSync(join(outDir, NOTICES_FILE), renderNotices(fonts));
  written.push(NOTICES_FILE);
  return written;
}

/** The font package a bundled file came from, judged by its original path, or undefined. */
export function fontPackageOf(
  originalFileNames: readonly string[],
  fonts: readonly FontPackage[] = FONT_PACKAGES,
): FontPackage | undefined {
  return fonts.find((font) =>
    originalFileNames.some((file) =>
      file.replaceAll('\\', '/').includes(`/node_modules/${font.name}/files/`),
    ),
  );
}

/**
 * Vite plugin for an app build: for every font file in the bundle, emits its package's licence
 * (licenses/fonts/<slug>/OFL.txt) and a THIRD_PARTY_NOTICES file. A font file that doesn't come
 * from a FONT_PACKAGES package fails the build: its licence hasn't been reviewed.
 */
export function fontLicenses(packageDir = PACKAGE_DIR): Plugin {
  return {
    name: 'ralysa:font-licenses',
    apply: 'build',
    // A font under Vite's inline limit would become a data: URI and skip the check below, so
    // font files are always emitted as files.
    config: () => ({
      build: { assetsInlineLimit: (file: string) => (FONT_FILE.test(file) ? false : undefined) },
    }),
    generateBundle(_options, bundle) {
      const used = new Set<FontPackage>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'asset' || !FONT_FILE.test(output.fileName)) continue;
        const font = fontPackageOf(output.originalFileNames);
        if (font === undefined) {
          this.error(
            `${output.fileName} is a font from outside the reviewed font packages (${FONT_PACKAGES.map((f) => f.name).join(', ')}); its licence hasn't been checked (F-001 design §7.2)`,
          );
        }
        used.add(font);
      }
      if (used.size === 0) return;
      const fonts = readFontLicenses(packageDir).filter((license) =>
        [...used].some((font) => font.name === license.name),
      );
      for (const font of fonts) {
        this.emitFile({ type: 'asset', fileName: licensePath(font), source: font.text });
      }
      this.emitFile({ type: 'asset', fileName: NOTICES_FILE, source: renderNotices(fonts) });
    },
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const file of writeFontLicenses(join(PACKAGE_DIR, 'dist'))) {
    console.log(`font-licenses: wrote dist/${file}`);
  }
}
