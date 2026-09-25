import type { ComponentExamples } from '../../examples/types.js';
import { Text } from '../text/Text.js';
import { AppShell, VisuallyHidden } from './AppShell.js';

export const appShellExamples: ComponentExamples = {
  component: 'AppShell',
  examples: [
    {
      id: 'regions',
      render: (labels) => (
        // A contained copy for the gallery: the real shell fills the viewport.
        <AppShell
          className="min-h-0 rounded-md border border-border-decor"
          mainId="appShellExampleMain"
          header={<Text weight="semibold">{labels.shellTitle}</Text>}
          nav={<Text>{labels.navItem}</Text>}
          aside={<Text tone="muted">{labels.asideText}</Text>}
        >
          <Text>{labels.mainText}</Text>
        </AppShell>
      ),
    },
  ],
};

export const visuallyHiddenExamples: ComponentExamples = {
  component: 'VisuallyHidden',
  examples: [
    {
      id: 'screenReaderText',
      render: (labels) => (
        <Text>
          {labels.paragraph}
          <VisuallyHidden>{labels.mutedText}</VisuallyHidden>
        </Text>
      ),
    },
  ],
};
