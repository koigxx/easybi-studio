import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('redacts password/token/api key values', () => {
    expect(redactSecrets('password="hunter2"')).toBe('password="***"');
    expect(redactSecrets('"api_key":"abc123def"')).toContain('***');
    expect(redactSecrets('Bearer abcdef1234567890')).toBe('Bearer ***');
  });

  it('redacts sk- style keys', () => {
    expect(redactSecrets('sk-ABCDEF1234567890')).toContain('sk-ABCDEF***');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('创建 hello.txt，内容 hi')).toBe('创建 hello.txt，内容 hi');
  });
});
