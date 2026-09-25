// The labels @ralysa/ui's component examples render (EXAMPLE_LABELS). Translatable ones come from
// this app's `lab` catalog (`lab:examples.<label>`); code, paths, identifiers, the placeholder
// address and the reference id are data, not copy, and come from samples/example-data.json.
import { EXAMPLE_LABELS, type ExampleLabel, type ExampleLabels } from '@ralysa/ui/examples';
import { useTranslation } from 'react-i18next';
import { exampleValue } from './samples/index.js';

/** Example labels that are data (rendered as LTR islands), not translations. */
export const DATA_LABELS: readonly ExampleLabel[] = [
  'filePath',
  'identifier',
  'commandLine',
  'reference',
  'emailPlaceholder',
];

export function useExampleLabels(): ExampleLabels {
  const { t } = useTranslation('lab');
  // Keys are built from EXAMPLE_LABELS, so they can't be typed or extracted statically; the
  // test mode missing-key handler and test/labels.test.ts check that each one exists.
  const translate = t as unknown as (key: string) => string;
  return Object.fromEntries(
    EXAMPLE_LABELS.map((label) => [
      label,
      DATA_LABELS.includes(label) ? exampleValue(label) : translate(`examples.${label}`),
    ]),
  ) as ExampleLabels;
}
