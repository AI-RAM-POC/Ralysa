// Token swatches (F-001 design §7.6 `?view=tokens`): every semantic colour token, its value in
// the current theme and its contrast with the canvas colour, computed with the same WCAG 2.1
// function the contrast gate uses. The authoritative gate is check-contrast (AC-11); this view is
// for looking. Values are read from the live CSS custom properties, so the theme switch updates it.
import { contrastRatio } from '@ralysa/repo-scripts/check-contrast';
import { Code, Heading, T, Text, TOKEN_CSS_VARS } from '@ralysa/ui';
import { type JSX, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

const CANVAS = 'color.bg.canvas';
const HEX = /^#[0-9a-f]{6}$/i;

const colourTokens = (Object.keys(TOKEN_CSS_VARS) as (keyof typeof TOKEN_CSS_VARS)[]).filter(
  (name) => name.startsWith('color.'),
);

/** The live token values, as a JSON string so the snapshot is a stable primitive. */
function snapshot(): string {
  const style = getComputedStyle(document.documentElement);
  return JSON.stringify(
    Object.fromEntries(
      colourTokens.map((name) => [name, style.getPropertyValue(TOKEN_CSS_VARS[name]).trim()]),
    ),
  );
}

/** The values change when ThemeProvider writes data-theme, or the OS scheme changes ("system"). */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  // Not every environment has matchMedia (jsdom); without it only data-theme changes count.
  const { matchMedia } = window as Partial<Pick<Window, 'matchMedia'>>;
  const scheme =
    typeof matchMedia === 'function'
      ? matchMedia.call(window, '(prefers-color-scheme: dark)')
      : null;
  scheme?.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    scheme?.removeEventListener('change', onChange);
  };
}

export function Tokens(): JSX.Element {
  const { t } = useTranslation('lab');
  const values = JSON.parse(useSyncExternalStore(subscribe, snapshot, () => '{}')) as Record<
    string,
    string
  >;
  const canvas = values[CANVAS] ?? '';
  // Western digits in every locale: locale-aware number formatting is F-021's scope (§7.3.6).
  const ratio = (value: string): string | undefined =>
    HEX.test(value) && HEX.test(canvas) ? contrastRatio(value, canvas).toFixed(2) : undefined;
  return (
    <div className="flex flex-col gap-6">
      <Heading level={1}>{t('tokens.heading')}</Heading>
      <Text tone="muted">{t('tokens.intro')}</Text>
      <ul className="grid gap-3 md:grid-cols-2">
        {colourTokens.map((name) => {
          const value = values[name] ?? '';
          const shown = ratio(value);
          return (
            <li
              key={name}
              data-token={name}
              className="flex items-center gap-3 rounded-md border border-border-decor bg-surface p-3"
            >
              <span
                aria-hidden="true"
                className="size-control-md shrink-0 rounded-sm border border-border-control"
                style={{ backgroundColor: `var(${TOKEN_CSS_VARS[name]})` }}
              />
              <span className="flex min-w-0 flex-col gap-1">
                <Code>{name}</Code>
                <Text as="span" size="sm" tone="muted">
                  <Code>{value === '' ? '-' : value}</Code>{' '}
                  {shown === undefined ? (
                    t('tokens.unavailable')
                  ) : (
                    <T i18nKey="lab:tokens.ratio" values={{ ratio: shown }} />
                  )}
                </Text>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
