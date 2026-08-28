// swerverts: run the swerver gateway with TypeScript route handlers.
//
// swerver (TLS, HTTP/1.1/2/3, static, reverse proxy, rate limiting, auth,
// x402, WASM filters, nether microVM upstreams) runs as the front process.
// Dynamic routes you declare here are served by a Bun HTTP server on a unix
// socket, which swerver proxies to as an ordinary upstream. Only routes you
// claim pay the crossing; everything else stays on swerver's zero-copy paths.
//
//   import { Swerver } from "swerverts";
//
//   const app = new Swerver({ port: 8080, staticRoot: "./public" });
//   app.route("/hello/:name", (req, { params }) =>
//     Response.json({ hi: params.name }));
//   await app.start();

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { brandValue, unbrand } from "./brand.ts";
import { resolveBinary } from "./binary.ts";
import {
  generateConfig,
  validateConfig,
  type Route,
  type ProxyOptions,
  type AdminConfig,
  type Http2Config,
  type OtelConfig,
  type QuicConfig,
  type SwerverConfig,
  type TenantConfig,
  type TlsConfig,
  type Upstream,
  type UpstreamRef,
  type ValidatedConfig,
} from "./config.ts";
import { createClient, type Client } from "./client.ts";
import { buildOpenApi, type OpenApiDocument, type OpenApiOptions } from "./openapi.ts";
import { loadLib, resolveLib, ptr, toArrayBuffer, type Lib } from "./ffi.ts";
import {
  responseInit,
  runMiddleware,
  serializeCookie,
  type CookieOptions,
  type ErrorHandler,
  type MethodNotAllowedHandler,
  type Middleware,
  type MiddlewareContext,
  type NotFoundHandler,
  type ResponseHelpers,
} from "./framework.ts";
import {
  compile,
  match,
  sortBySpecificity,
  type CompiledRoute,
  type ParamsOf,
  type RouteSchemas,
} from "./router.ts";
import {
  formatIssues,
  runValidation,
  type InferInput,
  type InferOutput,
  type Schema,
} from "./schema.ts";

// ── Typed responses ─────────────────────────────────────────────────────────
// A Response that carries, in the type system only, the shape of its JSON body.
// `ctx.json(data)` returns one; a typed client reads the phantom type back.
declare const responseType: unique symbol;
export type TypedResponse<T> = Response & { readonly [responseType]?: T };

// ── Per-route schema config ─────────────────────────────────────────────────
/** Validators for a route. Each is any Standard Schema (Zod, Valibot, ...). */
export interface RouteConfig {
  body?: Schema;
  query?: Schema;
  headers?: Schema;
  response?: Schema;
  responses?: Readonly<Record<number, Schema>>;
  middleware?: readonly Middleware[];
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: readonly string[];
  deprecated?: boolean;
}

type OutputAt<O, K extends keyof RouteConfig> =
  O extends Record<K, infer S extends Schema> ? InferOutput<S> : never;
type InputAt<O, K extends keyof RouteConfig> =
  O extends Record<K, infer S extends Schema> ? InferInput<S> : never;

type ResponseSchemas<O extends RouteConfig> = O extends {
  responses: infer Responses extends Readonly<Record<number, Schema>>;
}
  ? Responses[keyof Responses]
  : O extends { response: infer ResponseSchema extends Schema }
    ? ResponseSchema
    : never;

type ResponseInput<O extends RouteConfig> = ResponseSchemas<O> extends infer ResponseSchema extends Schema
  ? InferInput<ResponseSchema>
  : never;

type ResponseOutput<O extends RouteConfig> = ResponseSchemas<O> extends infer ResponseSchema extends Schema
  ? InferOutput<ResponseSchema>
  : unknown;

/** JSON responder: typed to the response schema's input when one is declared. */
type JsonFn<O extends RouteConfig> = O extends {
  responses: infer Responses extends Readonly<Record<number, Schema>>;
}
  ? <Status extends keyof Responses & number>(
      data: InferInput<Responses[Status]>,
      init: Status | (ResponseInit & { status: Status }),
    ) => TypedResponse<InferOutput<Responses[Status]>>
  : O extends { response: Schema }
    ? (data: ResponseInput<O>, init?: number | ResponseInit) => TypedResponse<ResponseOutput<O>>
    : <T>(data: T, init?: number | ResponseInit) => TypedResponse<T>;

/** Handler context assembled from the route pattern and its declared schemas. */
export type CtxFor<P extends string, O extends RouteConfig> = Omit<ResponseHelpers, "json"> &
  { params: ParamsOf<P>; json: JsonFn<O> } & (O extends {
  body: Schema;
}
  ? { body: OutputAt<O, "body"> }
  : {}) &
  (O extends { query: Schema } ? { query: OutputAt<O, "query"> } : {}) &
  (O extends { headers: Schema } ? { headers: OutputAt<O, "headers"> } : {});

export type HandlerFor<P extends string, O extends RouteConfig> = (
  req: Request,
  ctx: CtxFor<P, O>,
) => Response | Promise<Response>;

/** Back-compat aliases for the no-schema case. */
export type Ctx<P extends string = string> = CtxFor<P, {}>;
export type Handler<P extends string = string> = HandlerFor<P, {}>;

// ── Route registry (drives the typed client) ────────────────────────────────
export interface RouteEntry {
  params: Record<string, string>;
  body: unknown;
  query: unknown;
  headers: unknown;
  response: unknown;
}
export type RouteTable = Record<string, RouteEntry>;

/** What one route contributes to the registry (client-facing types). */
export type EntryFor<P extends string, O extends RouteConfig> = {
  params: ParamsOf<P>;
  body: O extends { body: Schema } ? InputAt<O, "body"> : undefined;
  query: O extends { query: Schema } ? InputAt<O, "query"> : undefined;
  headers: O extends { headers: Schema } ? InputAt<O, "headers"> : undefined;
  response: ResponseOutput<O>;
};

/** Add one method+pattern to a route table. */
export type Add<
  R extends RouteTable,
  M extends string,
  P extends string,
  O extends RouteConfig,
> = R & Record<`${M} ${P}`, EntryFor<P, O>>;

// Internal, erased handler shape for storage and dispatch.
type AnyCtx = MiddlewareContext & { readonly responseHeaders: Headers };
type AnyHandler = (req: Request, ctx: AnyCtx) => Response | Promise<Response>;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type Method = (typeof METHODS)[number];

/**
 * A started server. Returned by `start()`. It deliberately has no route or
 * upstream methods: adding routes after start is a compile error, not just a
 * runtime throw. Call `stop()` to shut swerver down and clean up.
 */
