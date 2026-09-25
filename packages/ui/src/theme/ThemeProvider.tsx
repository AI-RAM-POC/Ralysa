// Theme plumbing (F-001 design §7.1.1, §7.5): the ThemeProvider writes `data-theme` on <html>,
// which selects the light or dark token block in tokens.css. "system" removes the attribute, so
// the prefers-color-scheme block applies. The ThemeSwitcher control arrives with T11.
import {
  createContext,
  type JSX,
  type ReactNode,
  use,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { TOKEN_THEMES, type TokenTheme } from '../tokens/index.js';

export type ThemePreference = TokenTheme | 'system';
export const THEME_PREFERENCES: readonly ThemePreference[] = [...TOKEN_THEMES, 'system'];
export const THEME_STORAGE_KEY = 'ralysa.theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export interface InitialThemeSources {
  /** `location.search`; `?theme=light|dark|system` wins (ui-lab and tests). */
  search?: string;
  /** Development convenience only (§7.4.2 uses the same order for the locale). */
  storage?: Pick<Storage, 'getItem'> | null;
}

/** Picks the first valid preference from the query string, then storage, else "system". */
export function resolveInitialTheme({
  search,
  storage,
}: InitialThemeSources = {}): ThemePreference {
  const fromQuery = new URLSearchParams(search ?? '').get('theme');
  if (isThemePreference(fromQuery)) return fromQuery;
  let stored: string | null = null;
  try {
    stored = storage?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    // Storage can throw (privacy mode, blocked site data): fall through to the default.
  }
  return isThemePreference(stored) ? stored : 'system';
}

/** Applies a preference to an element (normally <html>). */
export function applyTheme(element: HTMLElement, preference: ThemePreference): void {
  if (preference === 'system') delete element.dataset.theme;
  else element.dataset.theme = preference;
}

interface ThemeContextValue {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  initial?: ThemePreference;
  /** Defaults to document.documentElement. */
  target?: HTMLElement;
  children?: ReactNode;
}

export function ThemeProvider({
  initial = 'system',
  target,
  children,
}: ThemeProviderProps): JSX.Element {
  const [preference, setPreference] = useState<ThemePreference>(initial);
  useLayoutEffect(() => {
    applyTheme(target ?? document.documentElement, preference);
  }, [preference, target]);
  const value = useMemo(() => ({ preference, setPreference }), [preference]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const context = use(ThemeContext);
  if (context === null) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}
