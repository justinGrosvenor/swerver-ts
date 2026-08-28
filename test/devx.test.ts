import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Swerver, HttpError, error } from "../src/index.ts";

describe("implicit returns", () => {
  const app = new Swerver()
    .get("/obj", () => ({ hi: "ada" }))
    .get("/str", () => "pong")
    .get("/num", () => 42)
    .get("/void", () => {})
    .get("/resp", () => new Response("raw", { status: 201 }));

  test("plain object becomes JSON", async () => {
    const res = await app.request("/obj");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await res.json()).toEqual({ hi: "ada" });
  });

  test("string becomes text/plain", async () => {
    const res = await app.request("/str");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("pong");
  });

  test("number becomes JSON", async () => {
    expect(await (await app.request("/num")).text()).toBe("42");
  });

  test("undefined becomes 204", async () => {
    const res = await app.request("/void");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("a Response passes through unchanged", async () => {
    const res = await app.request("/resp");
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("raw");
  });

  test("an implicit return is validated against the response schema", async () => {
    const Out = z.object({ id: z.string() });
    const app2 = new Swerver({ validateResponses: true })
      .get("/ok", { response: Out }, () => ({ id: "x" }))
      .get("/bad", { response: Out }, () => ({ id: 123 }) as never);
    expect((await app2.request("/ok")).status).toBe(200);
    expect((await app2.request("/bad")).status).toBe(500);
  });
});

describe("HttpError", () => {
  const app = new Swerver()
    .get("/throw", () => {
      throw error(404, "nope");
    })
    .get("/return", () => error(400, { field: "bad" }))
    .get("/headers", () => error(429, "slow down", { "retry-after": "5" }))
    .onError(() => new Response("onError ran", { status: 500 }));

  test("a thrown HttpError becomes its status and text body", async () => {
    const res = await app.request("/throw");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("nope");
  });

  test("a returned HttpError with an object body serializes to JSON", async () => {
    const res = await app.request("/return");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ field: "bad" });
  });

  test("HttpError headers are preserved", async () => {
    const res = await app.request("/headers");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  test("HttpError skips the error handler (body is the error's, not onError's)", async () => {
    expect(await (await app.request("/throw")).text()).toBe("nope");
  });

  test("error() builds an HttpError instance", () => {
    const e = error(418, "teapot");
    expect(e instanceof HttpError).toBe(true);
    expect(e.status).toBe(418);
  });
});
