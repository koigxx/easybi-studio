/**
 * @easybi-studio/skill-bundle-source
 *
 * SkillBundleSource contract implementations. LocalDirectorySource (directory),
 * LocalArchiveSource (.tar.gz) and HttpRegistrySource (cloud download → archive)
 * are real; BuiltIn is reserved behind the same interface. The registry source
 * downloads an archive then reuses LocalArchiveSource's extract-and-install path.
 */
export * from './whitelist.js';
export * from './hash.js';
export * from './snapshot.js';
export * from './validate.js';
export { LocalDirectorySource } from './sources/local-directory.js';
export { LocalArchiveSource } from './sources/local-archive.js';
export { HttpRegistrySource, type HttpRegistryOptions } from './sources/http-registry.js';
export { BuiltInSource } from './sources/reserved.js';
