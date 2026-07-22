import { describe, it, expect } from 'vitest';
import type { AgentBridge } from '@easybi-studio/contracts';
import { InnosAgentBridge } from './innos-bridge.js';
import { FakeAgentBridge } from './fake-bridge.js';
import { ClaudeCodeBridge } from './claude-bridge.js';

/**
 * Stage 9: the AgentBridge contract is frozen. Every provider — Fake, Claude,
 * and the reserved Innos — satisfies the same interface, so swapping providers
 * never requires business-page changes.
 */
describe('AgentBridge contract is frozen across providers', () => {
  it('all providers implement the same surface', () => {
    const providers: AgentBridge[] = [
      new FakeAgentBridge(),
      new ClaudeCodeBridge({ claudePath: '/nonexistent' }),
      new InnosAgentBridge(),
    ];
    for (const p of providers) {
      expect(typeof p.healthCheck).toBe('function');
      expect(typeof p.start).toBe('function');
      expect(typeof p.continue).toBe('function');
      expect(typeof p.cancel).toBe('function');
      expect(typeof p.events).toBe('function');
    }
  });

  it('Innos provider reports unavailable and throws NotImplemented (not connected)', async () => {
    const innos = new InnosAgentBridge();
    const health = await innos.healthCheck();
    expect(health.available).toBe(false);
    expect(health.provider).toBe('innos');
    await expect(
      innos.start({ projectId: 'p', workspaceRoot: '/tmp', action: 'create-report', prompt: 'x' }),
    ).rejects.toThrow();
  });
});
