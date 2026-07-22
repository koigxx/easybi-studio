/** Unified API envelope for Studio management APIs (plan §12). */

export interface ApiSuccess<T> {
  success: true;
  requestId: string;
  data: T;
}

export interface ApiError {
  success: false;
  requestId: string;
  error: {
    code: string;
    message: string;
    details?: unknown[];
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export function ok<T>(requestId: string, data: T): ApiSuccess<T> {
  return { success: true, requestId, data };
}

export function fail(
  requestId: string,
  code: string,
  message: string,
  details?: unknown[],
): ApiError {
  return {
    success: false,
    requestId,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

/** Stable error codes surfaced by the Studio service. Extended per stage. */
export const ErrorCodes = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  WORKSPACE_INVALID: 'WORKSPACE_INVALID',
  ALREADY_REGISTERED: 'ALREADY_REGISTERED',
  CONFIG_CONFLICT: 'CONFIG_CONFLICT',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
