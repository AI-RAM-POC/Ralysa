// Preferences (F-001 design §7.5, §5.3, §7.4.2; AC-6). LocaleSwitcher changes the i18next
// language through useLocale(): LocaleProvider then sets <html lang dir> and the Radix
// direction, with no reload. Each language is named in its own language and marked with `lang`
// (WCAG 3.1.2). ThemeSwitcher sets the ThemeProvider preference (data-theme on <html>).
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { isLocale } from '../../contracts/i18n.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { isThemePreference, type ThemePreference, useTheme } from '../../theme/ThemeProvider.js';
import { RadioGroup, Select } from '../forms/Forms.js';

export interface SwitcherProps {
  className?: string;
}

export function LocaleSwitcher({ className }: SwitcherProps): JSX.Element {
  const { t } = useTranslation('ui');
  const { locale, options, setLocale } = useLocale();
  return (
    <Select
      className={className}
      label={t('localeSwitcher.label')}
      value={locale}
      onValueChange={(next) => {
        if (isLocale(next)) void setLocale(next);
      }}
      options={options.map((option) => ({
        value: option.locale,
        label: option.label,
        lang: option.locale,
      }))}
    />
  );
}

export function ThemeSwitcher({ className }: SwitcherProps): JSX.Element {
  const { t } = useTranslation('ui');
  const { preference, setPreference } = useTheme();
  const labels: Record<ThemePreference, string> = {
    light: t('themeSwitcher.option.light'),
    dark: t('themeSwitcher.option.dark'),
    system: t('themeSwitcher.option.system'),
  };
  return (
    <RadioGroup
      className={className}
      label={t('themeSwitcher.label')}
      orientation="horizontal"
      value={preference}
      onValueChange={(next) => {
        if (isThemePreference(next)) setPreference(next);
      }}
      options={(['light', 'dark', 'system'] as const).map((value) => ({
        value,
        label: labels[value],
      }))}
    />
  );
}
