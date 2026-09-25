// Layout (F-001 design §7.5 "Layout", §7.3.5; AC-7, AC-12). Regions are laid out with flex in DOM
// reading order, so under dir="rtl" the inline-start region (nav) lands on the right with no
// extra rule, and Tab follows the visual order. Landmarks are named with i18n keys.
import type { JSX, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn.js';

export interface VisuallyHiddenProps {
  children?: ReactNode;
}

/** Text for assistive technology only (kept in the accessibility tree, off screen). */
export function VisuallyHidden({ children }: VisuallyHiddenProps): JSX.Element {
  return <span className="sr-only">{children}</span>;
}

export interface SkipLinkProps {
  /** The id of the element to skip to (the main landmark). */
  target?: string;
}

/** The first focusable element on a page: hidden until focused, then jumps to the main landmark. */
export function SkipLink({ target = 'main' }: SkipLinkProps): JSX.Element {
  const { t } = useTranslation('ui');
  return (
    <a
      href={`#${target}`}
      className="sr-only rounded-md bg-surface px-4 py-2 text-link shadow-md focus:not-sr-only focus:fixed focus:top-2 focus:inset-s-2 focus:z-(--ralysa-elevation-layer-toast) focus-visible:focus-ring"
    >
      {t('skipLink.label')}
    </a>
  );
}

export interface AppShellProps {
  /** Banner content (product name, LocaleSwitcher, ThemeSwitcher). */
  header?: ReactNode;
  /** Inline-start navigation region. */
  nav?: ReactNode;
  /** Inline-end complementary region. */
  aside?: ReactNode;
  /** Translated accessible names; default to the ui catalog's. */
  navLabel?: string;
  asideLabel?: string;
  mainId?: string;
  className?: string;
  children?: ReactNode;
}

export function AppShell({
  header,
  nav,
  aside,
  navLabel,
  asideLabel,
  mainId = 'main',
  className,
  children,
}: AppShellProps): JSX.Element {
  const { t } = useTranslation('ui');
  return (
    <div className={cn('flex min-h-dvh flex-col bg-canvas text-fg', className)}>
      <SkipLink target={mainId} />
      {header !== undefined && (
        <header
          data-region="header"
          className="flex flex-wrap items-center gap-4 border-b border-border-decor bg-surface px-6 py-3"
        >
          {header}
        </header>
      )}
      <div className="flex flex-1 flex-col md:flex-row">
        {nav !== undefined && (
          <nav
            data-region="nav"
            aria-label={navLabel ?? t('appShell.nav.label')}
            className="bg-subtle p-4 md:w-1/5"
          >
            {nav}
          </nav>
        )}
        <main
          id={mainId}
          data-region="main"
          tabIndex={-1}
          className="min-w-0 flex-1 p-6 focus-visible:focus-ring"
        >
          {children}
        </main>
        {aside !== undefined && (
          <aside
            data-region="aside"
            aria-label={asideLabel ?? t('appShell.aside.label')}
            className="border-t border-border-decor bg-surface p-4 md:w-1/4 md:border-t-0 md:border-s"
          >
            {aside}
          </aside>
        )}
      </div>
    </div>
  );
}
