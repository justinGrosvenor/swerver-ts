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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandValue, unbrand } from "./brand.ts";
import { resolveBinary } from "./binary.ts";
import {
  generateConfig,
  validateConfig,
  type Route,
  type SwerverConfig,
  type Upstream,
  type UpstreamRef,
  type ValidatedConfig,
} from "./config.ts";
import { createClient, type Client } from "./client.ts";
import { buildOpenApi, type OpenApiDocument, type OpenApiOptions } from "./openapi.ts";
import {
  compile,
  match,
  sortBySpecificity,
  type CompiledRoute,
  type Params,
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
}

type OutputAt<O, K extends keyof RouteConfig> =
  O extends Record<K, infer S extends Schema> ? InferOutput<S> : never;
type InputAt<O, K extends keyof RouteConfig> =
  O extends Record<K, infer S extends Schema> ? InferInput<S> : never;

/** JSON responder: typed to the response schema's input when one is declared. */
type JsonFn<O extends RouteConfig> = O extends { response: Schema }
  ? (data: InputAt<O, "response">) => TypedResponse<OutputAt<O, "response">>
  : <T>(data: T) => TypedResponse<T>;

/** Handler context assembled from the route pattern and its declared schemas. */
export type CtxFor<P extends string, O extends RouteConfig> = { params: ParamsOf<P> } & (O extends {
  body: Schema;
}
  ? { body: OutputAt<O, "body"> }
  : {}) &
  (O extends { query: Schema } ? { query: OutputAt<O, "query"> } : {}) &
  (O extends { headers: Schema } ? { headers: OutputAt<O, "headers"> } : {}) & { json: JsonFn<O> };

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
  response: O extends { response: Schema } ? OutputAt<O, "response"> : unknown;
};

/** Add one method+pattern to a route table. */
export type Add<
  R extends RouteTable,
  M extends string,
  P extends string,
  O extends RouteConfig,
> = R & Record<`${M} ${P}`, EntryFor<P, O>>;

// Internal, erased handler shape for storage and dispatch.
type AnyCtx = {
  params: Params;
  body?: unknown;
  query?: unknown;
  headers?: unknown;
  json: (data: unknown) => Response;
};
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
  /** swerver worker processes. Default 1 (predictable for a single app socket). */
  workers?: number;
  /** Serve a directory of static files (swerver handles this, not TS). */
  staticRoot?: string;
  /** Extra swerver config merged over the generated one (tls, upstreams, routes, ...). */
  raw?: Partial<SwerverConfig>;
  /** Explicit path to the swerver binary. Else SWERVER_BIN, platform pkg, or PATH. */
  binaryPath?: string;
  /** Milliseconds to wait for the front port to accept connections. Default 5000. */
  readyTimeoutMs?: number;
  /**
   * Validate every `ctx.json(...)` against the route's response schema and
   * return 500 on a mismatch. Off by default; turn on in development to catch
   * handlers that violate their own declared response contract.
   */
  validateResponses?: boolean;
}

// ctx.json tags its Response with the pre-serialization data so the dispatcher
// can validate it against the response schema when validateResponses is on.
const RESPONSE_DATA = Symbol("swerverts.responseData");

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
  spawn(cmd: string[], opts?: { stdout?: "inherit"; stderr?: "inherit" }): {
    kill(sig?: string | number): void;
    exited: Promise<number>;
  };
  connect(opts: { hostname: string; port: number; socket: Record<string, unknown> }): Promise<{
    end(): void;
  }>;
};

export class Swerver<R extends RouteTable = {}> {
  #opts: SwerverOptions;
  #routes: CompiledRoute<AnyHandler>[] = [];
  #upstreams: Upstream[] = [];
  #proxyRoutes: Route[] = [];
  #app?: { stop(closeActive?: boolean): void };
  #child?: { kill(sig?: string | number): void; exited: Promise<number> };
  #tmpDir?: string;
  #started = false;
  #cleanup?: () => void;

  constructor(opts: SwerverOptions = {}) {
    this.#opts = opts;
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
  proxy(prefix: string, target: UpstreamRef, opts?: Omit<Route, "path_prefix" | "upstream">): this {
    if (this.#started) throw new Error("cannot add routes after start()");
    this.#proxyRoutes.push({ path_prefix: prefix, upstream: unbrand(target), ...opts });
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
  ): Promise<Response> {
    const path = new URL(req.url).pathname;
    const hit = match(ordered, path, req.method);
    if (hit.kind === "none") return new Response("not found", { status: 404 });
    if (hit.kind === "method") {
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: hit.allowed.join(", ") },
      });
    }
    const route = hit.route;
    const ctx: AnyCtx = {
      params: hit.params,
      json: (data: unknown) => {
        const res = Response.json(data);
        Reflect.set(res, RESPONSE_DATA, data);
        return res;
      },
    };
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
      const q = Object.fromEntries(new URL(req.url).searchParams);
      const result = await runValidation(query, q);
      if (result.issues) return validationError(result.issues);
      ctx.query = result.value;
    }

    if (headers) {
      const h = Object.fromEntries(req.headers);
      const result = await runValidation(headers, h);
      if (result.issues) return validationError(result.issues);
      ctx.headers = result.value;
    }

    let out: Response;
    try {
      out = await route.handler(req, ctx);
    } catch (err) {
      console.error("swerverts handler error:", err);
      return new Response("internal error", { status: 500 });
    }

    const responseSchema = route.schemas.response;
    if (validateResponses && responseSchema && Reflect.has(out, RESPONSE_DATA)) {
      const data = Reflect.get(out, RESPONSE_DATA);
      const result = await runValidation(responseSchema, data);
      if (result.issues) {
        console.error("swerverts response contract violation:", formatIssues(result.issues));
        return jsonError(500, "response did not match its schema");
      }
    }
    return out;
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
    if (this.#started) throw new Error("already started");
    this.#started = true;
    const port = this.#opts.port ?? 8080;
    const ordered = sortBySpecificity(this.#routes);
    const validateResponses = this.#opts.validateResponses ?? false;

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
    this.#child?.kill();
    this.#app?.stop(true);
    if (this.#child) {
      await Promise.race([this.#child.exited, sleep(2000)]);
    }
    if (this.#tmpDir) {
      try {
        rmSync(this.#tmpDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    this.#started = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
export type { Brand } from "./brand.ts";
export type { ParamsOf, ParamNames } from "./router.ts";
export type { Schema, InferInput, InferOutput } from "./schema.ts";
export { createClient } from "./client.ts";
export type { Client, ClientResponse } from "./client.ts";
export { buildOpenApi } from "./openapi.ts";
export type { OpenApiDocument, OpenApiOptions } from "./openapi.ts";
export type { FetchLike } from "./client.ts";
