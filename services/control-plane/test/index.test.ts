import { describe, expect, it } from 'vitest';
import { serviceInfo } from '../src/index.js';

describe('@ralysa/control-plane', () => {
  it('reports its name', () => {
    expect(serviceInfo()).toEqual({ name: '@ralysa/control-plane' });
  });
});