export interface RunningSwerver {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

export interface SwerverOptions {
  /** Front-facing port swerver listens on. Default 8080. */
  port?: number;
  /** Bind address for the front listener. Default swerver's own default. */
  address?: string;
  /**
   * Worker processes. Default 1. Socket backend: passed to swerver's native
   * fork. FFI backend: a value > 1 re-execs this script as N supervised workers
   * that share the port via SO_REUSEPORT (0 means one per CPU). Kernel load
   * balancing across FFI workers is Linux-only; on macOS they bind but the
   * kernel does not distribute.
   */
  workers?: number;
  /** Serve a directory of static files (swerver handles this, not TS). */
  staticRoot?: string;
  /** Cache static files in each native worker after first access. */
  cacheStaticFiles?: boolean;
  /** Disable native middleware for benchmark-only deployments. */
  disableMiddleware?: boolean;
  /** Enable swerver's pre-encoded response registry. */
  preencoded?: boolean;
  maxConnections?: number;
  allowedHosts?: string[];
  listeners?: SwerverConfig["server"]["listeners"];
  timeouts?: SwerverConfig["timeouts"];
  limits?: SwerverConfig["limits"];
  bufferPool?: SwerverConfig["buffer_pool"];
  tls?: TlsConfig;
  http2?: Http2Config;
  quic?: QuicConfig;
  x402?: SwerverConfig["x402"];
  admin?: AdminConfig;
  otel?: OtelConfig;
  postgres?: SwerverConfig["postgres"];
  wasmFilters?: SwerverConfig["wasm_filters"];
  wasmControlSocket?: string;
  wasmControlConnections?: number;
  wasmHostCallDeadlineMs?: number;
  tenantIdleTtlMs?: number;
  /** Extra swerver config merged over the generated one (tls, upstreams, routes, ...). */
  raw?: Partial<SwerverConfig>;
  /**
   * How dynamic routes are served. "socket" (default) proxies to a Bun app
   * server over a unix socket. "ffi" embeds swerver in-process via libswerver
   * and hands requests to JS with no socket hop (faster; single reactor
   * thread). "ffi" requires Bun and libswerver.
   */
  backend?: "socket" | "ffi";
  /** Explicit path to the swerver binary. Else SWERVER_BIN, platform pkg, or PATH. */
  binaryPath?: string;
  /** Explicit path to libswerver (ffi backend). Else SWERVER_LIB or beside SWERVER_BIN. */
  libraryPath?: string;
  /** Milliseconds to wait for the front port to accept connections. Default 5000. */
  readyTimeoutMs?: number;
  /**
   * Validate every `ctx.json(...)` against the route's response schema and
   * return 500 on a mismatch. Off by default; turn on in development to catch
   * handlers that violate their own declared response contract.
   */
  validateResponses?: boolean;
  /** Mutable application state exposed as `ctx.state`. */
  state?: Record<string, unknown>;
}

// ctx.json tags its Response with the pre-serialization data so the dispatcher
// can validate it against the response schema when validateResponses is on.
const RESPONSE_DATA = Symbol("swerverts.responseData");
// ...and with the JSON string it already serialized, so the FFI direct-write
// path can copy those bytes into the slot instead of stringifying a second time.
const RESPONSE_JSON = Symbol("swerverts.responseJson");

/** Options for `app.docs()`: OpenAPI options plus where to mount the pages. */
export interface DocsOptions extends OpenApiOptions {
  /** Path for the Swagger UI page. Default "/docs". */
  path?: string;
  /** Path for the OpenAPI JSON document. Default "/openapi.json". */
  openapiPath?: string;
}

// Bun's global is untyped from plain TS; declare the sliver we use.
declare const Bun: {
  serve(opts: { unix: string; fetch: (req: Request) => Response | Promise<Response> }): {
    stop(closeActive?: boolean): void;
  };
  spawn(
    cmd: string[],
    opts?: { stdout?: "inherit"; stderr?: "inherit"; env?: Record<string, string | undefined> },
  ): {
    kill(sig?: string | number): void;
    exited: Promise<number>;
  };
  connect(opts: { hostname: string; port: number; socket: Record<string, unknown> }): Promise<{
    end(): void;
  }>;
  listen(opts: { unix: string; socket: Record<string, unknown> }): { stop(closeActive?: boolean): void };
};

type GroupPath<Base extends string, Path extends string> = Base extends `${infer Prefix}/`
  ? Path extends `/${infer Suffix}`
    ? `${Prefix}/${Suffix}`
    : `${Prefix}/${Path}`
  : Path extends `/${string}`
    ? `${Base}${Path}`
    : `${Base}/${Path}`;
type GroupRegistrar = (pattern: string, method: string | undefined, configOrHandler: unknown, handler?: unknown) => void;

/** Prefix-scoped route registrar returned to `app.group()`. */
export class RouteGroup<Base extends string, R extends RouteTable = {}> {
  constructor(
    private readonly base: Base,
    private readonly registerRoute: GroupRegistrar,
  ) {}

  route<P extends string>(path: P, handler: HandlerFor<GroupPath<Base, P>, {}>): this;
  route<P extends string, O extends RouteConfig>(path: P, config: O, handler: HandlerFor<GroupPath<Base, P>, O>): this;
  route(path: string, configOrHandler: unknown, handler?: unknown): this {
    this.registerRoute(joinRoutePath(this.base, path), undefined, configOrHandler, handler);
    return this;
  }

  get<P extends string>(path: P, handler: HandlerFor<GroupPath<Base, P>, {}>): RouteGroup<Base, Add<R, "GET", GroupPath<Base, P>, {}>>;
  get<P extends string, O extends RouteConfig>(path: P, config: O, handler: HandlerFor<GroupPath<Base, P>, O>): RouteGroup<Base, Add<R, "GET", GroupPath<Base, P>, O>>;
  get(path: string, configOrHandler: unknown, handler?: unknown): RouteGroup<Base, any> {
    return this.add("GET", path, configOrHandler, handler);
  }

  post<P extends string>(path: P, handler: HandlerFor<GroupPath<Base, P>, {}>): RouteGroup<Base, Add<R, "POST", GroupPath<Base, P>, {}>>;
  post<P extends string, O extends RouteConfig>(path: P, config: O, handler: HandlerFor<GroupPath<Base, P>, O>): RouteGroup<Base, Add<R, "POST", GroupPath<Base, P>, O>>;
  post(path: string, configOrHandler: unknown, handler?: unknown): RouteGroup<Base, any> {
    return this.add("POST", path, configOrHandler, handler);
  }

  put<P extends string>(path: P, handler: HandlerFor<GroupPath<Base, P>, {}>): RouteGroup<Base, Add<R, "PUT", GroupPath<Base, P>, {}>>;
  put<P extends string, O extends RouteConfig>(path: P, config: O, handler: HandlerFor<GroupPath<Base, P>, O>): RouteGroup<Base, Add<R, "PUT", GroupPath<Base, P>, O>>;
  put(path: string, configOrHandler: unknown, handler?: unknown): RouteGroup<Base, any> {
    return this.add("PUT", path, configOrHandler, handler);
  }

  patch<P extends string>(path: P, handler: HandlerFor<GroupPath<Base, P>, {}>): RouteGroup<Base, Add<R, "PATCH", GroupPath<Base, P>, {}>>;
  patch<P extends string, O extends RouteConfig>(path: P, config: O, handler: HandlerFor<GroupPath<Base, P>, O>): RouteGroup<Base, Add<R, "PATCH", GroupPath<Base, P>, O>>;
  patch(path: string, configOrHandler: unknown, handler?: unknown): RouteGroup<Base, any> {
    return this.add("PATCH", path, configOrHandler, handler);
  }

  delete<P extends string>(path: P, handler: HandlerFor<GroupPath<Base, P>, {}>): RouteGroup<Base, Add<R, "DELETE", GroupPath<Base, P>, {}>>;
  delete<P extends string, O extends RouteConfig>(path: P, config: O, handler: HandlerFor<GroupPath<Base, P>, O>): RouteGroup<Base, Add<R, "DELETE", GroupPath<Base, P>, O>>;
  delete(path: string, configOrHandler: unknown, handler?: unknown): RouteGroup<Base, any> {
    return this.add("DELETE", path, configOrHandler, handler);
  }

