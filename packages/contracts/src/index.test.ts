import { describe, it, expect } from 'vitest';
import { ok, fail, CONTRACTS_VERSION, canTransition, ErrorCodes } from './index.js';

describe('contracts envelope', () => {
  it('exposes a version', () => {
    expect(CONTRACTS_VERSION).toBe('0.1.0');
  });

  it('builds a success envelope', () => {
    const r = ok('req_1', { a: 1 });
    expect(r.success).toBe(true);
    expect(r.requestId).toBe('req_1');
    expect(r.data).toEqual({ a: 1 });
  });

  it('builds an error envelope without details', () => {
    const r = fail('req_2', 'BAD', 'boom');
    expect(r.success).toBe(false);
    expect(r.error.code).toBe('BAD');
    expect(r.error).not.toHaveProperty('details');
  });

  it('builds an error envelope with details', () => {
    const r = fail('req_3', 'BAD', 'boom', [{ field: 'x' }]);
    expect(r.error.details).toHaveLength(1);
  });

  it('exposes stable error codes', () => {
    expect(ErrorCodes.PATH_TRAVERSAL).toBe('PATH_TRAVERSAL');
  });
});

describe('job state machine', () => {
  it('allows QUEUED -> RUNNING', () => {
    expect(canTransition('QUEUED', 'RUNNING')).toBe(true);
  });

  it('allows SUCCEEDED -> RUNNING (conversation resume via follow-up reply)', () => {
    expect(canTransition('SUCCEEDED', 'RUNNING')).toBe(true);
  });

  it('keeps FAILED and CANCELED terminal', () => {
    expect(canTransition('FAILED', 'RUNNING')).toBe(false);
    expect(canTransition('CANCELED', 'RUNNING')).toBe(false);
  });

  it('allows RUNNING -> WAITING_FOR_USER and back', () => {
    expect(canTransition('RUNNING', 'WAITING_FOR_USER')).toBe(true);
    expect(canTransition('WAITING_FOR_USER', 'RUNNING')).toBe(true);
  });
});
