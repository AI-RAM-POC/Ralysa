import type { ComponentExamples } from '../../examples/types.js';
import { LocaleSwitcher, ThemeSwitcher } from './Switchers.js';

export const localeSwitcherExamples: ComponentExamples = {
  component: 'LocaleSwitcher',
  examples: [{ id: 'default', render: () => <LocaleSwitcher className="max-w-sm" /> }],
};

export const themeSwitcherExamples: ComponentExamples = {
  component: 'ThemeSwitcher',
  examples: [{ id: 'default', render: () => <ThemeSwitcher /> }],
};
