// `@ralysa/ui/examples`: every component's examples, for the apps/ui-lab gallery. A separate
// entry point, so an app that imports `@ralysa/ui` never bundles them.
import { headingExamples, ltrExamples, textExamples } from '../components/text/text.examples.js';
import { iconExamples } from '../icons/icon.examples.js';
import type { ComponentExamples } from './types.js';

export const ALL_EXAMPLES: readonly ComponentExamples[] = [
  textExamples,
  headingExamples,
  ltrExamples,
  iconExamples,
];

export {
  type ComponentExample,
  type ComponentExamples,
  EXAMPLE_LABELS,
  type ExampleLabel,
  type ExampleLabels,
} from './types.js';
