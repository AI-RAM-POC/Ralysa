import { afterAll } from 'vitest';
import { removeTempDirs } from './temp.ts';

afterAll(() => {
  removeTempDirs();
});
