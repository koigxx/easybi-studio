import { describe, it, expect } from 'vitest';
import { App } from './App.js';
import { SSE_EVENT_NAMES } from './AgentDrawer.js';

// Stage 0 smoke test: the shell component module loads and exports a component.
// Full DOM rendering tests arrive with jsdom in later UI stages.
describe('studio-web shell', () => {
  it('exports an App component', () => {
    expect(typeof App).toBe('function');
  });

  it('subscribes to every persisted staged-run event so the SSE cursor stays exact', () => {
    expect(SSE_EVENT_NAMES).toEqual(expect.arrayContaining([
      'run_started',
      'run_completed',
      'user_message',
    ]));
  });
});
