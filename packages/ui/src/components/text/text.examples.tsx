import type { ComponentExamples } from '../../examples/types.js';
import { Code, CodeBlock, Ltr } from './Ltr.js';
import { Heading, Text } from './Text.js';

export const textExamples: ComponentExamples = {
  component: 'Text',
  examples: [
    {
      id: 'tones',
      render: (labels) => (
        <div className="flex flex-col gap-2">
          <Text>{labels.paragraph}</Text>
          <Text tone="muted" size="sm">
            {labels.mutedText}
          </Text>
        </div>
      ),
    },
  ],
};

export const headingExamples: ComponentExamples = {
  component: 'Heading',
  examples: [
    {
      id: 'levels',
      render: (labels) => (
        <div className="flex flex-col gap-2">
          <Heading level={2}>{labels.heading}</Heading>
          <Heading level={3}>{labels.heading}</Heading>
        </div>
      ),
    },
  ],
};

export const ltrExamples: ComponentExamples = {
  component: 'Code',
  examples: [
    {
      id: 'inline',
      render: (labels) => (
        <Text>
          {labels.paragraph} <Code>{labels.identifier}</Code> <Ltr>{labels.filePath}</Ltr>
        </Text>
      ),
    },
    {
      id: 'block',
      render: (labels) => <CodeBlock>{labels.commandLine}</CodeBlock>,
    },
  ],
};
