import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';

describe('@ralysa/web App', () => {
  it('renders the main landmark', () => {
    expect(renderToString(<App />)).toBe('<main id="main" data-app="web"></main>');
  });
});
