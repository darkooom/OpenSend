/** Same-origin client for the management API (session cookie, proxied by Next.js). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(
      0,
      'network_error',
      'The OpenSend API is not reachable. Check your connection and that the API is running.',
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const e =
      (body as
        | {
            error?: { code?: string; message?: string; details?: unknown };
            message?: string;
            code?: string;
          }
        | undefined) ?? {};
    throw new ApiError(
      res.status,
      e.error?.code ?? e.code ?? 'http_error',
      e.error?.message ?? e.message ?? `Request failed (HTTP ${res.status})`,
      e.error?.details,
    );
  }
  return body as T;
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'validation_error' && Array.isArray(err.details)) {
      const first = (err.details as Array<{ path?: string; message?: string }>)[0];
      if (first?.message)
        return `${err.message}: ${first.path ? `${first.path} ` : ''}${first.message}`;
    }
    return err.message;
  }
  return fallback;
}
