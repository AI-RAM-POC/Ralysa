import type { ComponentExamples } from '../examples/types.js';
import { Icon } from './Icon.js';
import { ICON_NAMES, ICONS } from './registry.js';

const directional = ICON_NAMES.filter((name) => ICONS[name].directional);
const fixed = ICON_NAMES.filter((name) => !ICONS[name].directional);

export const iconExamples: ComponentExamples = {
  component: 'Icon',
  examples: [
    {
      id: 'directional',
      render: () => (
        <div className="flex flex-wrap gap-3 text-fg" data-icon-strip="directional">
          {directional.map((name) => (
            <Icon key={name} name={name} />
          ))}
        </div>
      ),
    },
    {
      id: 'nonDirectional',
      render: () => (
        <div className="flex flex-wrap gap-3 text-fg" data-icon-strip="non-directional">
          {fixed.map((name) => (
            <Icon key={name} name={name} />
          ))}
        </div>
      ),
    },
    {
      id: 'labelled',
      render: (labels) => <Icon name="info" size="lg" label={labels.iconLabel} />,
    },
  ],
};
