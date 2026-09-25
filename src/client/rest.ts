/**
 * Minimal fetch wrapper for catapult-rest.
 *
 * Hygiene (DESIGN-BRIEF §6 "HTTP衛生"): per-request timeout via AbortSignal.timeout, a
 * User-Agent header, a response size cap (a declared Content-Length over it is refused unread, and
 * the body is counted while it streams in), a concurrency cap, and schema validation of every
 * response body. The client only ever talks to the base URL it was constructed with: redirects are
 * never followed (a 3xx answer is an error), request paths are plain characters only, and a body
 * that is not read is discarded rather than left open.
 */
import type * as z from 'zod/v4';

export type RestErrorKind =
  | 'timeout'
  | 'unreachable'
  | 'not_found'
  | 'http'
  | 'redirect'
  | 'invalid_response'
  | 'too_large';

/**
 * Paths this client sends: segments of letters, digits and "_", then an optional query whose
 * names are the same and whose values may also hold "-". Every tool validates its arguments before
 * it builds a path; this is the net under that, so no argument can reach the node as "..", "?",
 * "#", "%", "\" or a space.
 */
export const SAFE_REQUEST_PATH =
  /^(?:\/[A-Za-z0-9_]+)+(?:\?[A-Za-z0-9_]+=[A-Za-z0-9_-]*(?:&[A-Za-z0-9_]+=[A-Za-z0-9_-]*)*)?$/;

/**
 * The redirect statuses of the Fetch Standard. Another 3xx (300, 304, …) is not a redirect and
 * stays an HTTP error with its body discarded.
 */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * A redirect answer. With `redirect: 'manual'` Node's fetch returns the 3xx response itself; a
 * spec-conforming fetch returns an opaque-redirect response (status 0) instead.
 */
function isRedirect(response: Response): boolean {
  return REDIRECT_STATUSES.has(response.status) || response.type === 'opaqueredirect';
}

/** Releases a body that will not be read, so the connection is not held until garbage collection. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed or errored: nothing is left to release.
  }
}

export class RestError extends Error {
  readonly kind: RestErrorKind;
  readonly status: number | undefined;
  readonly path: string;

  constructor(kind: RestErrorKind, message: string, path: string, status?: number) {
    super(message);
    this.name = 'RestError';
    this.kind = kind;
    this.path = path;
    this.status = status;
  }
}

export interface RestClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly userAgent: string;
  readonly maxBodyBytes?: number;
  readonly maxConcurrency?: number;
  /** Test seam; defaults to globalThis.fetch looked up at call time. */
  readonly fetchImpl?: typeof fetch;
}

export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_CONCURRENCY = 4;

export interface GetOptions {
  /**
   * Non-2xx statuses whose JSON body is still parsed against the schema instead of becoming a
   * RestError. catapult-rest answers `/node/health` with 503 and the same NodeHealthInfoDTO when
   * a service is down (symbol-openapi spec/core/node/routes/nodeHealth.yml), so the body is the
   * answer. 404 is only accepted when listed explicitly.
   */
  readonly acceptStatuses?: readonly number[];
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export class RestClient {
  readonly baseUrl: string;
  readonly host: string;
  readonly timeoutMs: number;
  readonly userAgent: string;
  private readonly maxBodyBytes: number;
  private readonly semaphore: Semaphore;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: RestClientOptions) {
    const url = new URL(options.baseUrl);
    this.baseUrl = url.toString().replace(/\/+$/, '');
    this.host = url.host;
    this.timeoutMs = options.timeoutMs;
    this.userAgent = options.userAgent;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.semaphore = new Semaphore(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.fetchImpl = options.fetchImpl;
  }

  async get<T>(path: string, schema: z.ZodType<T>, options?: GetOptions): Promise<T> {
    return this.request('GET', path, undefined, schema, options);
  }

  /** GET that maps a 404 to null instead of throwing (e.g. `/account/{address}/multisig`). */
  async getOrNull<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      return await this.request('GET', path, undefined, schema);
    } catch (err) {
      if (err instanceof RestError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.request('POST', path, body, schema);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    options?: GetOptions,
  ): Promise<T> {
    if (!SAFE_REQUEST_PATH.test(path)) {
      // A programming error, not a node problem: describeError reports it as an internal error.
      throw new Error(
        `refusing to request ${JSON.stringify(path.slice(0, 80))}: only plain path segments and query values are sent`,
      );
    }
    const url = `${this.baseUrl}${path}`;
    const release = await this.semaphore.acquire();
    try {
      const doFetch = this.fetchImpl ?? globalThis.fetch;
      const headers: Record<string, string> = {
        accept: 'application/json',
        'user-agent': this.userAgent,
      };
      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        // Never follow: a redirect could lead anywhere. The 3xx answer is reported below.
        redirect: 'manual',
      };
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      let response: Response;
      try {
        response = await doFetch(url, init);
      } catch (err) {
        throw this.mapFetchError(err, path);
      }

      if (isRedirect(response)) {
        await discardBody(response);
        // The Location header is text the node chose: it is neither followed nor quoted.
        throw new RestError(
          'redirect',
          `${this.host} answered ${path} with a redirect (HTTP ${response.status || '3xx'}), which is not followed`,
          path,
          response.status || undefined,
        );
      }
      const accepted = options?.acceptStatuses?.includes(response.status) === true;
      if (response.status === 404 && !accepted) {
        await discardBody(response);
        throw new RestError('not_found', `${path} was not found on ${this.host}`, path, 404);
      }
      if (!response.ok && !accepted) {
        await discardBody(response);
        throw new RestError(
          'http',
          `${this.host} answered HTTP ${response.status} for ${path}`,
          path,
          response.status,
        );
      }

      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > this.maxBodyBytes) {
        await discardBody(response);
        throw new RestError('too_large', `response for ${path} exceeds the size limit`, path);
      }
      const text = await this.readBodyLimited(response, path);

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new RestError('invalid_response', `${this.host} returned non-JSON for ${path}`, path);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new RestError(
          'invalid_response',
          `${this.host} returned an unexpected shape for ${path}`,
          path,
        );
      }
      return parsed.data;
    } finally {
      release();
    }
  }

  private async readBodyLimited(response: Response, path: string): Promise<string> {
    if (!response.body) return await response.text();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxBodyBytes) {
          // A failing cancel (an already errored stream) must not turn this into another error.
          await reader.cancel().catch(() => undefined);
          throw new RestError('too_large', `response for ${path} exceeds the size limit`, path);
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof RestError) throw err;
      throw this.mapFetchError(err, path);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder().decode(merged);
  }

  private mapFetchError(err: unknown, path: string): RestError {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new RestError(
        'timeout',
        `${this.host} did not answer ${path} within ${this.timeoutMs} ms`,
        path,
      );
    }
    return new RestError('unreachable', `could not reach ${this.host} for ${path}`, path);
  }
}
