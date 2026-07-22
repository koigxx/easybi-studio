/**
 * Secret redaction for anything derived from agent output before it is logged
 * or surfaced (plan §14.3, §17). Never let passwords / keys / tokens through.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/("?(?:password|passwd|pwd)"?\s*[:=]\s*")[^"]*(")/gi, '$1***$2'],
  [/("?(?:access[_-]?key(?:[_-]?id|[_-]?secret)?)"?\s*[:=]\s*")[^"]*(")/gi, '$1***$2'],
  [/("?(?:api[_-]?key|token|secret)"?\s*[:=]\s*")[^"]*(")/gi, '$1***$2'],
  [/(sk-[A-Za-z0-9]{6})[A-Za-z0-9-_]{8,}/g, '$1***'],
  [/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
