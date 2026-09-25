// @vitest-environment jsdom
// ThemeProvider plumbing (F-001 design §7.1.1): `data-theme` on <html> selects the token block;
// "system" removes it so prefers-color-scheme applies.
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTheme,
  resolveInitialTheme,
  THEME_STORAGE_KEY,
  ThemeProvider,
  tokenVar,
  useTheme,
} from '../src/index.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.body.innerHTML = '';
});

describe('resolveInitialTheme', () => {
  const storage = (value: string | null): Pick<Storage, 'getItem'> => ({ getItem: () => value });

  it('prefers the ?theme= query parameter', () => {
    expect(resolveInitialTheme({ search: '?theme=dark', storage: storage('light') })).toBe('dark');
  });

  it('falls back to storage, then to system', () => {
    expect(resolveInitialTheme({ search: '?theme=purple', storage: storage('light') })).toBe(
      'light',
    );
    expect(resolveInitialTheme({ storage: storage('nonsense') })).toBe('system');
    expect(resolveInitialTheme()).toBe('system');
  });

  it('survives storage that throws', () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error(`blocked: ${THEME_STORAGE_KEY}`);
      },
    };
    expect(resolveInitialTheme({ storage: throwing })).toBe('system');
  });
});

describe('ThemeProvider', () => {
  let setPreference: ReturnType<typeof useTheme>['setPreference'] = () => undefined;
  function Probe(): JSX.Element {
    const theme = useTheme();
    setPreference = theme.setPreference;
    return <span data-preference={theme.preference} />;
  }

  it('writes data-theme on <html> and removes it for "system"', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider initial="dark">
          <Probe />
        </ThemeProvider>,
      );
    });
    expect(document.documentElement.dataset.theme).toBe('dark');

    act(() => {
      setPreference('light');
    });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(container.querySelector('[data-preference]')?.getAttribute('data-preference')).toBe(
      'light',
    );

    act(() => {
      setPreference('system');
    });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    act(() => {
      root.unmount();
    });
  });

  it('useTheme outside the provider throws a clear error', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    expect(() => {
      act(() => {
        root.render(<Probe />);
      });
    }).toThrow(/inside <ThemeProvider>/);
  });

  it('applyTheme targets any element', () => {
    const element = document.createElement('section');
    applyTheme(element, 'dark');
    expect(element.dataset.theme).toBe('dark');
  });
});

describe('tokenVar', () => {
  it('returns the CSS variable reference', () => {
    expect(tokenVar('color.bg.canvas')).toBe('var(--ralysa-color-bg-canvas)');
  });
});
