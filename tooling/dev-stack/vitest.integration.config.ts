import { integration } from '@ralysa/vitest-config';

// test:integration (F-002 design §8.1): test/integration/**/*.int.ts against the dev stack in
// deploy/docker/dev. Never part of the hermetic `test` task.
export default integration;
