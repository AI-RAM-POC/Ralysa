// Form controls (F-001 design §7.5 "Forms", §7.7; AC-10, AC-12). Checkbox, RadioGroup, Select
// and Tabs are Radix primitives, so keyboard behaviour is Radix's: Space toggles a checkbox,
// arrow keys move within a radio group and a tab list, and Select opens with Enter, Space or the
// arrows and closes with Escape, returning focus to its trigger. Arrow keys follow the direction
// that LocaleProvider feeds to Radix's DirectionProvider, so in `ar` ArrowLeft moves forward.
// Every label, description and error is translated text passed in by the caller.
import {
  Checkbox as CheckboxPrimitive,
  RadioGroup as RadioPrimitive,
  Select as SelectPrimitive,
  Tabs as TabsPrimitive,
} from 'radix-ui';
import { type ComponentPropsWithRef, type JSX, type ReactNode, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../icons/Icon.js';
import { cn } from '../../lib/cn.js';
import { describedBy, FieldDescription, FieldError, FieldLabel } from './Field.js';

// No radius here: each control sets its own (a second `rounded-*` class would not override it,
// because Tailwind orders utilities by its own rules, not by class order).
const CONTROL =
  'border border-border-control bg-surface text-fg focus-visible:focus-ring disabled:cursor-not-allowed disabled:border-border-decor disabled:bg-subtle disabled:text-fg-disabled';

// --- TextField -------------------------------------------------------------------------------

export interface TextFieldProps extends Omit<
  ComponentPropsWithRef<'input'>,
  'className' | 'aria-describedby' | 'aria-invalid' | 'children'
> {
  /** Translated visible label. */
  label: string;
  /** Translated hint, announced with the field (aria-describedby). */
  description?: string;
  /** Translated error; sets aria-invalid and is announced with the field. */
  error?: string;
  className?: string;
}

export function TextField({
  label,
  description,
  error,
  id,
  required,
  className,
  type = 'text',
  ...rest
}: TextFieldProps): JSX.Element {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <FieldLabel htmlFor={inputId} required={required}>
        {label}
      </FieldLabel>
      {description !== undefined && (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      )}
      <input
        {...rest}
        id={inputId}
        type={type}
        required={required}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy([
          description !== undefined && descriptionId,
          error !== undefined && errorId,
        ])}
        className={cn(
          CONTROL,
          'min-h-control-md w-full rounded-md px-3 text-md placeholder:text-fg-muted aria-invalid:border-status-danger',
        )}
      />
      {error !== undefined && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}

// --- Checkbox --------------------------------------------------------------------------------

export interface CheckboxProps extends Omit<
  ComponentPropsWithRef<typeof CheckboxPrimitive.Root>,
  'className' | 'children'
> {
  label: string;
  description?: string;
  className?: string;
}

export function Checkbox({
  label,
  description,
  id,
  required,
  className,
  ...rest
}: CheckboxProps): JSX.Element {
  const autoId = useId();
  const boxId = id ?? autoId;
  const descriptionId = `${boxId}-description`;
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <CheckboxPrimitive.Root
        {...rest}
        id={boxId}
        required={required}
        aria-describedby={describedBy([description !== undefined && descriptionId])}
        className={cn(
          CONTROL,
          'group mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-on-accent data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
        )}
      >
        <CheckboxPrimitive.Indicator className="flex items-center justify-center">
          <Icon name="check" size="sm" className="group-data-[state=indeterminate]:hidden" />
          <Icon name="minus" size="sm" className="hidden group-data-[state=indeterminate]:block" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <div className="flex flex-col gap-1">
        <FieldLabel htmlFor={boxId} required={required} className="text-md font-regular">
          {label}
        </FieldLabel>
        {description !== undefined && (
          <FieldDescription id={descriptionId}>{description}</FieldDescription>
        )}
      </div>
    </div>
  );
}

// --- RadioGroup ------------------------------------------------------------------------------

export interface ChoiceOption {
  value: string;
  /** Translated option text. */
  label: string;
  /** When the option is in another language than the page (e.g. a language's own name). */
  lang?: string;
  disabled?: boolean;
}

export interface RadioGroupProps extends Omit<
  ComponentPropsWithRef<typeof RadioPrimitive.Root>,
  'className' | 'children' | 'aria-labelledby'
> {
  /** Translated group label. */
  label: string;
  options: readonly ChoiceOption[];
  className?: string;
}

