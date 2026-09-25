// State patterns (F-001 design §7.5 "States", §7.7): the empty, loading, error and
// permission-denied states every Phase 1 data view reuses. Each has default copy from the ui
// catalog and accepts translated overrides.
// - LoadingState is a polite live region with aria-busy; its spinner turns only when the user
//   hasn't asked for reduced motion.
// - ErrorState is role="alert" and takes no error object: raw error text (stack traces, server
//   messages, document content) never reaches the screen. A support reference id may be shown.
// - PermissionDenied offers "Request access" as a link to the web console (spec §6.1.3).
import type { JSX, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../icons/Icon.js';
import { cn } from '../../lib/cn.js';
import { Button, Link } from '../actions/Button.js';
import { T } from '../text/T.js';
import { Heading, type HeadingLevel, Text } from '../text/Text.js';

const FRAME = 'flex flex-col items-center gap-3 rounded-md p-8 text-center';

export interface StateProps {
  /** Translated title; defaults to the ui catalog's. */
  title?: ReactNode;
  /** Translated description; defaults to the ui catalog's. */
  description?: ReactNode;
  /** The heading level that fits the page outline. Default 2. */
  headingLevel?: HeadingLevel;
  className?: string;
}

export interface EmptyStateProps extends StateProps {
  /** A call to action, e.g. a Button. */
  action?: ReactNode;
}

export function EmptyState({
  title,
  description,
  headingLevel = 2,
  action,
  className,
}: EmptyStateProps): JSX.Element {
  const { t } = useTranslation('ui');
  return (
    <div data-state="empty" className={cn(FRAME, className)}>
      <Icon name="inbox" size="lg" className="text-fg-muted" />
      <Heading level={headingLevel} size={4}>
        {title ?? t('emptyState.title')}
      </Heading>
      <Text tone="muted">{description ?? t('emptyState.description')}</Text>
      {action}
    </div>
  );
}

export interface LoadingStateProps {
  /** Translated label; defaults to "Loading…". */
  label?: string;
  className?: string;
}

export function LoadingState({ label, className }: LoadingStateProps): JSX.Element {
  const { t } = useTranslation('ui');
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-state="loading"
      className={cn(FRAME, className)}
    >
      <Icon name="loading" size="lg" className="text-fg-muted motion-safe:animate-spin" />
      <Text tone="muted">{label ?? t('loadingState.label')}</Text>
    </div>
  );
}

export interface ErrorStateProps extends StateProps {
  /** Shows a "Try again" button that calls this. */
  onRetry?: () => void;
  /** A support reference (correlation id), shown as an isolated LTR value. */
  referenceId?: string;
}

export function ErrorState({
  title,
  description,
  headingLevel = 2,
  onRetry,
  referenceId,
  className,
}: ErrorStateProps): JSX.Element {
  const { t } = useTranslation('ui');
  return (
    <div role="alert" data-state="error" className={cn(FRAME, className)}>
      <Icon name="alert" size="lg" className="text-status-danger" />
      <Heading level={headingLevel} size={4}>
        {title ?? t('errorState.title')}
      </Heading>
      <Text tone="muted">{description ?? t('errorState.description')}</Text>
      {referenceId !== undefined && (
        <Text tone="muted" size="sm">
          <T i18nKey="ui:errorState.reference" values={{ id: referenceId }} />
        </Text>
      )}
      {onRetry !== undefined && (
        <Button variant="secondary" onClick={onRetry}>
          {t('errorState.retry')}
        </Button>
      )}
    </div>
  );
}

export interface PermissionDeniedProps extends Omit<StateProps, 'description'> {
  /** The translated name of what the user can't open; shown bidi-isolated. */
  resource: string;
  /** Deep link to the access request in the web console. Without it, no link is shown. */
  requestAccessHref?: string;
}

export function PermissionDenied({
  title,
  resource,
  requestAccessHref,
  headingLevel = 2,
  className,
}: PermissionDeniedProps): JSX.Element {
  const { t } = useTranslation('ui');
  return (
    <div data-state="permission-denied" className={cn(FRAME, className)}>
      <Icon name="lock" size="lg" className="text-fg-muted" />
      <Heading level={headingLevel} size={4}>
        {title ?? t('permissionDenied.title')}
      </Heading>
      <Text tone="muted">
        <T i18nKey="ui:permissionDenied.description" values={{ resource }} />
      </Text>
      {requestAccessHref !== undefined && (
        <Link href={requestAccessHref}>{t('permissionDenied.requestAccess')}</Link>
      )}
    </div>
  );
}
