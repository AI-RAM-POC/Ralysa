// Test helper: a labels object for rendering component examples. The ui-lab gallery supplies
// these from its `lab` catalog; tests use plain strings (test files are exempt from AC-5).
import { EXAMPLE_LABELS, type ExampleLabels } from '../src/examples/index.js';

export const TEST_LABELS: ExampleLabels = Object.fromEntries(
  EXAMPLE_LABELS.map((label) => [label, `[${label}]`]),
) as ExampleLabels;
