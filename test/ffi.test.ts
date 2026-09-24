import { describe, expect, test } from "bun:test";
import { Swerver } from "../src/index.ts";

const ffiTest = process.env["SWERVER_LIB"] ? test : test.skip;

describe("FFI backend", () => {
  ffiTest("round-trips request and response metadata", async () => {
    const port = 20_000 + (process.pid % 20_000);
    let slowStartedResolve: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => {
      slowStartedResolve = resolve;
    });
    const app = new Swerver({ backend: "ffi", port })
      .get("/headers", (request, ctx) => {
        ctx.header("x-powered-by", "swerverts");
        ctx.cookie("a", "1", { httpOnly: true });
        ctx.cookie("b", "2", { sameSite: "Lax" });
        return ctx.json({ requestId: request.headers.get("x-request-id") });
      })
      .post("/echo", async (request, ctx) => ctx.text(await request.text(), 201))
      .get("/slow", async (_request, ctx) => {
        slowStartedResolve?.();
        await new Promise((resolve) => setTimeout(resolve, 25));
        return ctx.text("drained");
      });

    const server = await app.start();
    try {
      const headers = await fetch(`${server.url}/headers`, {
        headers: { "x-request-id": "roundtrip" },
      });
      expect(headers.status).toBe(200);
      expect(await headers.json()).toEqual({ requestId: "roundtrip" });
      expect(headers.headers.get("x-powered-by")).toBe("swerverts");
      expect(headers.headers.getSetCookie()).toEqual([
        "a=1; HttpOnly",
        "b=2; SameSite=Lax",
      ]);

      const echo = await fetch(`${server.url}/echo`, { method: "POST", body: "payload" });
      expect(echo.status).toBe(201);
      expect(await echo.text()).toBe("payload");
      expect(echo.headers.get("content-type")).toBe("text/plain; charset=utf-8");

      const slowResponse = fetch(`${server.url}/slow`);
      await slowStarted;
      const stopping = server.stop();
      expect(await (await slowResponse).text()).toBe("drained");
      await stopping;
    } finally {
      await server.stop();
    }
  });
});
