import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.ts';

describe('@ralysa/dev-stack', () => {
  it('knows its name', () => {
    expect(PACKAGE_NAME).toBe('@ralysa/dev-stack');
  });
});
