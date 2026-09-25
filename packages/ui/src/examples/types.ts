// Component examples (F-001 design §7.5): each component ships a `*.examples.tsx` that the
// apps/ui-lab gallery registers, and every example is scanned by axe in en and ar (AC-10).
//
// Examples hold no text of their own. The gallery passes `labels`, which it translates from its
// own `lab` catalog (`lab:examples.<label>`). So example copy never enters the `ui` catalog that
// ships with every app (AC-13), and it still comes from i18n keys (AC-5). A new label is added to
// EXAMPLE_LABELS here and to the lab catalogs in apps/ui-lab (a test there checks both).
import type { ReactNode } from 'react';

export const EXAMPLE_LABELS = [
  // Text (T09)
  'heading',
  'paragraph',
  'mutedText',
  'filePath',
  'identifier',
  'commandLine',
  'iconLabel',
  // Layout, actions and states (T10)
  'shellTitle',
  'navItem',
  'mainText',
  'asideText',
  'save',
  'cancel',
  'delete',
  'linkText',
  'resource',
  'reference',
] as const;

export type ExampleLabel = (typeof EXAMPLE_LABELS)[number];
export type ExampleLabels = Readonly<Record<ExampleLabel, string>>;

export interface ComponentExample {
  /** Unique within the component, lowerCamel. */
  id: string;
  render: (labels: ExampleLabels) => ReactNode;
}

export interface ComponentExamples {
  /** The component's export name, e.g. "Button". */
  component: string;
  examples: readonly ComponentExample[];
}
