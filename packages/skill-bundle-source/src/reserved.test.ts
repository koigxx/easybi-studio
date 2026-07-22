import { describe, it, expect } from 'vitest';
import type { SkillBundleSource } from '@easybi-studio/contracts';
import { BuiltInSource } from './sources/reserved.js';

/**
 * BuiltInSource is reserved and conforms to the frozen SkillBundleSource
 * interface but is not connected in this release. (LocalArchiveSource and
 * HttpRegistrySource are real implementations, covered by their own tests.)
 */
describe('reserved SkillBundleSource implementations', () => {
  const sources: Array<[string, SkillBundleSource]> = [['built-in', new BuiltInSource()]];

  for (const [name, src] of sources) {
    it(`${name} conforms and reports unavailable`, async () => {
      expect(typeof src.listVersions).toBe('function');
      expect(typeof src.getManifest).toBe('function');
      expect(typeof src.fetch).toBe('function');
      const health = await src.healthCheck();
      expect(health.available).toBe(false);
      expect(await src.listVersions('easybi')).toEqual([]);
      await expect(src.getManifest('easybi', 'current')).rejects.toThrow();
    });
  }
});
