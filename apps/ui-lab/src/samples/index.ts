// Synthetic demo data (F-001 design §7.6). Everything here carries the `__RALYSA_DEMO_ONLY__`
// sentinel, and check-no-demo fingerprints every sample text so none can reach a shipped build.
import arabicSamples from './arabic-samples.json';
import exampleData from './example-data.json';

/** The sentinel on the ui-lab root and in every sample file (check-no-demo looks for it). */
export const DEMO_SENTINEL = '__RALYSA_DEMO_ONLY__';

export const SAMPLE_CATEGORIES = ['pure', 'mixed', 'westernDigits', 'arabicIndicDigits'] as const;
export type SampleCategory = (typeof SAMPLE_CATEGORIES)[number];

export interface Sample {
  id: string;
  category: SampleCategory;
  text: string;
}

const isCategory = (value: string): value is SampleCategory =>
  (SAMPLE_CATEGORIES as readonly string[]).includes(value);

/** The 20-string Arabic sample set (AC-8), in file order. */
export const ARABIC_SAMPLES: readonly Sample[] = arabicSamples.samples.map((sample) => {
  if (!isCategory(sample.category)) throw new Error(`unknown sample category ${sample.category}`);
  return { id: sample.id, category: sample.category, text: sample.text };
});

/** Non-translatable demo values (code, paths, identifiers, a placeholder, a reference id). */
export const EXAMPLE_DATA: Readonly<Record<string, string>> = Object.fromEntries(
  exampleData.samples.map((sample) => [sample.id, sample.text]),
);

export function exampleValue(id: string): string {
  const value = EXAMPLE_DATA[id];
  if (value === undefined) throw new Error(`no example data called ${id}`);
  return value;
}
