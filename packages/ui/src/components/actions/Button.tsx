// Actions (F-001 design §7.5 "Actions", §7.7; AC-11, AC-12). Native <button> and <a>, so Enter
// and Space work without extra code. Colours are semantic tokens whose pairs are in
// tokens/contrast-pairs.json; focus shows the shared ring (focus-visible:focus-ring). Targets are
// at least size.control.sm (32 px, above the WCAG 2.2 24 px minimum).
import type { ComponentPropsWithRef, JSX, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../icons/Icon.js';
import type { IconName } from '../../icons/registry.js';
import { cn } from '../../lib/cn.js';
import type { I18nKey } from '../text/T.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-md border font-medium focus-visible:focus-ring disabled:cursor-not-allowed disabled:border-border-decor disabled:bg-subtle disabled:text-fg-disabled';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border-accent bg-accent text-fg-on-accent hover:border-accent-hover hover:bg-accent-hover',
  secondary: 'border-border-control bg-surface text-fg hover:bg-subtle',
  ghost: 'border-transparent bg-transparent text-fg hover:bg-subtle',
  danger: 'border-status-danger bg-status-danger text-fg-on-accent hover:shadow-md',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-control-sm px-3 text-sm',
  md: 'min-h-control-md px-4 text-md',
  lg: 'min-h-control-lg px-5 text-lg',
};

const SQUARE: Record<ButtonSize, string> = {
  sm: 'size-control-sm',
  md: 'size-control-md',
  lg: 'size-control-lg',
};

export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A decorative icon before the label (mirrors in RTL if directional). */
  icon?: IconName;
  className?: string;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      // Default to "button" so a Button in a form never submits by accident; pass type="submit".
      type={type}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
    >
      {icon !== undefined && <Icon name={icon} size={size === 'lg' ? 'md' : 'sm'} />}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<
  ComponentPropsWithRef<'button'>,
  'className' | 'children' | 'aria-label'
> {
  icon: IconName;
  /** Required: the accessible name, as a typed i18n key (an icon alone has no text). */
  labelKey: I18nKey;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

/** A square button showing only an icon; its name comes from `labelKey`. */
export function IconButton({
  icon,
  labelKey,
  variant = 'ghost',
  size = 'md',
  type = 'button',
  className,
  ...rest
}: IconButtonProps): JSX.Element {
  const { t } = useTranslation();
  const label = (t as unknown as (key: string) => string)(labelKey);
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      className={cn(BASE, VARIANTS[variant], SQUARE[size], className)}
    >
      <Icon name={icon} size={size === 'lg' ? 'lg' : 'md'} />
    </button>
  );
}

export interface LinkProps extends Omit<ComponentPropsWithRef<'a'>, 'className'> {
  href: string;
  className?: string;
  children?: ReactNode;
}

/** An inline text link: underlined, color.link, focus ring. */
export function Link({ className, children, ...rest }: LinkProps): JSX.Element {
  return (
    <a
      {...rest}
      className={cn(
        'rounded-sm text-link underline underline-offset-2 hover:no-underline focus-visible:focus-ring',
        className,
      )}
    >
      {children}
    </a>
  );
}
