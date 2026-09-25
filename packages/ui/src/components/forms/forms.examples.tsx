import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { ComponentExamples, ExampleLabels } from '../../examples/types.js';
import { Text } from '../text/Text.js';
import { Checkbox, RadioGroup, Select, Tabs, TextField } from './Forms.js';

function TextFieldWithError({ labels }: { labels: ExampleLabels }): JSX.Element {
  const { t } = useTranslation('ui');
  return (
    <TextField
      label={labels.emailLabel}
      type="email"
      required
      error={t('textField.error.required')}
    />
  );
}

export const textFieldExamples: ComponentExamples = {
  component: 'TextField',
  examples: [
    {
      id: 'withDescription',
      render: (labels) => (
        <TextField
          label={labels.emailLabel}
          description={labels.emailHint}
          placeholder={labels.emailPlaceholder}
          type="email"
          autoComplete="email"
        />
      ),
    },
    { id: 'invalid', render: (labels) => <TextFieldWithError labels={labels} /> },
    {
      id: 'disabled',
      render: (labels) => <TextField label={labels.emailLabel} disabled />,
    },
  ],
};

export const checkboxExamples: ComponentExamples = {
  component: 'Checkbox',
  examples: [
    {
      id: 'states',
      render: (labels) => (
        <div className="flex flex-col gap-3">
          <Checkbox label={labels.termsLabel} description={labels.termsHint} />
          <Checkbox label={labels.termsLabel} defaultChecked />
          <Checkbox label={labels.termsLabel} checked="indeterminate" />
          <Checkbox label={labels.termsLabel} disabled />
        </div>
      ),
    },
  ],
};

const plans = (labels: ExampleLabels) => [
  { value: 'basic', label: labels.planBasic },
  { value: 'pro', label: labels.planPro },
  { value: 'team', label: labels.planTeam },
];

export const radioGroupExamples: ComponentExamples = {
  component: 'RadioGroup',
  examples: [
    {
      id: 'vertical',
      render: (labels) => (
        <RadioGroup label={labels.planLabel} defaultValue="pro" options={plans(labels)} />
      ),
    },
    {
      id: 'horizontal',
      render: (labels) => (
        <RadioGroup
          label={labels.planLabel}
          orientation="horizontal"
          defaultValue="basic"
          options={plans(labels)}
        />
      ),
    },
  ],
};

export const selectExamples: ComponentExamples = {
  component: 'Select',
  examples: [
    {
      id: 'default',
      render: (labels) => (
        <Select
          className="max-w-sm"
          label={labels.regionLabel}
          options={[
            { value: 'gulf', label: labels.regionGulf },
            { value: 'europe', label: labels.regionEurope },
            { value: 'americas', label: labels.regionAmericas },
          ]}
        />
      ),
    },
  ],
};

export const tabsExamples: ComponentExamples = {
  component: 'Tabs',
  examples: [
    {
      id: 'default',
      render: (labels) => (
        <Tabs
          label={labels.tabsLabel}
          items={[
            {
              value: 'overview',
              label: labels.tabOverview,
              content: <Text>{labels.paragraph}</Text>,
            },
            {
              value: 'activity',
              label: labels.tabActivity,
              content: <Text>{labels.mutedText}</Text>,
            },
            {
              value: 'settings',
              label: labels.tabSettings,
              content: <Text>{labels.mainText}</Text>,
            },
          ]}
        />
      ),
    },
  ],
};
