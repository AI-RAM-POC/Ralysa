// <T> and isolate() (F-001 design §7.3.6; AC-7, AC-8): bidi isolation for values interpolated
// into translated strings. A value of the other direction (a Latin file name in an Arabic
// sentence, an Arabic name in an English one) must not reorder the text around it.
//   - <T i18nKey values> renders the translation and wraps each interpolated value in <bdi>.
//   - isolate() / isolateValues() wrap values in FSI…PDI (U+2068…U+2069) for plain-text
//     contexts such as aria-label or title, where no element can be used.
// Values are text, never markup: React escapes them.
import type { Namespace, ParseKeys } from 'i18next';
import { createElement, Fragment, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** A typed i18n key of the app's namespaces (`ns:area.element`, or the default namespace's). */
export type I18nKey = ParseKeys<Namespace>;

export type InterpolationValues = Readonly<Record<string, string | number>>;

const FSI = '⁨';
const PDI = '⁩';

/** Wraps a value in FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE. */
export function isolate(value: string | number): string {
  return `${FSI}${String(value)}${PDI}`;
}

/** isolate() applied to every value, for t(key, isolateValues(values)) in attribute text. */
export function isolateValues(values: InterpolationValues): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, isolate(value)]));
}

// Private-use markers stand in for the values while i18next interpolates, so the translated
// string can be split around them. They never reach the DOM.
const MARKER = /(\d+)/;
const marker = (index: number): string => `${String(index)}`;

export interface TProps {
  i18nKey: I18nKey;
  values?: InterpolationValues;
}

export function T({ i18nKey, values = {} }: TProps): JSX.Element {
  const { t } = useTranslation();
  const names = Object.keys(values);
  const markers = Object.fromEntries(names.map((name, index) => [name, marker(index)]));
  const translate = t as unknown as (key: string, options: Record<string, string>) => string;
  const parts = translate(i18nKey, markers).split(MARKER);
  const nodes: ReactNode[] = parts.map((part, index) => {
    if (index % 2 === 0) return part;
    const name = names[Number(part)] ?? '';
    return createElement('bdi', { key: `v${String(index)}` }, String(values[name] ?? ''));
  });
  return createElement(Fragment, null, ...nodes);
}
