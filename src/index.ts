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
import { resolveBinary } from "./binary.ts";
import { generateConfig, type SwerverConfig } from "./config.ts";
import { compile, match, sortBySpecificity, type CompiledRoute, type Params } from "./router.ts";

export type Ctx = { params: Params };
export type Handler = (req: Request, ctx: Ctx) => Response | Promise<Response>;

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
  #routes: CompiledRoute<Handler>[] = [];
  #app?: { stop(closeActive?: boolean): void };
  #child?: { kill(sig?: string | number): void; exited: Promise<number> };
  #tmpDir?: string;
  #started = false;
  #cleanup?: () => void;

  constructor(opts: SwerverOptions = {}) {
    this.#opts = opts;
  }

  /** Register a dynamic route. Patterns support ":param" and a trailing "*". */
  route(pattern: string, handler: Handler): this {
    if (this.#started) throw new Error("cannot add routes after start()");
    this.#routes.push(compile(pattern, handler));
    return this;
  }

  /** Distinct swerver path prefixes for the registered routes. */
  #prefixes(): string[] {
    return [...new Set(this.#routes.map((r) => r.prefix))];
  }

  async start(): Promise<void> {
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
          const hit = match(ordered, path);
          if (!hit) return new Response("not found", { status: 404 });
          try {
            return await hit.route.handler(req, { params: hit.params });
          } catch (err) {
            console.error("swerverts handler error:", err);
            return new Response("internal error", { status: 500 });
          }
        },
      });
    }

    // 2. Generate and write the swerver config.
    const config = generateConfig({
      port,
      address: this.#opts.address,
      workers: this.#opts.workers ?? 1,
      staticRoot: this.#opts.staticRoot,
      appSocket,
      appPrefixes: this.#prefixes(),
      raw: this.#opts.raw,
    });
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // 3. Spawn the swerver binary as the front process.
    const bin = resolveBinary(this.#opts.binaryPath);
    this.#child = Bun.spawn([bin, "--config", configPath], {
      stdout: "inherit",
      stderr: "inherit",
    });

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
  async stop(): Promise<void> {
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

export { generateConfig } from "./config.ts";
export type { SwerverConfig, Upstream, Route } from "./config.ts";
