import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { generateConfig, Swerver, validateConfig } from "../src/index.ts";

describe("framework runtime", () => {
  test("runs global and route middleware in onion order", async () => {
    const order: string[] = [];
    const app = new Swerver()
      .use(async (_request, ctx, next) => {
        order.push("global:before");
        const response = await next();
        ctx.header("x-global", "yes");
        order.push("global:after");
        return response;
      })
      .get(
        "/hello/:name",
        {
          middleware: [async (_request, _ctx, next) => {
            order.push("route:before");
            const response = await next();
            order.push("route:after");
            return response;
          }],
        },
        (_request, ctx) => ctx.text(`hello ${ctx.params.name}`),
      );

    const response = await app.request("/hello/ada");
    expect(await response.text()).toBe("hello ada");
    expect(response.headers.get("x-global")).toBe("yes");
    expect(order).toEqual(["global:before", "route:before", "route:after", "global:after"]);
  });

  test("supports helpers, cookies, state, and custom errors", async () => {
    const app = new Swerver({ state: { service: "users" } })
      .onError((error, _request, ctx) => {
        ctx.cookie("failure", "1", { httpOnly: true, path: "/" });
        return ctx.json({ error: String(error) }, 503);
      })
      .get("/boom", () => {
        throw new Error("offline");
      });

    const response = await app.request("/boom");
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toContain("failure=1");
    expect(response.headers.getSetCookie()).toEqual(["failure=1; Path=/; HttpOnly"]);
    expect(await response.json()).toEqual({ error: "Error: offline" });
  });

  test("preserves distinct response cookies exactly once", async () => {
    const app = new Swerver().get("/cookies", (_request, ctx) => {
      ctx.cookie("a", "1", { httpOnly: true });
      ctx.cookie("b", "2", { sameSite: "Lax" });
      return ctx.text("ok");
    });

    const response = await app.request("/cookies");
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; HttpOnly",
      "b=2; SameSite=Lax",
    ]);

    const invalid = new Swerver()
      .onError((_error, _request, ctx) => ctx.text("invalid", 500))
      .get("/cookie", (_request, ctx) => {
        ctx.cookie("session", "abc", { path: "/\r\nx-evil: yes" });
        return ctx.text("unreachable");
      });
    expect((await invalid.request("/cookie")).status).toBe(500);
  });

  test("provides automatic HEAD and custom 404/405", async () => {
    const app = new Swerver()
      .notFound((_request, ctx) => ctx.text("missing", 404))
      .methodNotAllowed((_request, allowed, ctx) => ctx.json({ allowed }, 405))
      .get("/resource", (_request, ctx) => ctx.text("payload"));

    const head = await app.request("/resource", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const wrongMethod = await app.request("/resource", { method: "POST" });
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.json()).toEqual({ allowed: ["GET", "HEAD"] });

    expect(await (await app.request("/missing")).text()).toBe("missing");
  });

  test("validates repeated query parameters and response status contracts", async () => {
    const Query = z.object({ tag: z.union([z.string(), z.array(z.string())]) });
    const Found = z.object({ tags: z.array(z.string()) });
    const app = new Swerver({ validateResponses: true }).get(
      "/search",
      { query: Query, responses: { 200: Found }, summary: "Search" },
      (_request, ctx) => {
        const tags = Array.isArray(ctx.query.tag) ? ctx.query.tag : [ctx.query.tag];
        return ctx.json({ tags }, 200);
      },
    );

    const response = await app.request("/search?tag=a&tag=b");
    expect(await response.json()).toEqual({ tags: ["a", "b"] });
    const operation = (app.openapi({ toJsonSchema: (schema) => z.toJSONSchema(schema as z.ZodType) })["paths"] as Record<string, any>)["/search"]["get"];
    expect(operation.summary).toBe("Search");
    expect(operation.responses["200"]).toBeDefined();
  });

  test("registers prefixed route groups", async () => {
    const app = new Swerver().group("/api", (api) => {
      api.get("/users/:id", (_request, ctx) => ctx.json({ id: ctx.params.id }));
    });
    expect(await (await app.request("/api/users/7")).json()).toEqual({ id: "7" });
  });

  test("generates the complete typed gateway surface", () => {
    const config = generateConfig({
      port: 8443,
      appSocket: "",
      appPrefixes: [],
      listeners: [{ port: 8443, use_tls: true }],
      bufferPool: { buffer_count: 4096 },
      x402: { enabled: true, payment_required_b64: "payload" },
      postgres: { url: "postgres://app@db/app", password_env: "PG_PASSWORD" },
      wasmFilters: [{ match: "/tenant/", module: "./tenant.wasm", instances: 8 }],
      wasmControlSocket: "/run/nether/control.sock",
      wasmControlConnections: 4,
      tenantIdleTtlMs: 60_000,
      routes: [{ path_prefix: "/tenant/", tenant: { socket_dir: "/run/nether/tenants" } }],
    });

    expect(config.server.listeners).toEqual([{ port: 8443, use_tls: true }]);
    expect(config.buffer_pool).toEqual({ buffer_count: 4096 });
    expect(config.wasm_control_connections).toBe(4);
    expect(validateConfig(config)).toBe(config);
  });
});
