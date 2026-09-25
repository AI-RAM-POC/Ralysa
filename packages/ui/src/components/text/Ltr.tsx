// LTR islands (F-001 design §7.3.6; AC-7). File paths, identifiers, URLs, command lines and
// version strings stay left-to-right inside an RTL layout. `translate="no"` keeps browser
// translation from rewriting them.
import type { JSX, ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export interface LtrProps {
  className?: string;
  children?: ReactNode;
}

/** An inline LTR run, isolated from the surrounding text: `<bdi dir="ltr">`. */
export function Ltr({ className, children }: LtrProps): JSX.Element {
  return (
    <bdi dir="ltr" translate="no" data-ltr="" className={className}>
      {children}
    </bdi>
  );
}

/** Inline code: `<code dir="ltr">` in the mono stack. */
export function Code({ className, children }: LtrProps): JSX.Element {
  return (
    <code
      dir="ltr"
      translate="no"
      className={cn('rounded-sm bg-subtle px-1 font-mono text-sm text-fg', className)}
    >
      {children}
    </code>
  );
}

/**
 * A code block: `<pre dir="ltr">`. Long lines wrap instead of scrolling, so the block needs no
 * scroll container to be keyboard-reachable and reflows at 320 CSS px (WCAG 1.4.10).
 */
export function CodeBlock({ className, children }: LtrProps): JSX.Element {
  return (
    <pre
      dir="ltr"
      translate="no"
      className={cn(
        'rounded-md bg-subtle p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap wrap-break-word text-fg',
        className,
      )}
    >
      <code>{children}</code>
    </pre>
  );
}
