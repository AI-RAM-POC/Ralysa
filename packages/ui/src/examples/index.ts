// `@ralysa/ui/examples`: every component's examples, for the apps/ui-lab gallery. A separate
// entry point, so an app that imports `@ralysa/ui` never bundles them.
import {
  buttonExamples,
  iconButtonExamples,
  linkExamples,
} from '../components/actions/actions.examples.js';
import {
  checkboxExamples,
  radioGroupExamples,
  selectExamples,
  tabsExamples,
  textFieldExamples,
} from '../components/forms/forms.examples.js';
import { appShellExamples, visuallyHiddenExamples } from '../components/layout/layout.examples.js';
import {
  emptyStateExamples,
  errorStateExamples,
  loadingStateExamples,
  permissionDeniedExamples,
} from '../components/states/states.examples.js';
import {
  localeSwitcherExamples,
  themeSwitcherExamples,
} from '../components/preferences/preferences.examples.js';
import { headingExamples, ltrExamples, textExamples } from '../components/text/text.examples.js';
import { iconExamples } from '../icons/icon.examples.js';
import type { ComponentExamples } from './types.js';

export const ALL_EXAMPLES: readonly ComponentExamples[] = [
  textExamples,
  headingExamples,
  ltrExamples,
  iconExamples,
  appShellExamples,
  visuallyHiddenExamples,
  buttonExamples,
  iconButtonExamples,
  linkExamples,
  emptyStateExamples,
  loadingStateExamples,
  errorStateExamples,
  permissionDeniedExamples,
  textFieldExamples,
  checkboxExamples,
  radioGroupExamples,
  selectExamples,
  tabsExamples,
  localeSwitcherExamples,
  themeSwitcherExamples,
];

export {
  type ComponentExample,
  type ComponentExamples,
  EXAMPLE_LABELS,
  type ExampleLabel,
  type ExampleLabels,
} from './types.js';
