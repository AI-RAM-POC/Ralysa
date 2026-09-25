import type { ComponentExamples } from '../../examples/types.js';
import { Text } from '../text/Text.js';
import { Button, IconButton, Link } from './Button.js';

export const buttonExamples: ComponentExamples = {
  component: 'Button',
  examples: [
    {
      id: 'variants',
      render: (labels) => (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">{labels.save}</Button>
          <Button variant="secondary">{labels.cancel}</Button>
          <Button variant="ghost">{labels.linkText}</Button>
          <Button variant="danger">{labels.delete}</Button>
        </div>
      ),
    },
    {
      id: 'sizes',
      render: (labels) => (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">{labels.save}</Button>
          <Button size="md">{labels.save}</Button>
          <Button size="lg">{labels.save}</Button>
        </div>
      ),
    },
    {
      id: 'withIcon',
      render: (labels) => (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" icon="send">
            {labels.save}
          </Button>
          <Button icon="back">{labels.cancel}</Button>
        </div>
      ),
    },
    {
      id: 'disabled',
      render: (labels) => (
        <Button variant="primary" disabled>
          {labels.save}
        </Button>
      ),
    },
  ],
};

export const iconButtonExamples: ComponentExamples = {
  component: 'IconButton',
  examples: [
    {
      id: 'close',
      render: () => (
        <div className="flex items-center gap-3">
          <IconButton icon="close" labelKey="ui:action.close" size="sm" />
          <IconButton icon="close" labelKey="ui:action.close" />
          <IconButton icon="close" labelKey="ui:action.close" variant="secondary" size="lg" />
        </div>
      ),
    },
  ],
};

export const linkExamples: ComponentExamples = {
  component: 'Link',
  examples: [
    {
      id: 'inline',
      render: (labels) => (
        <Text>
          {labels.paragraph} <Link href="#docs">{labels.linkText}</Link>
        </Text>
      ),
    },
  ],
};
