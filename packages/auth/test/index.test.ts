import { describe, expect, it } from 'vitest';
import { packageName } from '../src/index.js';

describe('@ralysa/auth', () => {
  it('knows its name', () => {
    expect(packageName()).toBe('@ralysa/auth');
  });
});
