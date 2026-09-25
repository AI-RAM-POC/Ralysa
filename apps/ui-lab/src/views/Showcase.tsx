// The demo screen (F-001 design §7.6 `?view=showcase`; AC-6 to AC-12): a form, the directional
// and non-directional icon strips, the 20-string Arabic sample panel, code and paths as LTR
// islands, and the four state patterns. Regions and the header come from App's AppShell.
import {
  Button,
  Checkbox,
  cn,
  Code,
  CodeBlock,
  EmptyState,
  ErrorState,
  Heading,
  Icon,
  ICON_NAMES,
  ICONS,
  LoadingState,
  Ltr,
  PermissionDenied,
  RadioGroup,
  Select,
  Text,
  TextField,
} from '@ralysa/ui';
import { type JSX, type ReactNode, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useExampleLabels } from '../labels.js';
import { ARABIC_SAMPLES, exampleValue } from '../samples/index.js';

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <Heading level={2} size={3} id={id}>
        {title}
      </Heading>
      {children}
    </section>
  );
}

const PANEL = 'rounded-md border border-border-decor bg-surface p-6';

function RequestForm(): JSX.Element {
  const { t } = useTranslation('lab');
  return (
    <form
      className={cn(PANEL, 'flex max-w-xl flex-col gap-5')}
      onSubmit={(event) => {
        event.preventDefault();
      }}
      noValidate
    >
      <TextField
        name="name"
        label={t('showcase.form.name')}
        description={t('showcase.form.nameHint')}
        autoComplete="name"
        required
      />
      <TextField
        name="email"
        type="email"
        label={t('showcase.form.email')}
        placeholder={exampleValue('emailPlaceholder')}
        autoComplete="email"
      />
      <Select
        name="department"
        label={t('showcase.form.department')}
        options={[
          { value: 'finance', label: t('showcase.department.finance') },
          { value: 'hr', label: t('showcase.department.hr') },
          { value: 'sales', label: t('showcase.department.sales') },
        ]}
      />
      <RadioGroup
        name="priority"
        label={t('showcase.form.priority')}
        orientation="horizontal"
        defaultValue="normal"
        options={[
          { value: 'low', label: t('showcase.priority.low') },
          { value: 'normal', label: t('showcase.priority.normal') },
          { value: 'high', label: t('showcase.priority.high') },
        ]}
      />
      <Checkbox name="notify" label={t('showcase.form.notify')} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" icon="send">
          {t('showcase.form.submit')}
        </Button>
        <Button variant="secondary">{t('showcase.form.cancel')}</Button>
      </div>
    </form>
  );
}

function IconStrips(): JSX.Element {
  const { t } = useTranslation('lab');
  const strip = (directional: boolean): JSX.Element => (
    <div
      className="flex flex-wrap gap-4 text-fg"
      data-icon-strip={directional ? 'directional' : 'non-directional'}
    >
      {ICON_NAMES.filter((name) => ICONS[name].directional === directional).map((name) => (
        <Icon key={name} name={name} size="lg" />
      ))}
    </div>
  );
  return (
    <div className={cn(PANEL, 'flex flex-col gap-4')}>
      <Text tone="muted">{t('showcase.icons.directional')}</Text>
      {strip(true)}
      <Text tone="muted">{t('showcase.icons.nonDirectional')}</Text>
      {strip(false)}
    </div>
  );
}

function SamplePanel(): JSX.Element {
  const { t } = useTranslation('lab');
  const category = {
    pure: t('showcase.samples.category.pure'),
    mixed: t('showcase.samples.category.mixed'),
    westernDigits: t('showcase.samples.category.westernDigits'),
    arabicIndicDigits: t('showcase.samples.category.arabicIndicDigits'),
  };
  return (
    <ol className={cn(PANEL, 'flex flex-col gap-4')} data-sample-panel="">
      {ARABIC_SAMPLES.map((sample) => (
        <li key={sample.id} data-sample-id={sample.id} className="flex flex-col gap-1">
          <Text as="span" size="xs" tone="muted">
            {category[sample.category]}
          </Text>
          <p lang="ar" dir="rtl" className="text-lg text-fg">
            {sample.text}
          </p>
        </li>
      ))}
    </ol>
  );
}

function CodePanel(): JSX.Element {
  const { t } = useTranslation('lab');
  // Data, not copy: shown as LTR islands (§7.3.6).
  const path = exampleValue('sourcePath');
  const identifier = exampleValue('identifier');
  const commands = exampleValue('commandLine');
  return (
    <div className={cn(PANEL, 'flex flex-col gap-3')}>
      <Text>
        {t('showcase.code.intro')} <Ltr>{path}</Ltr> <Code>{identifier}</Code>
      </Text>
      <CodeBlock>{commands}</CodeBlock>
    </div>
  );
}

function StatesPanel(): JSX.Element {
  const labels = useExampleLabels();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <EmptyState headingLevel={3} className={PANEL} />
      <LoadingState className={PANEL} />
      <ErrorState
        headingLevel={3}
        className={PANEL}
        referenceId={exampleValue('reference')}
        onRetry={() => undefined}
      />
      <PermissionDenied
        headingLevel={3}
        className={PANEL}
        resource={labels.resource}
        requestAccessHref="#request-access"
      />
    </div>
  );
}

export function Showcase(): JSX.Element {
  const { t } = useTranslation('lab');
  return (
    <div className="flex flex-col gap-10">
      <Heading level={1}>{t('showcase.heading')}</Heading>
      <Section title={t('showcase.form.heading')}>
        <RequestForm />
      </Section>
      <Section title={t('showcase.icons.heading')}>
        <IconStrips />
      </Section>
      <Section title={t('showcase.samples.heading')}>
        <SamplePanel />
      </Section>
      <Section title={t('showcase.code.heading')}>
        <CodePanel />
      </Section>
      <Section title={t('showcase.states.heading')}>
        <StatesPanel />
      </Section>
    </div>
  );
}