export function RadioGroup({
  label,
  options,
  orientation = 'vertical',
  className,
  ...rest
}: RadioGroupProps): JSX.Element {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <span id={labelId} className="text-sm font-medium text-fg">
        {label}
      </span>
      <RadioPrimitive.Root
        {...rest}
        orientation={orientation}
        aria-labelledby={labelId}
        className={orientation === 'horizontal' ? 'flex flex-wrap gap-4' : 'flex flex-col gap-2'}
      >
        {options.map((option) => {
          const itemId = `${baseId}-${option.value}`;
          return (
            <div key={option.value} className="flex items-center gap-2">
              <RadioPrimitive.Item
                id={itemId}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  CONTROL,
                  'inline-flex size-5 shrink-0 items-center justify-center rounded-full data-[state=checked]:border-accent data-[state=checked]:bg-accent',
                )}
              >
                <RadioPrimitive.Indicator className="size-2 rounded-full bg-fg-on-accent" />
              </RadioPrimitive.Item>
              <FieldLabel htmlFor={itemId} lang={option.lang} className="text-md font-regular">
                {option.label}
              </FieldLabel>
            </div>
          );
        })}
      </RadioPrimitive.Root>
    </div>
  );
}

// --- Select ----------------------------------------------------------------------------------

export interface SelectProps extends Omit<
  ComponentPropsWithRef<typeof SelectPrimitive.Root>,
  'children' | 'dir'
> {
  /** Translated visible label. */
  label: string;
  options: readonly ChoiceOption[];
  /** Translated placeholder; defaults to the ui catalog's. */
  placeholder?: string;
  id?: string;
  className?: string;
}

/**
 * The first raised component: its popover uses color.bg.surfaceRaised with elevation.shadow.md,
 * a control border, and the dropdown layer. The highlighted option is accent on onAccent.
 */
export function Select({
  label,
  options,
  placeholder,
  id,
  className,
  ...rest
}: SelectProps): JSX.Element {
  const { t } = useTranslation('ui');
  const autoId = useId();
  const triggerId = id ?? autoId;
  const labelId = `${triggerId}-label`;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <FieldLabel htmlFor={triggerId} id={labelId} required={rest.required}>
        {label}
      </FieldLabel>
      <SelectPrimitive.Root {...rest}>
        <SelectPrimitive.Trigger
          id={triggerId}
          aria-labelledby={labelId}
          className={cn(
            CONTROL,
            'inline-flex min-h-control-md w-full items-center justify-between gap-2 rounded-md px-3 text-md data-[placeholder]:text-fg-muted',
          )}
        >
          <SelectPrimitive.Value placeholder={placeholder ?? t('select.placeholder')} />
          <SelectPrimitive.Icon className="text-fg-muted">
            <Icon name="chevronDown" size="sm" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={4}
            className="z-(--ralysa-elevation-layer-dropdown) max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden rounded-md border border-border-control bg-surface-raised text-fg shadow-md"
          >
            <SelectPrimitive.Viewport className="p-1">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="flex min-h-control-sm cursor-default items-center gap-2 rounded-sm px-2 text-md focus-visible:focus-ring data-[disabled]:text-fg-disabled data-[highlighted]:bg-accent data-[highlighted]:text-fg-on-accent"
                >
                  <SelectPrimitive.ItemText>
                    <span lang={option.lang}>{option.label}</span>
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="ms-auto">
                    <Icon name="check" size="sm" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  );
}

// --- Tabs ------------------------------------------------------------------------------------

export interface TabItem {
  value: string;
  /** Translated tab label. */
  label: string;
  content: ReactNode;
}

export interface TabsProps extends Omit<
  ComponentPropsWithRef<typeof TabsPrimitive.Root>,
  'children' | 'className' | 'dir'
> {
  /** Translated name of the tab list. */
  label: string;
  items: readonly TabItem[];
  className?: string;
}

export function Tabs({ label, items, defaultValue, className, ...rest }: TabsProps): JSX.Element {
  return (
    <TabsPrimitive.Root
      {...rest}
      defaultValue={defaultValue ?? items[0]?.value}
      className={cn('flex flex-col gap-3', className)}
    >
      <TabsPrimitive.List
        aria-label={label}
        className="flex flex-wrap gap-1 border-b border-border-decor"
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            className="-mb-px min-h-control-md rounded-t-sm border-b-2 border-transparent px-4 text-md text-fg-muted hover:text-fg focus-visible:focus-ring data-[state=active]:border-accent data-[state=active]:text-fg"
          >
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((item) => (
        <TabsPrimitive.Content
          key={item.value}
          value={item.value}
          className="rounded-sm focus-visible:focus-ring"
        >
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
