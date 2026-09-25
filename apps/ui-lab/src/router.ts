// Query-parameter router (F-001 design §7.6): no router dependency.
//   ?view=showcase (default) | components[&c=<Component>] | tokens
//   &lang=en|ar and &theme=light|dark|system are read at start-up by @ralysa/ui and kept in
//   every link, so tests and screenshots can address any view in any configuration.
import type { Locale, ThemePreference } from '@ralysa/ui';

export const VIEWS = ['showcase', 'components', 'tokens'] as const;
export type View = (typeof VIEWS)[number];

export interface Route {
  view: View;
  /** components view: one component's examples, by export name. */
  component?: string;
}

const isView = (value: string | null): value is View =>
  value !== null && (VIEWS as readonly string[]).includes(value);

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  const component = params.get('c') ?? undefined;
  if (!isView(view)) return { view: 'showcase' };
  return view === 'components' && component !== undefined ? { view, component } : { view };
}

export function hrefFor(
  route: Route,
  { locale, theme }: { locale: Locale; theme: ThemePreference },
): string {
  const params = new URLSearchParams({ view: route.view });
  if (route.component !== undefined) params.set('c', route.component);
  params.set('lang', locale);
  params.set('theme', theme);
  return `?${params.toString()}`;
}
