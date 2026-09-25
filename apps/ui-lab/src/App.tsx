// @ralysa/ui-lab: the internal demo app (F-001 design §7.6). Never shipped (`ralysa.shipped:
// false`, AC-13). The root carries the demo sentinel that check-no-demo looks for. The layout is
// the real AppShell: header with the locale and theme switchers, nav (inline-start), main, and
// on the showcase an aside (inline-end).
import {
  AppShell,
  Heading,
  Link,
  LocaleSwitcher,
  Text,
  ThemeSwitcher,
  useLocale,
  useTheme,
} from '@ralysa/ui';
import { type JSX, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { hrefFor, type Route, VIEWS } from './router.js';
import { DEMO_SENTINEL } from './samples/index.js';
import { Components } from './views/Components.js';
import { Showcase } from './views/Showcase.js';
import { Tokens } from './views/Tokens.js';

function Header(): JSX.Element {
  const { t } = useTranslation('lab');
  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        <Text as="span" weight="semibold" size="lg">
          {t('app.title')}
        </Text>
        <Text as="span" size="sm" tone="muted">
          {t('app.notice')}
        </Text>
      </div>
      <LocaleSwitcher />
      <ThemeSwitcher />
    </>
  );
}

function Nav({ route }: { route: Route }): JSX.Element {
  const { t } = useTranslation('lab');
  const { locale } = useLocale();
  const { preference } = useTheme();
  const names: Record<Route['view'], string> = {
    showcase: t('nav.showcase'),
    components: t('nav.components'),
    tokens: t('nav.tokens'),
  };
  return (
    <ul className="flex flex-col gap-2">
      {VIEWS.map((view) => (
        <li key={view}>
          <Link
            href={hrefFor({ view }, { locale, theme: preference })}
            aria-current={route.view === view ? 'page' : undefined}
          >
            {names[view]}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Aside(): JSX.Element {
  const { t } = useTranslation('lab');
  return (
    <div className="flex flex-col gap-2">
      <Heading level={2} size={5}>
        {t('showcase.aside.heading')}
      </Heading>
      <Text size="sm" tone="muted">
        {t('showcase.aside.body')}
      </Text>
    </div>
  );
}

export function App({ route }: { route: Route }): JSX.Element {
  const { t } = useTranslation('lab');
  const { locale } = useLocale();
  useEffect(() => {
    document.title = t('app.title');
  }, [t, locale]);
  return (
    <div data-demo-sentinel={DEMO_SENTINEL}>
      <AppShell
        header={<Header />}
        nav={<Nav route={route} />}
        aside={route.view === 'showcase' ? <Aside /> : undefined}
      >
        {route.view === 'showcase' && <Showcase />}
        {route.view === 'components' && <Components component={route.component} />}
        {route.view === 'tokens' && <Tokens />}
      </AppShell>
    </div>
  );
}
