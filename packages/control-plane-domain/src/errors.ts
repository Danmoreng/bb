export type Result<T, E = DomainError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface DomainError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends DomainError>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function domainError(
  code: string,
  message: string,
  retryable = false,
): DomainError {
  return { code, message, retryable };
}
