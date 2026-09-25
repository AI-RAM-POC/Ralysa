// TC-F-001-12 (AC-6), i18next-cli part: `extract --ci --dry-run` (in this package's lint) fails
// when code uses a key the catalogs don't have, and passes on the real package. Runs the
// extractor's API on a temp fixture project: hermetic, no network, nothing written.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runExtractor } from 'i18next-cli';
import { afterAll, describe, expect, it } from 'vitest';
import config from '../i18next.config.ts';

const dir = mkdtempSync(join(tmpdir(), 'ralysa-i18n-extract-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content: unknown): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(
    join(dir, file),
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
}

const fixtureConfig = {
  ...config,
  extract: {
    ...config.extract,
    input: [join(dir, 'src/**/*.tsx')],
    output: join(dir, 'locales/{{language}}/{{namespace}}.json'),
    defaultNS: 'fix',
  },
};

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function wouldUpdate(): Promise<boolean> {
  const { anyFileUpdated } = await runExtractor(fixtureConfig, {
    isDryRun: true,
    quiet: true,
    logger: quietLogger,
  });
  return anyFileUpdated;
}

describe('i18next-cli extract --ci --dry-run', () => {
  write(
    'src/App.tsx',
    "import { useTranslation } from 'react-i18next';\nexport function App() {\n  const { t } = useTranslation('fix');\n  return <p title={t('present.title')}>{t('present.body')}</p>;\n}\n",
  );
  const catalog = { present: { body: 'Body', title: 'Title' } };
  write('locales/en/fix.json', catalog);
  write('locales/ar/fix.json', { present: { body: 'نص', title: 'عنوان' } });

  it('passes when every key the code uses is in the catalogs', async () => {
    expect(await wouldUpdate()).toBe(false);
  });

  it('fails when the code uses a key missing from the catalogs', async () => {
    write(
      'src/Extra.tsx',
      "import { useTranslation } from 'react-i18next';\nexport function Extra() {\n  const { t } = useTranslation('fix');\n  return <p>{t('missing.key')}</p>;\n}\n",
    );
    expect(await wouldUpdate()).toBe(true);
    rmSync(join(dir, 'src/Extra.tsx'));
  });

  it('fails when a key is missing from the ar catalog only', async () => {
    write('locales/ar/fix.json', { present: { body: 'نص' } });
    expect(await wouldUpdate()).toBe(true);
    write('locales/ar/fix.json', { present: { body: 'نص', title: 'عنوان' } });
  });

  it('passes on this package (what `pnpm lint` runs)', async () => {
    const { anyFileUpdated } = await runExtractor(config, {
      isDryRun: true,
      quiet: true,
      logger: quietLogger,
    });
    expect(anyFileUpdated).toBe(false);
  });
});