  head<P extends string>(path: P, handler: HandlerFor<GroupPath<Base, P>, {}>): RouteGroup<Base, Add<R, "HEAD", GroupPath<Base, P>, {}>>;
  head<P extends string, O extends RouteConfig>(path: P, config: O, handler: HandlerFor<GroupPath<Base, P>, O>): RouteGroup<Base, Add<R, "HEAD", GroupPath<Base, P>, O>>;
  head(path: string, configOrHandler: unknown, handler?: unknown): RouteGroup<Base, any> {
    return this.add("HEAD", path, configOrHandler, handler);
  }

  options<P extends string>(path: P, handler: HandlerFor<GroupPath<Base, P>, {}>): RouteGroup<Base, Add<R, "OPTIONS", GroupPath<Base, P>, {}>>;
  options<P extends string, O extends RouteConfig>(path: P, config: O, handler: HandlerFor<GroupPath<Base, P>, O>): RouteGroup<Base, Add<R, "OPTIONS", GroupPath<Base, P>, O>>;
  options(path: string, configOrHandler: unknown, handler?: unknown): RouteGroup<Base, any> {
    return this.add("OPTIONS", path, configOrHandler, handler);
  }

  private add(method: string, path: string, configOrHandler: unknown, handler?: unknown): this {
    this.registerRoute(joinRoutePath(this.base, path), method, configOrHandler, handler);
    return this;
  }
}

export class Swerver<R extends RouteTable = {}> {
  #opts: SwerverOptions;
  #routes: CompiledRoute<AnyHandler>[] = [];
  #upstreams: Upstream[] = [];
  #proxyRoutes: Route[] = [];
  #app?: { stop(closeActive?: boolean): void };
  #child?: { kill(sig?: string | number): void; exited: Promise<number> };
  #tmpDir?: string;
  #started = false;
  #closed = false;
  #cleanup?: () => void;
  #ffiHandle = 0;
  #wakeListener: { stop(closeActive?: boolean): void } | undefined = undefined;
  #wakePath: string | undefined = undefined;
  #ffiInFlight = new Set<Promise<void>>();
  #state: Record<string, unknown>;
  #middleware: Middleware[] = [];
  #errorHandler: ErrorHandler = (error) => {
    console.error("swerverts handler error:", error);
    return new Response("internal error", { status: 500 });
  };
  #notFoundHandler: NotFoundHandler = () => new Response("not found", { status: 404 });
  #methodNotAllowedHandler: MethodNotAllowedHandler = (_request, allowed) =>
    new Response("method not allowed", { status: 405, headers: { allow: allowed.join(", ") } });

  constructor(opts: SwerverOptions = {}) {
    this.#opts = opts;
    this.#state = opts.state ?? {};
  }

