// Text primitives (F-001 design §7.5 "Text"). Sizes, weights and colours are tokens only.
// Every string a caller passes is already translated (AC-5); `lang` marks an inline
// foreign-language span (WCAG 3.1.2).
import type { JSX, ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export type TextSize = 'xs' | 'sm' | 'md' | 'lg';
export type TextTone = 'default' | 'muted' | 'danger' | 'success' | 'warning';

const TEXT_SIZES: Record<TextSize, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
  md: 'text-md',
  lg: 'text-lg',
};

const TONES: Record<TextTone, string> = {
  default: 'text-fg',
  muted: 'text-fg-muted',
  danger: 'text-status-danger',
  success: 'text-status-success',
  warning: 'text-status-warning',
};

export interface TextProps {
  as?: 'p' | 'span' | 'div' | 'strong' | 'em';
  size?: TextSize;
  tone?: TextTone;
  weight?: 'regular' | 'medium' | 'semibold';
  lang?: string;
  id?: string;
  className?: string;
  children?: ReactNode;
}

const WEIGHTS = { regular: 'font-regular', medium: 'font-medium', semibold: 'font-semibold' };

export function Text({
  as: Element = 'p',
  size = 'md',
  tone = 'default',
  weight = 'regular',
  lang,
  id,
  className,
  children,
}: TextProps): JSX.Element {
  return (
    <Element
      id={id}
      lang={lang}
      className={cn(TEXT_SIZES[size], TONES[tone], WEIGHTS[weight], className)}
    >
      {children}
    </Element>
  );
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

const HEADING_SIZES: Record<HeadingLevel, string> = {
  1: 'text-3xl',
  2: 'text-2xl',
  3: 'text-xl',
  4: 'text-lg',
  5: 'text-md',
  6: 'text-sm',
};

export interface HeadingProps {
  level: HeadingLevel;
  /** Visual size, when it must differ from the level (the outline stays semantic). */
  size?: HeadingLevel;
  id?: string;
  className?: string;
  children?: ReactNode;
}

export function Heading({
  level,
  size = level,
  id,
  className,
  children,
}: HeadingProps): JSX.Element {
  const Element = `h${String(level)}` as `h${HeadingLevel}`;
  return (
    <Element
      id={id}
      className={cn('font-semibold leading-tight text-fg', HEADING_SIZES[size], className)}
    >
      {children}
    </Element>
  );
}
