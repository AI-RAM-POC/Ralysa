import { describe, expect, it } from 'vitest';
import { jsdom, node } from '../index.js';

describe('vitest presets', () => {
  it('node runs in the node environment and fails when a package has no tests', () => {
    expect(node.test?.environment).toBe('node');
    expect(node.test?.passWithNoTests).toBe(false);
  });

  it('jsdom shares the node include pattern', () => {
    expect(jsdom.test?.environment).toBe('jsdom');
    expect(jsdom.test?.include).toEqual(node.test?.include);
  });
});
