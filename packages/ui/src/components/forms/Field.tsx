// Shared pieces of the form controls (F-001 design §7.5 "Forms"): the visible label (Radix Label,
// so clicking it focuses or toggles the control) with the "(required)" marker, and the
// description and error lines a control points at with aria-describedby.
import { Label } from 'radix-ui';
import type { JSX, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../icons/Icon.js';
import { cn } from '../../lib/cn.js';

export interface FieldLabelProps {
  htmlFor: string;
  id?: string;
  required?: boolean;
  lang?: string;
  className?: string;
  children?: ReactNode;
}

export function FieldLabel({
  htmlFor,
  id,
  required = false,
  lang,
  className,
  children,
}: FieldLabelProps): JSX.Element {
  const { t } = useTranslation('ui');
  return (
    <Label.Root
      htmlFor={htmlFor}
      id={id}
      lang={lang}
      className={cn('text-sm font-medium text-fg', className)}
    >
      {children}
      {required && <span className="text-fg-muted"> {t('field.required')}</span>}
    </Label.Root>
  );
}

/** The ids a control lists in aria-describedby, for the lines that are shown. */
export function describedBy(ids: readonly (string | false | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => typeof id === 'string');
  return present.length === 0 ? undefined : present.join(' ');
}

export function FieldDescription({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <p id={id} className="text-sm text-fg-muted">
      {children}
    </p>
  );
}

export function FieldError({ id, children }: { id: string; children: ReactNode }): JSX.Element {
  return (
    <p id={id} className="flex items-center gap-1 text-sm text-status-danger">
      <Icon name="alert" size="sm" />
      {children}
    </p>
  );
}
