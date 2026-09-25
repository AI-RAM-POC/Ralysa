# @ralysa/vitest-config

Shared Vitest 4.1 presets.

```ts
// vitest.config.ts in a workspace
import { node } from '@ralysa/vitest-config';
export default node;
```

- `node`: node environment. For services, CLIs, tooling and isomorphic libraries.
- `jsdom`: jsdom environment. For React components; the workspace adds `jsdom` as a devDependency.

Both presets collect `src/**/*.test.{ts,tsx}` and `test/**/*.test.{ts,tsx}`, restore mocks, env and globals between tests, and fail when a workspace has no tests.

**`test` is hermetic:** no network, database or containers. Tests that need Postgres, Redis or another service go in a separate `test:integration` script (see `docs/engineering/repo-conventions.md`). There are no environment variables.
