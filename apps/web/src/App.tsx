// @ralysa/web: application shell. Screens use @ralysa/ui components, i18n keys for every
// user-visible string, and logical CSS properties only (F-001 design §7).
import type { JSX } from 'react';

export function App(): JSX.Element {
  return <main id="main" data-app="web" />;
}
