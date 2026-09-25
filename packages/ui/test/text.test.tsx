// @vitest-environment jsdom
// Text primitives (§7.3.6, §7.5; AC-7, AC-8 unit level): LTR islands keep code, paths and
// identifiers left-to-right; <T> and isolate() bidi-isolate interpolated values; every component
// example renders.
import type { i18n as I18n } from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_EXAMPLES } from '../src/examples/index.js';
import {
  Code,
  CodeBlock,
  Heading,
  type I18nKey,
  isolate,
  isolateValues,
  Ltr,
  type NamespaceCatalog,
  T,
  Text,
} from '../src/index.js';
import { TEST_LABELS } from './examples.js';
import { makeI18n, render, type Rendered } from './render.js';

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const fixture: NamespaceCatalog = {
  namespace: 'fixture',
  source: { file: { saved: 'Saved {{name}} to {{folder}}' } },
  load: () => Promise.resolve({ file: { saved: 'تم حفظ {{name}} في {{folder}}' } }),
};
// The fixture namespace isn't in the generated key types.
const SAVED = 'fixture:file.saved' as I18nKey;

async function fixtureI18n(locale: 'en' | 'ar'): Promise<I18n> {
  const i18n = await makeI18n('en', [fixture]);
  await i18n.changeLanguage(locale);
  return i18n;
}

describe('LTR islands (§7.3.6)', () => {
  it('Code, CodeBlock and Ltr are dir="ltr" and not translated, even in an RTL page', async () => {
    view = await render(
      <div>
        <Code>a.b</Code>
        <CodeBlock>x = 1</CodeBlock>
        <Ltr>src/app/main.ts</Ltr>
      </div>,
      { locale: 'ar' },
    );
    expect(document.documentElement.dir).toBe('rtl');
    const code = view.container.querySelector('p code, code');
    const pre = view.container.querySelector('pre');
    const bdi = view.container.querySelector('bdi');
    for (const element of [code, pre, bdi]) {
      expect(element?.getAttribute('dir')).toBe('ltr');
      expect(element?.getAttribute('translate')).toBe('no');
    }
    expect(bdi?.hasAttribute('data-ltr')).toBe(true);
    expect(pre?.querySelector('code')?.textContent).toBe('x = 1');
    expect(pre?.className).toContain('whitespace-pre-wrap');
  });
});

describe('<T> and isolate() (§7.3.6)', () => {
  it('wraps each interpolated value in <bdi>, in the translated word order', async () => {
    view = await render(<T i18nKey={SAVED} values={{ name: 'report.pdf', folder: 'مستندات' }} />, {
      i18n: await fixtureI18n('en'),
    });
    expect(view.container.innerHTML).toBe('Saved <bdi>report.pdf</bdi> to <bdi>مستندات</bdi>');
  });

  it('works the same in Arabic', async () => {
    view = await render(
      <T i18nKey={SAVED} values={{ name: 'report.pdf', folder: 'Documents' }} />,
      {
        locale: 'ar',
        i18n: await fixtureI18n('ar'),
      },
    );
    expect(view.container.innerHTML).toBe('تم حفظ <bdi>report.pdf</bdi> في <bdi>Documents</bdi>');
  });

  it('values are text, never markup', async () => {
    view = await render(
      <T i18nKey={SAVED} values={{ name: '<img src=x onerror=alert(1)>', folder: 1 }} />,
      {
        i18n: await fixtureI18n('en'),
      },
    );
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.textContent).toBe('Saved <img src=x onerror=alert(1)> to 1');
  });

  it('a missing key throws in test mode (no silent fallback)', async () => {
    const i18n = await fixtureI18n('en');
    await expect(render(<T i18nKey={'fixture:file.nope' as I18nKey} />, { i18n })).rejects.toThrow(
      /Missing i18n key/,
    );
  });

  it('isolate() and isolateValues() use FSI … PDI for attribute text', () => {
    expect(isolate('report.pdf')).toBe('⁨report.pdf⁩');
    expect(isolateValues({ a: 'x', b: 2 })).toEqual({ a: '⁨x⁩', b: '⁨2⁩' });
  });
});

describe('Text and Heading', () => {
  it('render the semantic element with token classes', async () => {
    view = await render(
      <div>
        <Heading level={2} size={4}>
          H
        </Heading>
        <Text as="span" tone="muted" size="sm" lang="en">
          t
        </Text>
      </div>,
    );
    const h2 = view.container.querySelector('h2');
    expect(h2?.className).toContain('text-lg');
    const span = view.container.querySelector('span');
    expect(span?.className).toContain('text-fg-muted');
    expect(span?.getAttribute('lang')).toBe('en');
  });
});

describe('component examples', () => {
  const cases = ALL_EXAMPLES.flatMap((group) =>
    group.examples.map((example) => [`${group.component}/${example.id}`, example] as const),
  );

  it('ids are unique per component and lowerCamel', () => {
    for (const group of ALL_EXAMPLES) {
      const ids = group.examples.map((example) => example.id);
      expect(new Set(ids).size, group.component).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z][a-zA-Z0-9]*$/);
    }
  });

  it.each(cases)('%s renders in en and ar', async (_name, example) => {
    for (const locale of ['en', 'ar'] as const) {
      view = await render(<>{example.render(TEST_LABELS)}</>, { locale });
      expect(view.container.childElementCount).toBeGreaterThan(0);
      view.unmount();
      view = undefined;
    }
  });
});
