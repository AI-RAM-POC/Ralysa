// @vitest-environment jsdom
// Components I (F-001-T10; §7.5, §7.7): landmarks and their names, skip link, native buttons with
// a safe default type, icon-only buttons named from a typed key, links, and the four state
// patterns, in en and ar. Test mode: any missing key throws.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppShell,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Link,
  LoadingState,
  PermissionDenied,
  SkipLink,
  VisuallyHidden,
} from '../src/index.js';
import { click, render, type Rendered } from './render.js';

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

describe('AppShell (landmarks, §7.5)', () => {
  const shell = (
    <AppShell header={<span>h</span>} nav={<span>n</span>} aside={<span>a</span>}>
      <p>m</p>
    </AppShell>
  );

  it('renders banner, named nav, main and named aside in reading order', async () => {
    view = await render(shell);
    const regions = [...view.container.querySelectorAll('[data-region]')].map((element) => [
      element.tagName.toLowerCase(),
      element.getAttribute('aria-label'),
    ]);
    expect(regions).toEqual([
      ['header', null],
      ['nav', 'Main navigation'],
      ['main', null],
      ['aside', 'Details'],
    ]);
    const main = view.container.querySelector('main');
    expect(main?.id).toBe('main');
    expect(main?.tabIndex).toBe(-1);
  });

  it('names the landmarks in Arabic, and the page is RTL', async () => {
    view = await render(shell, { locale: 'ar' });
    expect(document.documentElement.dir).toBe('rtl');
    expect(view.container.querySelector('nav')?.getAttribute('aria-label')).toBe('التنقل الرئيسي');
    expect(view.container.querySelector('aside')?.getAttribute('aria-label')).toBe('التفاصيل');
  });

  it('uses logical classes only: the aside border is border-s, never border-l', async () => {
    view = await render(shell);
    const aside = view.container.querySelector('aside');
    expect(aside?.className).toContain('md:border-s');
    expect(view.container.innerHTML).not.toMatch(/\b(?:border-l|border-r|ml-|mr-|pl-|pr-)/);
  });

  it('the skip link is the first focusable element and targets main', async () => {
    view = await render(shell);
    const first = view.container.querySelector('a, button, [tabindex]:not([tabindex="-1"])');
    expect(first?.getAttribute('href')).toBe('#main');
    expect(first?.textContent).toBe('Skip to main content');
  });
});

describe('SkipLink and VisuallyHidden', () => {
  it('SkipLink is visually hidden until focused', async () => {
    view = await render(<SkipLink target="content" />, { locale: 'ar' });
    const link = view.container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('#content');
    expect(link?.textContent).toBe('انتقل إلى المحتوى الرئيسي');
    expect(link?.className).toContain('sr-only');
    expect(link?.className).toContain('focus:not-sr-only');
  });

  it('VisuallyHidden keeps text in the accessibility tree', async () => {
    view = await render(<VisuallyHidden>x</VisuallyHidden>);
    expect(view.container.querySelector('.sr-only')?.textContent).toBe('x');
  });
});

