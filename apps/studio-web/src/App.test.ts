import { describe, it, expect } from 'vitest';
import { App } from './App.js';

// Stage 0 smoke test: the shell component module loads and exports a component.
// Full DOM rendering tests arrive with jsdom in later UI stages.
describe('studio-web shell', () => {
  it('exports an App component', () => {
    expect(typeof App).toBe('function');
  });
});
