// The component gallery (F-001 design §7.5, §7.6 `?view=components&c=<name>`; AC-10): every
// example from @ralysa/ui/examples, or one component's. Component names and example ids are
// identifiers, so they render as LTR islands rather than translations.
import { Code, Heading, Ltr, T, Text } from '@ralysa/ui';
import { ALL_EXAMPLES, type ComponentExamples } from '@ralysa/ui/examples';
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { useExampleLabels } from '../labels.js';

function ComponentSection({ group }: { group: ComponentExamples }): JSX.Element {
  const labels = useExampleLabels();
  const headingId = `component-${group.component}`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4"
      data-component={group.component}
    >
      <Heading level={2} size={3} id={headingId}>
        <Ltr>{group.component}</Ltr>
      </Heading>
      {group.examples.map((example) => (
        <div key={example.id} className="flex flex-col gap-2">
          <Text as="span" size="sm" tone="muted">
            <Code>{example.id}</Code>
          </Text>
          <div
            className="rounded-md border border-border-decor bg-surface p-6"
            data-example={`${group.component}/${example.id}`}
          >
            {example.render(labels)}
          </div>
        </div>
      ))}
    </section>
  );
}

export function Components({ component }: { component?: string }): JSX.Element {
  const { t } = useTranslation('lab');
  const groups =
    component === undefined ? ALL_EXAMPLES : ALL_EXAMPLES.filter((g) => g.component === component);
  return (
    <div className="flex flex-col gap-10">
      <Heading level={1}>{t('components.heading')}</Heading>
      {groups.length === 0 && component !== undefined && (
        <p role="status" className="text-md text-fg">
          <T i18nKey="lab:components.notFound" values={{ name: component }} />
        </p>
      )}
      {groups.map((group) => (
        <ComponentSection key={group.component} group={group} />
      ))}
    </div>
  );
}
