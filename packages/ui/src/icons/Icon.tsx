// <Icon name> (F-001 design §3.4, §7.3.5; AC-7). Renders a registry icon. Directional icons get
// `rtl:-scale-x-100`, so they mirror whenever the element is in an RTL context; non-directional
// icons never do. `data-icon-directional` states which is which (the E2E mirroring spec reads it).
// Icons are decorative (aria-hidden) unless given a `label`, a translated string. An icon-only
// control names itself instead: see IconButton's `labelKey`.
import type { JSX } from 'react';
import { cn } from '../lib/cn.js';
import { ICONS, type IconName } from './registry.js';

export type IconSize = 'sm' | 'md' | 'lg';

const SIZES: Record<IconSize, string> = {
  sm: 'size-icon-sm',
  md: 'size-icon-md',
  lg: 'size-icon-lg',
};

export interface IconProps {
  name: IconName;
  size?: IconSize;
  /** A translated accessible name. Omit for a decorative icon next to visible text. */
  label?: string;
  className?: string;
}

export function Icon({ name, size = 'md', label, className }: IconProps): JSX.Element {
  const { component: Glyph, directional } = ICONS[name];
  return (
    <Glyph
      aria-hidden={label === undefined ? true : undefined}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      focusable="false"
      data-icon={name}
      data-icon-directional={directional ? 'true' : 'false'}
      className={cn('shrink-0', SIZES[size], directional && 'rtl:-scale-x-100', className)}
    />
  );
}