describe('Button, IconButton, Link (§7.5 Actions)', () => {
  it('Button is a native button of type "button" unless told otherwise', async () => {
    const onClick = vi.fn();
    view = await render(
      <form>
        <Button onClick={onClick}>a</Button>
        <Button type="submit" variant="primary">
          b
        </Button>
      </form>,
    );
    const [plain, submit] = view.container.querySelectorAll('button');
    expect(plain?.type).toBe('button');
    expect(submit?.type).toBe('submit');
    if (plain !== undefined) await click(plain);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['primary', 'bg-accent'],
    ['secondary', 'border-border-control'],
    ['ghost', 'bg-transparent'],
    ['danger', 'bg-status-danger'],
  ] as const)('the %s variant uses token classes and the focus ring', async (variant, token) => {
    view = await render(<Button variant={variant}>x</Button>);
    const button = view.container.querySelector('button');
    expect(button?.className).toContain(token);
    expect(button?.className).toContain('focus-visible:focus-ring');
  });

  it('a disabled Button is not operable', async () => {
    const onClick = vi.fn();
    view = await render(
      <Button disabled onClick={onClick}>
        x
      </Button>,
    );
    const button = view.container.querySelector('button');
    expect(button?.disabled).toBe(true);
    if (button !== null) await click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('an icon inside a Button is decorative', async () => {
    view = await render(<Button icon="send">x</Button>, { locale: 'ar' });
    const svg = view.container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('data-icon-directional')).toBe('true');
  });

  it('IconButton takes its accessible name from labelKey, in each locale', async () => {
    view = await render(<IconButton icon="close" labelKey="ui:action.close" />);
    expect(view.container.querySelector('button')?.getAttribute('aria-label')).toBe('Close');
    view.unmount();
    view = await render(<IconButton icon="close" labelKey="ui:action.close" />, { locale: 'ar' });
    expect(view.container.querySelector('button')?.getAttribute('aria-label')).toBe('إغلاق');
    expect(view.container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('IconButton requires a typed key (a type error otherwise)', () => {
    // @ts-expect-error labelKey is required
    const missing = <IconButton icon="close" />;
    // @ts-expect-error not a key in any catalog
    const unknown = <IconButton icon="close" labelKey="ui:action.nope" />;
    expect([missing, unknown]).toHaveLength(2);
  });

  it('Link is an underlined anchor with the focus ring', async () => {
    view = await render(<Link href="/docs">x</Link>);
    const link = view.container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/docs');
    expect(link?.className).toContain('text-link');
    expect(link?.className).toContain('underline');
    expect(link?.className).toContain('focus-visible:focus-ring');
  });
});

describe('state patterns (§7.5 States)', () => {
  it('EmptyState shows the catalog defaults and an optional action', async () => {
    view = await render(<EmptyState action={<Button>go</Button>} />);
    expect(view.container.querySelector('h2')?.textContent).toBe('Nothing here yet');
    expect(view.container.textContent).toContain('Items you add will appear here.');
    expect(view.container.querySelector('button')?.textContent).toBe('go');
  });

  it('LoadingState: a busy placeholder region holding a separate polite status message', async () => {
    view = await render(<LoadingState />, { locale: 'ar' });
    const region = view.container.querySelector('[data-state-pattern="loading"]');
    const status = region?.querySelector('[role="status"]');
    // aria-busy sits on the region being loaded, never on the live region itself (review 2).
    expect(region?.getAttribute('aria-busy')).toBe('true');
    expect(region?.getAttribute('role')).toBeNull();
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.hasAttribute('aria-busy')).toBe(false);
    expect(status?.closest('[aria-busy]')).toBe(region);
    expect(status?.textContent).toBe('جارٍ التحميل…');
    expect(region?.querySelector('svg')?.getAttribute('class')).toContain(
      'motion-safe:animate-spin',
    );
  });

  it('ErrorState is an alert with catalog text, a retry and an isolated reference', async () => {
    const onRetry = vi.fn();
    view = await render(<ErrorState onRetry={onRetry} referenceId="REF-42" headingLevel={3} />);
    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.querySelector('h3')?.textContent).toBe('Something went wrong');
    expect(alert?.innerHTML).toContain('Reference: <bdi>REF-42</bdi>');
    const retry = alert?.querySelector('button');
    expect(retry?.textContent).toBe('Try again');
    if (retry !== undefined && retry !== null) await click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('ErrorState accepts no error object (raw error text never renders)', () => {
    // @ts-expect-error there is no `error` prop
    const withError = <ErrorState error={new Error('stack trace')} />;
    expect(withError).toBeDefined();
  });

  it('PermissionDenied isolates the resource name and links to the access request', async () => {
    view = await render(
      <PermissionDenied resource="Finance reports" requestAccessHref="/console/access" />,
      { locale: 'ar' },
    );
    expect(view.container.innerHTML).toContain(
      'اطلب من المسؤول صلاحية الوصول إلى <bdi>Finance reports</bdi>.',
    );
    const link = view.container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/console/access');
    expect(link?.textContent).toBe('طلب صلاحية الوصول');
  });

  it('PermissionDenied without a link target shows no link', async () => {
    view = await render(<PermissionDenied resource="x" />);
    expect(view.container.querySelector('a')).toBeNull();
  });
});
