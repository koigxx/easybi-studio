import type { SkillBundleSource, SkillSourceType } from '@easybi-studio/contracts';
import {
  LocalDirectorySource,
  LocalArchiveSource,
  HttpRegistrySource,
} from '@easybi-studio/skill-bundle-source';
import type { StudioConfig } from '../config.js';

/**
 * Single seam for constructing the configured Skill bundle source.
 *
 * Switching between a local directory, a local .tar.gz archive, or a cloud HTTP
 * registry is a CONFIG-ONLY change (EASYBI_SKILL_SOURCE_TYPE + _DIR). Business
 * code never depends on a concrete source type.
 *
 *   local-directory : EASYBI_SKILL_SOURCE_DIR = 目录路径
 *   local-archive   : EASYBI_SKILL_SOURCE_DIR = .tar.gz 路径
 *   http-registry   : EASYBI_SKILL_SOURCE_DIR = registry base URL
 *                     EASYBI_SKILL_SOURCE_AUTH_TOKEN_ENV = 持有 token 的环境变量名（可选）
 *
 * All three real sources funnel into the same pipeline: registry downloads an
 * archive → LocalArchiveSource extracts → shared whitelist/hash/snapshot install.
 */
export function resolveSkillSource(
  config: StudioConfig,
  override?: { type?: SkillSourceType; location?: string },
): SkillBundleSource {
  const type = override?.type ?? config.skillSourceType ?? 'local-directory';
  const location = override?.location ?? config.skillSourceDir;

  switch (type) {
    case 'local-directory':
      return new LocalDirectorySource(location);
    case 'local-archive':
      return new LocalArchiveSource(location);
    case 'http-registry':
      return new HttpRegistrySource({
        baseUrl: location,
        ...(config.skillSourceAuthTokenEnv
          ? { authTokenEnv: config.skillSourceAuthTokenEnv }
          : {}),
      });
    default:
      // built-in is reserved and not connected in this release.
      throw new Error(
        `Skill 来源类型 ${type} 尚未启用，请使用 local-directory / local-archive / http-registry`,
      );
  }
}
