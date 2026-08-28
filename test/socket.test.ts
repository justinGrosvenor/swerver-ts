import { describe, expect, test } from "bun:test";
import { Swerver } from "../src/index.ts";

const socketTest = process.env["SWERVER_BIN"] ? test : test.skip;

describe("socket backend", () => {
  socketTest("round-trips metadata and forcibly reaps a long native drain", async () => {
    const port = 40_000 + (process.pid % 10_000);
    const app = new Swerver({ backend: "socket", port }).get("/headers", (request, ctx) => {
      ctx.header("x-request-id", request.headers.get("x-request-id") ?? "");
      ctx.cookie("session", "abc", { httpOnly: true });
      return ctx.json({ ok: true });
    });

    const server = await app.start();
    const response = await fetch(`${server.url}/headers`, {
      headers: { "x-request-id": "socket" },
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("x-request-id")).toBe("socket");
    expect(response.headers.getSetCookie()).toEqual(["session=abc; HttpOnly"]);

    const started = performance.now();
    await server.stop();
    expect(performance.now() - started < 3_000).toBe(true);
  });
});
