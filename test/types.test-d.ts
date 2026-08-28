// Compile-only tests. These assert the *types* behave; there is nothing to run.
// `tsc --noEmit` failing on this file is the test failing.

import { Swerver } from "../src/index.ts";
import type { ParamsOf } from "../src/router.ts";
import type { UpstreamRef } from "../src/config.ts";

// ── Helpers ────────────────────────────────────────────────────────────────
type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// ── Param inference from the pattern literal ────────────────────────────────
type _p1 = Expect<Equal<ParamsOf<"/health">, {}>>;
type _p2 = Expect<Equal<ParamsOf<"/users/:id">, { id: string }>>;
type _p3 = Expect<Equal<ParamsOf<"/users/:id/posts/:postId">, { id: string; postId: string }>>;
type _p4 = Expect<Equal<ParamsOf<"/files/*">, { rest: string }>>;
type _p5 = Expect<Equal<ParamsOf<"/t/:a/:b/:c">, { a: string; b: string; c: string }>>;

const app = new Swerver({ port: 8080 });

// Handler ctx.params keys are inferred from the pattern.
app.route("/users/:id", (_req, ctx) => {
  const id: string = ctx.params.id; // ok
  void id;
  // @ts-expect-error - "name" is not a param of this pattern
  ctx.params.name;
  return new Response("ok");
});

app.get("/files/*", (_req, ctx) => {
  const rest: string = ctx.params.rest; // ok
  void rest;
  return new Response("ok");
});

app.post("/health", (_req, ctx) => {
  // @ts-expect-error - no params on this pattern
  ctx.params.anything;
  return new Response("ok");
});

// ── Unforgeable upstream references ─────────────────────────────────────────
const bedrock = app.upstream("bedrock", {
  servers: [{ address: "example.com", port: 443 }],
  tls: true,
});
type _u1 = Expect<Equal<typeof bedrock, UpstreamRef>>;

app.proxy("/models/", bedrock); // ok: a real reference

// @ts-expect-error - a bare string is not an UpstreamRef; the brand is unforgeable
app.proxy("/models/", "bedrock");

// @ts-expect-error - even the right name as a plain string will not do
app.proxy("/x/", "typo-upstream");
