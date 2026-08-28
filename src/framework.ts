import type { Params } from "./router.ts";

export type MaybePromise<T> = T | Promise<T>;

export interface CookieOptions {
  domain?: string;
  path?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface ResponseHelpers {
  readonly state: Record<string, unknown>;
  json<T>(data: T, init?: number | ResponseInit): Response;
  text(body: string, init?: number | ResponseInit): Response;
  html(body: string, init?: number | ResponseInit): Response;
  redirect(location: string, status?: 301 | 302 | 303 | 307 | 308): Response;
  header(name: string, value: string): void;
  cookie(name: string, value: string, options?: CookieOptions): void;
}

export interface MiddlewareContext extends ResponseHelpers {
  params: Params;
  body?: unknown;
  query?: unknown;
  headers?: unknown;
}

/**
 * An HTTP error a handler can `throw` or `return`. The dispatcher turns it into
 * a response with this status and body (JSON for objects, text for strings),
 * bypassing the error handler. Use `error(status, body?)` to build one.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body?: unknown,
    readonly headers?: HeadersInit,
  ) {
    super(typeof body === "string" ? body : `HTTP ${status}`);
    this.name = "HttpError";
  }
}

/** Build an HttpError: `throw error(404, "not found")` or `return error(400, { field: "bad" })`. */
export function error(status: number, body?: unknown, headers?: HeadersInit): HttpError {
  return new HttpError(status, body, headers);
}

export type Next = () => Promise<Response>;
export type Middleware = (
  request: Request,
  context: MiddlewareContext,
  next: Next,
) => MaybePromise<Response>;

export type ErrorHandler = (
  error: unknown,
  request: Request,
  context: MiddlewareContext,
) => MaybePromise<Response>;

export type NotFoundHandler = (
  request: Request,
  context: MiddlewareContext,
) => MaybePromise<Response>;

export type MethodNotAllowedHandler = (
  request: Request,
  allowed: readonly string[],
  context: MiddlewareContext,
) => MaybePromise<Response>;

export async function runMiddleware(
  middleware: readonly Middleware[],
  request: Request,
  context: MiddlewareContext,
  handler: () => MaybePromise<Response>,
): Promise<Response> {
  let previous = -1;
  const dispatch = async (index: number): Promise<Response> => {
    if (index <= previous) throw new Error("middleware next() called more than once");
    previous = index;
    const current = middleware[index];
    if (!current) return handler();
    return current(request, context, () => dispatch(index + 1));
  };
  return dispatch(0);
}

export function responseInit(init: number | ResponseInit | undefined): ResponseInit {
  return typeof init === "number" ? { status: init } : (init ?? {});
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!COOKIE_TOKEN.test(name)) throw new TypeError(`invalid cookie name '${name}'`);
  if (/[\u0000-\u001f\u007f;,\s]/.test(value)) {
    throw new TypeError(`invalid cookie value for '${name}'`);
  }
  if (options.domain && /[\u0000-\u0020\u007f;,]/.test(options.domain)) {
    throw new TypeError(`invalid cookie domain for '${name}'`);
  }
  if (options.path && /[\u0000-\u001f\u007f;]/.test(options.path)) {
    throw new TypeError(`invalid cookie path for '${name}'`);
  }
  if (options.expires && !Number.isFinite(options.expires.getTime())) {
    throw new TypeError(`invalid cookie expiry for '${name}'`);
  }
  if (options.maxAge !== undefined && !Number.isFinite(options.maxAge)) {
    throw new TypeError(`invalid cookie maxAge for '${name}'`);
  }

  const parts = [`${name}=${value}`];
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.trunc(options.maxAge)}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}

const COOKIE_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
