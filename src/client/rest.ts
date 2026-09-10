/**
 * Minimal fetch wrapper for catapult-rest.
 *
 * Hygiene (DESIGN-BRIEF §6 "HTTP衛生"): per-request timeout via AbortSignal.timeout, a
 * User-Agent header, a response size cap, a concurrency cap, and schema validation of every
 * response body. The client only ever talks to the base URL it was constructed with.
 */
import type * as z from 'zod/v4';

export type RestErrorKind =
  | 'timeout'
  | 'unreachable'
  | 'not_found'
  | 'http'
  | 'invalid_response'
  | 'too_large';

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

  async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return this.request('GET', path, undefined, schema);
  }

  /** GET that maps a 404 to null instead of throwing (e.g. `/accounts/{id}/multisig`). */
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
  ): Promise<T> {
    if (!path.startsWith('/')) throw new Error('path must start with "/"');
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
        redirect: 'error',
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

      if (response.status === 404) {
        throw new RestError('not_found', `${path} was not found on ${this.host}`, path, 404);
      }
      if (!response.ok) {
        throw new RestError(
          'http',
          `${this.host} answered HTTP ${response.status} for ${path}`,
          path,
          response.status,
        );
      }

      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > this.maxBodyBytes) {
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
          await reader.cancel();
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
