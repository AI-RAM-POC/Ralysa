import { describe, expect, it } from 'vitest';
import { integration, jsdom, node } from '../index.js';

describe('vitest presets', () => {
  it('node runs in the node environment and fails when a package has no tests', () => {
    expect(node.test?.environment).toBe('node');
    expect(node.test?.passWithNoTests).toBe(false);
  });

  it('jsdom shares the node include pattern', () => {
    expect(jsdom.test?.environment).toBe('jsdom');
    expect(jsdom.test?.include).toEqual(node.test?.include);
  });

  it('integration collects only *.int.ts under test/integration, disjoint from the unit include', () => {
    expect(integration.test?.include).toEqual(['test/integration/**/*.int.ts']);
    expect(node.test?.include?.some((glob) => glob.includes('.int.'))).toBe(false);
    expect(integration.test?.passWithNoTests).toBe(false);
  });
});