  /** Register global middleware in declaration order. */
  use(middleware: Middleware): this {
    if (this.#started) throw new Error("cannot add middleware after start()");
    this.#middleware.push(middleware);
    return this;
  }

  onError(handler: ErrorHandler): this {
    if (this.#started) throw new Error("cannot change error handling after start()");
    this.#errorHandler = handler;
    return this;
  }

  notFound(handler: NotFoundHandler): this {
    if (this.#started) throw new Error("cannot change error handling after start()");
    this.#notFoundHandler = handler;
    return this;
  }

  methodNotAllowed(handler: MethodNotAllowedHandler): this {
    if (this.#started) throw new Error("cannot change error handling after start()");
    this.#methodNotAllowedHandler = handler;
    return this;
  }

  group<Base extends string, GroupRoutes extends RouteTable>(
    base: Base,
    register: (group: RouteGroup<Base>) => RouteGroup<Base, GroupRoutes>,
  ): Swerver<R & GroupRoutes>;
  group<Base extends string>(base: Base, register: (group: RouteGroup<Base>) => void): this;
  group<Base extends string>(base: Base, register: (group: RouteGroup<Base>) => unknown): Swerver<any> {
    if (this.#started) throw new Error("cannot add routes after start()");
    register(new RouteGroup(base, (pattern, method, configOrHandler, handler) => {
      this.#register(pattern, method, configOrHandler, handler);
    }));
    return this as unknown as Swerver<any>;
  }

  /**
   * Register a dynamic route for any method. Patterns support ":param" and a
   * trailing "*"; `ctx.params` keys are inferred from the pattern. Pass a config
   * object ({ body, query, headers, response } of any Standard Schema) before
   * the handler to validate and type those parts of the request. An any-method
   * route does not contribute to the typed client (its method is ambiguous).
   */
  route<P extends string>(pattern: P, handler: HandlerFor<P, {}>): this;
  route<P extends string, O extends RouteConfig>(
    pattern: P,
    config: O,
    handler: HandlerFor<P, O>,
  ): this;
  route(pattern: string, a: unknown, b?: unknown): this {
    this.#register(pattern, undefined, a, b);
    return this;
  }

  get<P extends string>(pattern: P, handler: HandlerFor<P, {}>): Swerver<Add<R, "GET", P, {}>>;
  get<P extends string, O extends RouteConfig>(
    pattern: P,
    config: O,
    handler: HandlerFor<P, O>,
  ): Swerver<Add<R, "GET", P, O>>;
  get(pattern: string, a: unknown, b?: unknown): Swerver<any> {
    return this.#register(pattern, "GET", a, b);
  }

  delete<P extends string>(pattern: P, handler: HandlerFor<P, {}>): Swerver<Add<R, "DELETE", P, {}>>;
  delete<P extends string, O extends RouteConfig>(
    pattern: P,
    config: O,
    handler: HandlerFor<P, O>,
  ): Swerver<Add<R, "DELETE", P, O>>;
  delete(pattern: string, a: unknown, b?: unknown): Swerver<any> {
    return this.#register(pattern, "DELETE", a, b);
  }

  head<P extends string>(pattern: P, handler: HandlerFor<P, {}>): Swerver<Add<R, "HEAD", P, {}>>;
  head<P extends string, O extends RouteConfig>(
    pattern: P,
    config: O,
    handler: HandlerFor<P, O>,
  ): Swerver<Add<R, "HEAD", P, O>>;
  head(pattern: string, a: unknown, b?: unknown): Swerver<any> {
    return this.#register(pattern, "HEAD", a, b);
  }

  options<P extends string>(pattern: P, handler: HandlerFor<P, {}>): Swerver<Add<R, "OPTIONS", P, {}>>;
  options<P extends string, O extends RouteConfig>(
    pattern: P,
    config: O,
    handler: HandlerFor<P, O>,
  ): Swerver<Add<R, "OPTIONS", P, O>>;
  options(pattern: string, a: unknown, b?: unknown): Swerver<any> {
    return this.#register(pattern, "OPTIONS", a, b);
  }

  post<P extends string>(pattern: P, handler: HandlerFor<P, {}>): Swerver<Add<R, "POST", P, {}>>;
  post<P extends string, O extends RouteConfig>(
    pattern: P,
    config: O,
    handler: HandlerFor<P, O>,
  ): Swerver<Add<R, "POST", P, O>>;
  post(pattern: string, a: unknown, b?: unknown): Swerver<any> {
    return this.#register(pattern, "POST", a, b);
  }

  put<P extends string>(pattern: P, handler: HandlerFor<P, {}>): Swerver<Add<R, "PUT", P, {}>>;
  put<P extends string, O extends RouteConfig>(
    pattern: P,
    config: O,
    handler: HandlerFor<P, O>,
  ): Swerver<Add<R, "PUT", P, O>>;
  put(pattern: string, a: unknown, b?: unknown): Swerver<any> {
    return this.#register(pattern, "PUT", a, b);
  }

  patch<P extends string>(pattern: P, handler: HandlerFor<P, {}>): Swerver<Add<R, "PATCH", P, {}>>;
  patch<P extends string, O extends RouteConfig>(
    pattern: P,
    config: O,
    handler: HandlerFor<P, O>,
  ): Swerver<Add<R, "PATCH", P, O>>;
  patch(pattern: string, a: unknown, b?: unknown): Swerver<any> {
    return this.#register(pattern, "PATCH", a, b);
  }

  // Resolve the (config, handler) vs (handler) overload and register the route.
  #register(pattern: string, method: string | undefined, a: unknown, b: unknown): Swerver<any> {
    if (this.#started) throw new Error("cannot add routes after start()");
    const handler = (typeof a === "function" ? a : b) as AnyHandler;
    const schemas = (typeof a === "function" ? {} : a) as RouteSchemas;
    this.#routes.push(compile(pattern, handler, method, schemas));
    return this as unknown as Swerver<any>;
  }

  /**
   * Declare a swerver upstream and get back an unforgeable reference to it.
   * Pass that reference to `proxy()`; a route cannot target an upstream that
   * was never declared.
   */
  upstream(name: string, def: Omit<Upstream, "name">): UpstreamRef {
    if (this.#started) throw new Error("cannot add upstreams after start()");
    this.#upstreams.push({ name, ...def });
    return brandValue(name);
  }

  /**
   * Proxy a path prefix to a declared upstream (swerver handles it directly,
   * no TS crossing). `target` must be a reference from `upstream()`.
   */
  proxy(prefix: string, target: UpstreamRef, opts?: ProxyOptions): this {
    if (this.#started) throw new Error("cannot add routes after start()");
    this.#proxyRoutes.push({ path_prefix: prefix, upstream: unbrand(target), ...opts });
    return this;
  }

  /** Route a prefix to a per-request warm tenant microVM. */
  tenant(prefix: string, tenant: TenantConfig, opts: ProxyOptions = {}): this {
    if (this.#started) throw new Error("cannot add routes after start()");
    this.#proxyRoutes.push({ path_prefix: prefix, ...opts, tenant });
    return this;
  }

  /** Distinct swerver path prefixes for the registered routes. */
  #prefixes(): string[] {
    return [...new Set(this.#routes.map((r) => r.prefix))];
  }

  /**
   * A typed fetch client for the routes registered so far. Chain the route
   * calls (so `R` accumulates) to get full typing: `client.post("/users/:id",
   * { params, body })` knows the params, body, and response types of the route.
   */
  client(baseUrl?: string): Client<R> {
    const base =
      baseUrl ?? `http://${this.#opts.address ?? "localhost"}:${this.#opts.port ?? 8080}`;
    return createClient<R>(base);
  }

  /**
   * Build an OpenAPI 3.1 document from the registered routes. Path params come
   * from the pattern; bodies and query/header params come from the route
   * schemas, converted to JSON Schema by `options.toJsonSchema` (e.g. Zod v4's
   * `z.toJSONSchema`). Without a converter the structure is still emitted with
   * open body schemas. Any-method `route()` routes are omitted.
   */
  openapi(options: OpenApiOptions = {}): OpenApiDocument {
    return buildOpenApi(this.#routes, options);
  }

  /**
   * Serve interactive API docs. Registers two routes: `openapiPath`
   * (default `/openapi.json`) returning the OpenAPI document, and `path`
   * (default `/docs`) returning a Swagger UI page pointed at it. Both are
   * excluded from the OpenAPI document itself. Pass `toJsonSchema` to fill in
   * body/param schemas (e.g. Zod v4's `z.toJSONSchema`).
   */
  docs(options: DocsOptions = {}): this {
    const path = options.path ?? "/docs";
    const openapiPath = options.openapiPath ?? "/openapi.json";
    const title = options.info?.title ?? "swerverts API";
    const openapiOptions: OpenApiOptions = {
      ...(options.info ? { info: options.info } : {}),
      ...(options.servers ? { servers: options.servers } : {}),
      toJsonSchema: options.toJsonSchema,
    };
    this.#registerInternal(openapiPath, () => Response.json(this.openapi(openapiOptions)));
    this.#registerInternal(
      path,
      () =>
        new Response(swaggerHtml(title, openapiPath), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    return this;
  }

  #registerInternal(pattern: string, handler: (req: Request) => Response): void {
    if (this.#started) throw new Error("cannot add routes after start()");
    const route = compile(pattern, ((req: Request) => handler(req)) as AnyHandler, "GET");
    route.internal = true;
    this.#routes.push(route);
  }

  // Shared request pipeline: match -> validate body/query/headers -> handler
  // -> optional response validation. Used by the live server and the mock.
  async #dispatch(
    req: Request,
    ordered: CompiledRoute<AnyHandler>[],
    validateResponses: boolean,
    parsed?: { pathname: string; query: string },
  ): Promise<Response> {
    const responseHeaders = new Headers();
    const ctx: AnyCtx = {
      params: {},
      state: this.#state,
      responseHeaders,
      json: (data: unknown, init?: number | ResponseInit) => {
        // Serialize exactly once. new Response(json, ...) with the same default
        // content-type Bun's Response.json emits (application/json;charset=utf-8)
        // matches Response.json(data, init) semantics (an init content-type still
        // wins), while letting the FFI direct-write path reuse RESPONSE_JSON
        // instead of re-stringifying.
        const json = JSON.stringify(data);
        if (json === undefined) {
          // undefined, a function, or a symbol: not JSON-serializable.
          // Response.json throws a TypeError here, so match it rather than
          // sending an empty body (and tagging RESPONSE_JSON as undefined).
          throw new TypeError("ctx.json: value is not JSON-serializable");
        }
        const res = new Response(json, mergeResponseInit(init, "application/json;charset=utf-8"));
        Reflect.set(res, RESPONSE_DATA, data);
        Reflect.set(res, RESPONSE_JSON, json);
        return res;
      },
      text: (body: string, init?: number | ResponseInit) =>
        new Response(body, mergeResponseInit(init, "text/plain; charset=utf-8")),
      html: (body: string, init?: number | ResponseInit) =>
        new Response(body, mergeResponseInit(init, "text/html; charset=utf-8")),
      redirect: (location: string, status = 302) =>
        new Response(null, mergeResponseInit({ status, headers: { location } })),
      header: (name: string, value: string) => responseHeaders.set(name, value),
      cookie: (name: string, value: string, options?: CookieOptions) =>
        responseHeaders.append("set-cookie", serializeCookie(name, value, options)),
    };
    try {
      // Routing runs inside the try: match() calls decodeURIComponent on path
      // params and the wildcard tail, which throws URIError on malformed
      // percent-encoding (e.g. a lone '%'). Keeping it here routes that through
      // #errorHandler instead of escaping the dispatcher as an unhandled throw.
      const path = parsed ? parsed.pathname : new URL(req.url).pathname;
      const hit = match(ordered, path, req.method);
      if (hit.kind === "ok") ctx.params = hit.params;

      const terminal = async (): Promise<Response> => {
        if (hit.kind === "none") return this.#notFoundHandler(req, ctx);
        if (hit.kind === "method") return this.#methodNotAllowedHandler(req, hit.allowed, ctx);

        const route = hit.route;
        const { body, query, headers } = route.schemas;

        if (body) {
          let raw: unknown;
          try {
            raw = await req.json();
          } catch {
            return jsonError(400, "invalid JSON body");
          }
          const result = await runValidation(body, raw);
          if (result.issues) return validationError(result.issues);
          ctx.body = result.value;
        }

        if (query) {
          const params = parsed ? new URLSearchParams(parsed.query) : new URL(req.url).searchParams;
          const values: Record<string, string | string[]> = {};
          for (const [key, value] of params) {
            const previous = values[key];
            values[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
          }
          const result = await runValidation(query, values);
          if (result.issues) return validationError(result.issues);
          ctx.query = result.value;
        }

        if (headers) {
          const result = await runValidation(headers, Object.fromEntries(req.headers));
          if (result.issues) return validationError(result.issues);
          ctx.headers = result.value;
        }

        let response = await route.handler(req, ctx);
        const responseSchema = route.schemas.responses?.[response.status] ?? route.schemas.response;
        if (validateResponses && responseSchema && Reflect.has(response, RESPONSE_DATA)) {
          const data = Reflect.get(response, RESPONSE_DATA);
          const result = await runValidation(responseSchema, data);
          if (result.issues) {
            console.error("swerverts response contract violation:", formatIssues(result.issues));
            response = jsonError(500, "response did not match its schema");
          }
        }
        return response;
      };

      const routeMiddleware = hit.kind === "ok" ? (hit.route.schemas.middleware ?? []) : [];
      const response = await runMiddleware(
        [...this.#middleware, ...routeMiddleware],
        req,
        ctx,
        terminal,
      );
      const decorated = applyResponseHeaders(response, responseHeaders);
      return req.method === "HEAD"
        ? new Response(null, { status: decorated.status, statusText: decorated.statusText, headers: decorated.headers })
        : decorated;
    } catch (error) {
      const response = await this.#errorHandler(error, req, ctx);
      const decorated = applyResponseHeaders(response, responseHeaders);
      return req.method === "HEAD"
        ? new Response(null, { status: decorated.status, statusText: decorated.statusText, headers: decorated.headers })
        : decorated;
    }
  }

  /**
   * Dispatch one request against the registered routes in-process, without
   * spawning swerver. A relative path is resolved against a dummy origin.
   * Ideal for unit-testing handlers and validation.
   */
  request(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const req =
      input instanceof Request
        ? input
        : new Request(
            typeof input === "string" && input.startsWith("/")
              ? new URL(input, "http://mock.local")
              : input,
            init,
          );
    return this.#dispatch(req, sortBySpecificity(this.#routes), this.#opts.validateResponses ?? true);
  }

  /**
   * A typed client (same shape as `client()`) that dispatches in-process
   * against the registered routes. No server, no network: for tests.
   */
  mockClient(): Client<R> {
    const ordered = sortBySpecificity(this.#routes);
    const validateResponses = this.#opts.validateResponses ?? true;
    return createClient<R>("http://mock.local", (url, requestInit) =>
      this.#dispatch(new Request(url, requestInit), ordered, validateResponses),
    );
  }

  async start(): Promise<RunningSwerver> {
    if (this.#closed) throw new Error("cannot restart a stopped Swerver instance");
    if (this.#started) throw new Error("already started");
    this.#started = true;
    const port = this.#opts.port ?? 8080;
    const ordered = sortBySpecificity(this.#routes);
    const validateResponses = this.#opts.validateResponses ?? false;

    if (this.#opts.backend === "ffi") {
      // Fork-per-core: when more than one worker is requested and this process
      // is not itself a spawned worker, become the supervisor and re-exec this
      // script as N workers, each a single embedded server sharing the port via
      // SO_REUSEPORT (which libswerver's listener always sets). Kernel load
      // balancing across them is Linux-only; on macOS the workers bind but the
      // kernel does not distribute.
      const workers = ffiWorkerCount(this.#opts.workers);
      if (workers > 1 && process.env["SWERVER_FFI_WORKER"] === undefined) {
        return this.#startForkMaster(port, workers);
      }
      const running = await this.#startFfi(port, ordered, validateResponses);
      this.#watchParent();
      return running;
    }

    this.#tmpDir = mkdtempSync(join(tmpdir(), "swerverts-"));
    const appSocket = join(this.#tmpDir, "app.sock");
    const configPath = join(this.#tmpDir, "config.json");

    // 1. App server must be listening before swerver proxies to it.
    if (this.#routes.length > 0) {
      this.#app = Bun.serve({
        unix: appSocket,
        fetch: (req: Request) => this.#dispatch(req, ordered, validateResponses),
      });
    }

    // 2. Generate, validate, and write the swerver config. validateConfig is
    //    the only minter of ValidatedConfig; #spawn below requires one, so an
    //    invalid config cannot reach swerver. Validation failure aborts before
    //    any child is spawned (the app server is torn down first).
    let validated: ValidatedConfig;
    try {
      validated = validateConfig(
        generateConfig({
          port,
          address: this.#opts.address,
          workers: this.#opts.workers ?? 1,
          staticRoot: this.#opts.staticRoot,
          cacheStaticFiles: this.#opts.cacheStaticFiles,
          disableMiddleware: this.#opts.disableMiddleware,
          preencoded: this.#opts.preencoded,
          maxConnections: this.#opts.maxConnections,
          allowedHosts: this.#opts.allowedHosts,
          listeners: this.#opts.listeners,
          timeouts: this.#opts.timeouts,
          limits: this.#opts.limits,
          bufferPool: this.#opts.bufferPool,
          tls: this.#opts.tls,
          http2: this.#opts.http2,
          quic: this.#opts.quic,
          x402: this.#opts.x402,
          admin: this.#opts.admin,
          otel: this.#opts.otel,
          postgres: this.#opts.postgres,
          wasmFilters: this.#opts.wasmFilters,
          wasmControlSocket: this.#opts.wasmControlSocket,
          wasmControlConnections: this.#opts.wasmControlConnections,
          wasmHostCallDeadlineMs: this.#opts.wasmHostCallDeadlineMs,
          tenantIdleTtlMs: this.#opts.tenantIdleTtlMs,
          appSocket,
          appPrefixes: this.#prefixes(),
          upstreams: this.#upstreams,
          routes: this.#proxyRoutes,
          raw: this.#opts.raw,
        }),
      );
    } catch (err) {
      this.#app?.stop(true);
      rmSync(this.#tmpDir, { recursive: true, force: true });
      this.#started = false;
      throw err;
    }

    // 3. Spawn the swerver binary as the front process.
    this.#child = this.#spawn(validated, configPath);

    // 4. Never orphan the swerver child if this process dies without stop().
    //    'exit' is synchronous, so kill the child directly; signals re-raise
    //    after cleanup so the default exit code is preserved.
    const child = this.#child;
    const onExit = () => child.kill("SIGKILL");
    const onSignal = (sig: NodeJS.Signals) => {
      child.kill();
      process.removeListener("exit", onExit);
      process.kill(process.pid, sig);
    };
    process.on("exit", onExit);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    this.#cleanup = () => {
      process.removeListener("exit", onExit);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };

    // 5. Wait for the front port to accept connections.
    await this.#waitForPort(port, this.#opts.readyTimeoutMs ?? 5000);

    // 6. Hand back a running handle with no definition methods.
    return {
      port,
      url: `http://${this.#opts.address ?? "localhost"}:${port}`,
      stop: () => this.#doStop(),
    };
  }

  #spawn(config: ValidatedConfig, configPath: string): {
    kill(sig?: string | number): void;
    exited: Promise<number>;
  } {
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const bin = resolveBinary(this.#opts.binaryPath);
    return Bun.spawn([bin, "--config", configPath], {
      stdout: "inherit",
      stderr: "inherit",
    });
  }

  // ── FFI fork-per-core supervisor ────────────────────────────────────────
  // Spawn N copies of this script, each starting one embedded server on the
  // shared port. This process serves nothing; it only supervises. Children are
  // marked with SWERVER_FFI_WORKER so their own start() takes the single-server
  // branch instead of re-forking, and carry SWERVER_MASTER_PID so they exit if
  // the supervisor dies without cleaning up (e.g. SIGKILL).
  async #startForkMaster(port: number, workers: number): Promise<RunningSwerver> {
    // macOS/Darwin allows every worker to bind the port but does not
    // load-balance new TCP connections across a SO_REUSEPORT group (no
    // SO_REUSEPORT_LB, no connection hashing), so one worker serves nearly all
    // traffic and the rest idle. Fork-per-core distribution needs Linux.
    if (process.platform === "darwin") {
      console.warn(
        `swerverts: ${workers} FFI workers requested, but macOS does not distribute ` +
          `connections across a SO_REUSEPORT group - one worker will serve nearly all ` +
          `traffic. Run on Linux for real multi-core scaling.`,
      );
    }
    const children: Array<{ kill(sig?: string | number): void; exited: Promise<number> }> = [];
    for (let i = 0; i < workers; i++) {
      children.push(
        Bun.spawn([process.execPath, ...process.argv.slice(1)], {
          stdout: "inherit",
          stderr: "inherit",
          env: { ...process.env, SWERVER_FFI_WORKER: String(i), SWERVER_MASTER_PID: String(process.pid) },
        }),
      );
    }

    const killAll = () => {
      for (const c of children) {
        try {
          c.kill();
        } catch {
          // already exited
        }
      }
    };
    // 'exit' covers normal termination; SIGINT/SIGTERM would otherwise kill the
    // supervisor without reaping the workers, orphaning them on the shared port.
    const onExit = () => killAll();
    const onSignal = () => {
      killAll();
      process.exit(0);
    };
    process.on("exit", onExit);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    this.#cleanup = () => {
      process.removeListener("exit", onExit);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };

    try {
      await this.#waitForPort(port, this.#opts.readyTimeoutMs ?? 5000);
    } catch (err) {
      this.#cleanup();
      killAll();
      this.#started = false;
      throw err;
    }

    return {
      port,
      url: `http://${this.#opts.address ?? "localhost"}:${port}`,
      stop: async () => {
        this.#cleanup?.();
        killAll();
        await Promise.allSettled(children.map((c) => c.exited));
        this.#started = false;
        this.#closed = true;
      },
    };
  }

  // A spawned worker exits if its supervisor disappears without cleanup (a bare
  // SIGKILL skips the supervisor's reaper), so it never lingers holding the
  // shared port. No-op unless spawned by #startForkMaster.
  #watchParent(): void {
    const raw = process.env["SWERVER_MASTER_PID"];
    if (raw === undefined) return;
    const masterPid = Number(raw);
    if (!Number.isInteger(masterPid) || masterPid <= 0) return;
    const timer = setInterval(() => {
      try {
        process.kill(masterPid, 0); // liveness probe; sends no signal
      } catch {
        clearInterval(timer);
        process.exit(0); // supervisor gone; the FFI onExit handler stops the server
      }
    }, 1000);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  // ── FFI backend ─────────────────────────────────────────────────────────
  async #startFfi(
    port: number,
    ordered: CompiledRoute<AnyHandler>[],
    validateResponses: boolean,
  ): Promise<RunningSwerver> {
    const lib = loadLib(resolveLib(this.#opts.libraryPath));
    let handle = 0;
    let nativeStarted = false;
    let stopped = false;

    const closeWake = () => {
      this.#wakeListener?.stop(true);
      this.#wakeListener = undefined;
      if (this.#wakePath) {
        rmSync(this.#wakePath, { force: true });
        this.#wakePath = undefined;
      }
    };

    try {
      // Config for the embedded server: no app upstream (dynamic routes are
      // handled in-process via FFI, not proxied). Static and any raw upstreams/
      // routes still pass through. workers is forced to 1 by libswerver.
      const config = validateConfig(
        generateConfig({
          port,
          address: this.#opts.address,
          staticRoot: this.#opts.staticRoot,
          cacheStaticFiles: this.#opts.cacheStaticFiles,
          disableMiddleware: this.#opts.disableMiddleware,
          preencoded: this.#opts.preencoded,
          maxConnections: this.#opts.maxConnections,
          allowedHosts: this.#opts.allowedHosts,
          listeners: this.#opts.listeners,
          timeouts: this.#opts.timeouts,
          limits: this.#opts.limits,
          bufferPool: this.#opts.bufferPool,
          tls: this.#opts.tls,
          http2: this.#opts.http2,
          quic: this.#opts.quic,
          x402: this.#opts.x402,
          admin: this.#opts.admin,
          otel: this.#opts.otel,
          postgres: this.#opts.postgres,
          wasmFilters: this.#opts.wasmFilters,
          wasmControlSocket: this.#opts.wasmControlSocket,
          wasmControlConnections: this.#opts.wasmControlConnections,
          wasmHostCallDeadlineMs: this.#opts.wasmHostCallDeadlineMs,
          tenantIdleTtlMs: this.#opts.tenantIdleTtlMs,
          appSocket: "",
          appPrefixes: [],
          upstreams: this.#upstreams,
          routes: this.#proxyRoutes,
          raw: this.#opts.raw,
        }),
      );
      const cfgBytes = _ffiEncoder.encode(JSON.stringify(config));
      handle = lib.init(ptr(cfgBytes), BigInt(cfgBytes.length));
      if (handle === 0) throw new Error("swerver_init failed (see stderr)");
      this.#ffiHandle = handle;

      for (const [routeId, prefix] of this.#prefixes().entries()) {
        const pattern = _ffiEncoder.encode(prefix);
        if (lib.route(handle, ptr(pattern), BigInt(pattern.length), routeId) !== 0) {
          throw new Error(`swerver_route failed for '${prefix}'`);
        }
      }

      // Push wake: the reactor wakes Bun over a unix socket when a request
      // parks. Request descriptors are copied out synchronously before each
      // handler reaches its first await, so one shared slab is sufficient.
      const slabBuffer = new ArrayBuffer(80);
      const slab = new Uint32Array(slabBuffer);
      const slabPtr = ptr(slabBuffer);
      const track = (task: Promise<void>) => {
        this.#ffiInFlight.add(task);
        void task
          .catch((error: unknown) => console.error("swerverts ffi dispatch error:", error))
          .finally(() => this.#ffiInFlight.delete(task));
      };
      const drain = (): number => {
        lib.wakeClear();
        let count = 0;
        let reqId = lib.poll();
        while (reqId !== 0n) {
          track(this.#handleFfi(lib, reqId, slab, slabPtr, ordered, validateResponses));
          count += 1;
          reqId = lib.poll();
        }
        return count;
      };

      this.#wakePath = join(
        tmpdir(),
        `swerverts-wake-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
      );
      rmSync(this.#wakePath, { force: true });
      this.#wakeListener = Bun.listen({
        unix: this.#wakePath,
        socket: { open() {}, data: () => drain() },
      });
      const wakePathBytes = _ffiEncoder.encode(this.#wakePath);
      if (lib.wakeConnect(handle, ptr(wakePathBytes), BigInt(wakePathBytes.length)) !== 0) {
        throw new Error("swerver_wake_connect failed");
      }

      if (lib.start(handle) !== 0) throw new Error("swerver_start failed");
      nativeStarted = true;

      const onExit = () => {
        if (this.#ffiHandle !== 0) lib.stop(this.#ffiHandle);
      };
      process.on("exit", onExit);
      this.#cleanup = () => process.removeListener("exit", onExit);

      await this.#waitForPort(port, this.#opts.readyTimeoutMs ?? 5000);

      return {
        port,
        url: `http://${this.#opts.address ?? "localhost"}:${port}`,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          this.#cleanup?.();

          // Stop FFI route admission while keeping the reactor and bridge alive
          // for handlers already executing in Bun.
          if (this.#ffiHandle !== 0) lib.shutdown(this.#ffiHandle);
          do {
            drain();
            if (this.#ffiInFlight.size > 0) {
              await Promise.allSettled([...this.#ffiInFlight]);
            } else if (lib.pending() > 0) {
              await sleep(1);
            }
          } while (lib.pending() > 0 || this.#ffiInFlight.size > 0);

          if (this.#ffiHandle !== 0) {
            lib.stop(this.#ffiHandle);
            this.#ffiHandle = 0;
          }
          closeWake();
          lib.close();
          this.#started = false;
          this.#closed = true;
        },
      };
    } catch (error) {
      this.#cleanup?.();
      if (handle !== 0) {
        if (nativeStarted) lib.shutdown(handle);
        lib.stop(handle);
      }
      this.#ffiHandle = 0;
      closeWake();
      lib.close();
      this.#started = false;
      throw error;
    }
  }

  async #handleFfi(
    lib: Lib,
    reqId: bigint,
    slab: Uint32Array,
    slabPtr: number,
    ordered: CompiledRoute<AnyHandler>[],
    validateResponses: boolean,
  ): Promise<void> {
    // Read the request synchronously into JS values before any await. Little
    // endian: each u64 is [low32, high32]; pointers fit in a JS number (48-bit
    // virtual addresses), lengths are u32.
    if (lib.request(reqId, slabPtr) !== 0) return;
    const method = readSlice(slab[0]! + slab[1]! * 4294967296, slab[2]!);
    const rawPath = readSlice(slab[4]! + slab[5]! * 4294967296, slab[6]!);
    // requestHeaders shares the slot request() just resolved, so it fails only
    // if the slot went stale. Fall back to no headers rather than returning
    // without answering, which would strand the slot until shutdown. Read the
    // header lanes only when it succeeded (they are otherwise stale slab data).
    const hasHeaders = lib.requestHeaders(reqId, slabPtr + 64) === 0;
    const headersPtr = hasHeaders ? slab[16]! + slab[17]! * 4294967296 : 0;
    const headersLen = hasHeaders ? slab[18]! : 0;
    const bodyLen = slab[10]!;
    // `body` is a view over the slot's native req_body (no copy). Safe only
    // because the Request constructor below extracts the BufferSource
    // synchronously, before the first await, while the slot is still parked; the
    // bytes are never read after the slot is freed. Do not defer this read.
    const body =
      bodyLen > 0
        ? new Uint8Array(toArrayBuffer(slab[8]! + slab[9]! * 4294967296, 0, bodyLen))
        : undefined;
    // The slot's response buffer: JSON responses are serialized straight into it.
    const respPtr = slab[12]! + slab[13]! * 4294967296;
    const respCap = slab[14]!;

    // Split the path into pathname + query once, so #dispatch does not re-parse
    // the URL it would otherwise rebuild from req.url.
    const qi = rawPath.indexOf("?");
    const pathname = qi < 0 ? rawPath : rawPath.slice(0, qi);
    const query = qi < 0 ? "" : rawPath.slice(qi + 1);

    try {
      // Decode request headers inside the try: readPackedHeaders can throw (a
      // header value Headers.append rejects, or a malformed packed block).
      // Outside the try that throw would leave the slot parked forever (never
      // answered, never freed) instead of returning a 500. It still runs before
      // the first await, so the shared slab is consumed before drain reuses it.
      const headers = readPackedHeaders(headersPtr, headersLen);
      const init: RequestInit = { method, headers };
      if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = body;
      const req = new Request(`http://ffi.local${rawPath}`, init);
      const res = await this.#dispatch(req, ordered, validateResponses, { pathname, query });
      const status = res.status;
      const responseHeaders = encodeFfiResponseHeaders(res.headers);

      // Direct-write fast path: a ctx.json response already serialized its body
      // (RESPONSE_JSON), so copy those bytes straight into the slot's response
      // buffer (a writable view) and answer in place - no second JSON.stringify,
      // no res.arrayBuffer() copy, no respond() body copy.
      if (Reflect.has(res, RESPONSE_JSON)) {
        const json = Reflect.get(res, RESPONSE_JSON) as string;
        const view = new Uint8Array(toArrayBuffer(respPtr, 0, respCap));
        const { read, written } = _ffiEncoder.encodeInto(json, view);
        if (read === json.length) {
          const result = responseHeaders.packed
            ? lib.respondInplaceFull(
                reqId,
                status,
                ptrOrEmpty(responseHeaders.packed),
                responseHeaders.packed.length,
                written,
              )
            : lib.respondInplace(
                reqId,
                status,
                ptrOrEmpty(responseHeaders.contentType),
                responseHeaders.contentType.length,
                written,
              );
          finishFfiResponse(lib, reqId, result);
          return;
        }
        // Overflowed the slot buffer; fall through to the copy path.
      }
      const out = new Uint8Array(await res.arrayBuffer());
      const result = responseHeaders.packed
        ? lib.respondFull(
            reqId,
            status,
            ptrOrEmpty(responseHeaders.packed),
            responseHeaders.packed.length,
            ptrOrEmpty(out),
            out.length,
          )
        : lib.respond(
            reqId,
            status,
            ptrOrEmpty(responseHeaders.contentType),
            responseHeaders.contentType.length,
            ptrOrEmpty(out),
            out.length,
          );
      finishFfiResponse(lib, reqId, result);
    } catch (err) {
      console.error("swerverts ffi handler error:", err);
      const ct = _ffiEncoder.encode("text/plain");
      const result = lib.respond(
        reqId,
        500,
        ptr(ct),
        ct.length,
        ptr(_ffiInternalError),
        _ffiInternalError.length,
      );
      if (result !== 0 && result !== -1) {
        console.error(`swerverts ffi fallback response failed: ${result}`);
      }
    }
  }

  async #waitForPort(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      // Bail early if swerver died (bad config, port in use).
      if (this.#child && (await this.#exitedNow())) {
        throw new Error("swerver exited before the port came up (check config/stderr)");
      }
      try {
        const conn = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
        conn.end();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(50);
      }
    }
    throw new Error(`swerver did not accept connections on :${port} within ${timeoutMs}ms (${lastErr})`);
  }

  async #exitedNow(): Promise<boolean> {
    if (!this.#child) return false;
    return await Promise.race([
      this.#child.exited.then(() => true),
      Promise.resolve(false),
    ]);
  }

  /** Stop swerver and the app server, and clean up the temp socket/config. */
  async #doStop(): Promise<void> {
    this.#cleanup?.();
    this.#app?.stop(true);
    if (this.#child) {
      this.#child.kill();
      const exited = await Promise.race([
        this.#child.exited.then(() => true),
        sleep(2000).then(() => false),
      ]);
      if (!exited) {
        this.#child.kill("SIGKILL");
        await this.#child.exited;
      }
    }
    if (this.#tmpDir) {
      try {
        rmSync(this.#tmpDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    this.#started = false;
    this.#closed = true;
  }
}

const _ffiDecoder = new TextDecoder();
const _ffiEncoder = new TextEncoder();
const _ffiInternalError = _ffiEncoder.encode("internal error");
const _ffiResponseTooLarge = _ffiEncoder.encode("response too large");
// Bun's ptr() throws on a zero-length view, so an empty body/content-type is
// passed as this 1-byte buffer's pointer with length 0.
const _ffiScratch = new Uint8Array(1);
const _ffiScratchPtr = ptr(_ffiScratch);
const ptrOrEmpty = (buf: Uint8Array): number => (buf.length > 0 ? ptr(buf) : _ffiScratchPtr);
function finishFfiResponse(lib: Lib, reqId: bigint, result: number): void {
  if (result === 0 || result === -1) return;
  if (result === -2) {
    const contentType = _ffiEncoder.encode("text/plain");
    const fallback = lib.respond(
      reqId,
      500,
      ptr(contentType),
      contentType.length,
      ptr(_ffiResponseTooLarge),
      _ffiResponseTooLarge.length,
    );
    if (fallback === 0 || fallback === -1) return;
    throw new Error(`swerver fallback response failed (${fallback})`);
  }
  throw new Error(`swerver response failed (${result})`);
}
/** Decode a UTF-8 slice given a pointer and length (both from the FFI slab). */
function readSlice(p: number, len: number): string {
  if (len === 0) return "";
  return _ffiDecoder.decode(toArrayBuffer(p, 0, len));
}

function readPackedHeaders(p: number, len: number): Headers {
  const headers = new Headers();
  if (len === 0) return headers;
  const bytes = new Uint8Array(toArrayBuffer(p, 0, len));
  let offset = 0;
  while (offset < bytes.length) {
    const nameEnd = bytes.indexOf(0, offset);
    if (nameEnd <= offset) throw new Error("invalid packed request headers");
    const name = _ffiDecoder.decode(bytes.subarray(offset, nameEnd));
    offset = nameEnd + 1;
    const valueEnd = bytes.indexOf(0, offset);
    if (valueEnd < offset) throw new Error("invalid packed request headers");
    headers.append(name, _ffiDecoder.decode(bytes.subarray(offset, valueEnd)));
    offset = valueEnd + 1;
  }
  return headers;
}

const _ffiManagedResponseHeaders = new Set([
  "alt-svc",
  "connection",
  "content-length",
  "date",
  "keep-alive",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type FfiResponseHeaders =
  | { contentType: Uint8Array; packed?: never }
  | { contentType?: never; packed: Uint8Array };

function encodeFfiResponseHeaders(headers: Headers): FfiResponseHeaders {
  const entries: Array<readonly [string, string]> = [];
  headers.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (!_ffiManagedResponseHeaders.has(normalized) && normalized !== "set-cookie") {
      entries.push([normalized, value]);
    }
  });
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie) {
    for (const value of getSetCookie.call(headers)) entries.push(["set-cookie", value]);
  } else {
    const value = headers.get("set-cookie");
    if (value !== null) entries.push(["set-cookie", value]);
  }

  if (entries.length === 0 || (entries.length === 1 && entries[0]![0] === "content-type")) {
    return { contentType: _ffiEncoder.encode(entries[0]?.[1] ?? "") };
  }

  let block = "";
  for (const [name, value] of entries) block += `${name}\0${value}\0`;
  return { packed: _ffiEncoder.encode(block) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function joinRoutePath(base: string, path: string): string {
  const left = base.endsWith("/") ? base.slice(0, -1) : base;
  const right = path.startsWith("/") ? path : `/${path}`;
  return `${left}${right}` || "/";
}

/** Resolve the FFI worker count: 1 by default (single embedded server), the CPU
 *  count for 0 (auto), else the requested number. */
function ffiWorkerCount(workers: number | undefined): number {
  if (workers === undefined || workers === 1) return 1;
  if (workers <= 0) return Math.max(1, availableParallelism());
  return Math.floor(workers);
}

function mergeResponseInit(
  init: number | ResponseInit | undefined,
  defaultContentType?: string,
): ResponseInit {
  const base = responseInit(init);
  const headers = new Headers(base.headers);
  if (defaultContentType && !headers.has("content-type")) headers.set("content-type", defaultContentType);
  return { ...base, headers };
}

function applyResponseHeaders(response: Response, pending: Headers): Response {
  if ([...pending].length === 0) return response;
  try {
    copyHeaders(pending, response.headers);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    copyHeaders(pending, headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function copyHeaders(source: Headers, target: Headers): void {
  for (const [name, value] of source) {
    if (name !== "set-cookie") target.set(name, value);
  }
  const getSetCookie = (source as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie) {
    for (const value of getSetCookie.call(source)) target.append("set-cookie", value);
  } else {
    const value = source.get("set-cookie");
    if (value !== null) target.append("set-cookie", value);
  }
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validationError(issues: Parameters<typeof formatIssues>[0]): Response {
  return new Response(
    JSON.stringify({ error: "validation failed", issues: formatIssues(issues) }),
    { status: 422, headers: { "content-type": "application/json" } },
  );
}

// Swagger UI page loading the dist assets from a CDN and pointing at the app's
// own OpenAPI document. Served by the app itself, so no CSP restrictions apply.
function swaggerHtml(title: string, openapiUrl: string): string {
  const safeTitle = title.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
  const url = JSON.stringify(openapiUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({ url: ${url}, dom_id: "#swagger-ui" });
  </script>
</body>
</html>`;
}

export { generateConfig, validateConfig, ConfigError } from "./config.ts";
export type { SwerverConfig, Upstream, Route, UpstreamRef, ValidatedConfig } from "./config.ts";
export type {
  AdminConfig,
  AuthConfig,
  BufferPoolConfig,
  CacheConfig,
  ConnectionPool,
  ConsulDiscovery,
  DnsDiscovery,
  HealthCheck,
  Http2Config,
  ListenerConfig,
  LoadBalancer,
  OtelConfig,
  PostgresConfig,
  ProxyOptions,
  QuicConfig,
  RateLimitConfig,
  RetryConfig,
  ServerConfig,
  TenantConfig,
  TlsConfig,
  TimeoutsConfig,
  TrafficTarget,
  WasmFilterConfig,
  X402Config,
  X402RouteConfig,
  LimitsConfig,
} from "./config.ts";
export type { Brand } from "./brand.ts";
export type { ParamsOf, ParamNames } from "./router.ts";
export type { Schema, InferInput, InferOutput } from "./schema.ts";
export { createClient } from "./client.ts";
export type { Client, ClientResponse } from "./client.ts";
export { buildOpenApi } from "./openapi.ts";
export type { OpenApiDocument, OpenApiOptions } from "./openapi.ts";
export type { FetchLike } from "./client.ts";
export type {
  CookieOptions,
  ErrorHandler,
  MethodNotAllowedHandler,
  Middleware,
  MiddlewareContext,
  Next,
  NotFoundHandler,
  ResponseHelpers,
} from "./framework.ts";
