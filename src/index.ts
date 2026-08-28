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
import {
  compile,
  match,
  sortBySpecificity,
  type CompiledRoute,
  type Params,
  type ParamsOf,
} from "./router.ts";

/** Handler context. `params` keys are inferred from the route pattern. */
export type Ctx<P extends string = string> = { params: ParamsOf<P> };
export type Handler<P extends string = string> = (
  req: Request,
  ctx: Ctx<P>,
) => Response | Promise<Response>;

// Internal, param-erased handler shape for storage and dispatch.
type AnyHandler = (req: Request, ctx: { params: Params }) => Response | Promise<Response>;

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

export class Swerver {
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
   * trailing "*"; the handler's `ctx.params` keys are inferred from the pattern.
   */
  route<P extends string>(pattern: P, handler: Handler<P>): this {
    return this.#add(pattern, handler as AnyHandler, undefined);
  }

  get<P extends string>(pattern: P, handler: Handler<P>): this {
    return this.#add(pattern, handler as AnyHandler, "GET");
  }
  post<P extends string>(pattern: P, handler: Handler<P>): this {
    return this.#add(pattern, handler as AnyHandler, "POST");
  }
  put<P extends string>(pattern: P, handler: Handler<P>): this {
    return this.#add(pattern, handler as AnyHandler, "PUT");
  }
  patch<P extends string>(pattern: P, handler: Handler<P>): this {
    return this.#add(pattern, handler as AnyHandler, "PATCH");
  }
  delete<P extends string>(pattern: P, handler: Handler<P>): this {
    return this.#add(pattern, handler as AnyHandler, "DELETE");
  }

  #add(pattern: string, handler: AnyHandler, method?: string): this {
    if (this.#started) throw new Error("cannot add routes after start()");
    this.#routes.push(compile(pattern, handler, method));
    return this;
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

  async start(): Promise<RunningSwerver> {
    if (this.#started) throw new Error("already started");
    this.#started = true;
    const port = this.#opts.port ?? 8080;
    const ordered = sortBySpecificity(this.#routes);

    this.#tmpDir = mkdtempSync(join(tmpdir(), "swerverts-"));
    const appSocket = join(this.#tmpDir, "app.sock");
    const configPath = join(this.#tmpDir, "config.json");

    // 1. App server must be listening before swerver proxies to it.
    if (this.#routes.length > 0) {
      this.#app = Bun.serve({
        unix: appSocket,
        fetch: async (req: Request) => {
          const path = new URL(req.url).pathname;
          const hit = match(ordered, path, req.method);
          if (hit.kind === "none") return new Response("not found", { status: 404 });
          if (hit.kind === "method") {
            return new Response("method not allowed", {
              status: 405,
              headers: { allow: hit.allowed.join(", ") },
            });
          }
          try {
            return await hit.route.handler(req, { params: hit.params });
          } catch (err) {
            console.error("swerverts handler error:", err);
            return new Response("internal error", { status: 500 });
          }
        },
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

export { generateConfig, validateConfig, ConfigError } from "./config.ts";
export type { SwerverConfig, Upstream, Route, UpstreamRef, ValidatedConfig } from "./config.ts";
export type { Brand } from "./brand.ts";
export type { ParamsOf, ParamNames } from "./router.ts";
