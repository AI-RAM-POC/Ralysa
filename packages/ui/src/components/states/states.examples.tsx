import type { ComponentExamples } from '../../examples/types.js';
import { Button } from '../actions/Button.js';
import { EmptyState, ErrorState, LoadingState, PermissionDenied } from './States.js';

const noop = (): void => undefined;

export const emptyStateExamples: ComponentExamples = {
  component: 'EmptyState',
  examples: [
    { id: 'default', render: () => <EmptyState headingLevel={3} /> },
    {
      id: 'withAction',
      render: (labels) => (
        <EmptyState headingLevel={3} action={<Button variant="primary">{labels.save}</Button>} />
      ),
    },
  ],
};

export const loadingStateExamples: ComponentExamples = {
  component: 'LoadingState',
  examples: [{ id: 'default', render: () => <LoadingState /> }],
};

export const errorStateExamples: ComponentExamples = {
  component: 'ErrorState',
  examples: [
    {
      id: 'withRetry',
      render: (labels) => (
        <ErrorState headingLevel={3} onRetry={noop} referenceId={labels.reference} />
      ),
    },
  ],
};

export const permissionDeniedExamples: ComponentExamples = {
  component: 'PermissionDenied',
  examples: [
    {
      id: 'requestAccess',
      render: (labels) => (
        <PermissionDenied
          headingLevel={3}
          resource={labels.resource}
          requestAccessHref="#request-access"
        />
      ),
    },
  ],
};
