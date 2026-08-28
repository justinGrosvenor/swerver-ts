// Compile-only tests. There is nothing to run: `tsc --noEmit` failing on this
// file is the test failing. Assertion tuples are exported so noUnusedLocals
// does not flag them.

import { z } from "zod";
import { Swerver } from "../src/index.ts";
import type { ParamsOf } from "../src/router.ts";
import type { UpstreamRef, ValidatedConfig } from "../src/config.ts";
import { validateConfig } from "../src/index.ts";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// ── Param inference from the pattern literal ────────────────────────────────
export type ParamChecks = [
  Expect<Equal<ParamsOf<"/health">, {}>>,
  Expect<Equal<ParamsOf<"/users/:id">, { id: string }>>,
  Expect<Equal<ParamsOf<"/users/:id/posts/:postId">, { id: string; postId: string }>>,
  Expect<Equal<ParamsOf<"/files/*">, { rest: string }>>,
];

const app = new Swerver({ port: 8080 });

app.get("/users/:id", (_req, ctx) => {
  const id: string = ctx.params.id;
  void id;
  // @ts-expect-error - "name" is not a param of this pattern
  ctx.params.name;
  return new Response("ok");
});

// ── Unforgeable upstream references ─────────────────────────────────────────
const bedrock = app.upstream("bedrock", {
  servers: [{ address: "example.com", port: 443 }],
  tls: true,
});
export type UpstreamChecks = [Expect<Equal<typeof bedrock, UpstreamRef>>];

app.proxy("/models/", bedrock);
// @ts-expect-error - a bare string is not an UpstreamRef; the brand is unforgeable
app.proxy("/models/", "bedrock");

// ── Phantom started state ───────────────────────────────────────────────────
async function lifecycle() {
  const running = await app.start();
  const p: number = running.port;
  void p;
  await running.stop();
  // @ts-expect-error - cannot add routes to a running server (compile-time)
  running.get("/late", () => new Response("no"));
}
void lifecycle;

// ── Validated config brand ──────────────────────────────────────────────────
declare function spawnFromValidated(cfg: ValidatedConfig): void;
const rawCfg = { server: { port: 8080 } };
// @ts-expect-error - a raw config is not a ValidatedConfig
spawnFromValidated(rawCfg);
spawnFromValidated(validateConfig(rawCfg));

// ── Typed body / query / headers / response ─────────────────────────────────
const CreateUser = z.object({ name: z.string(), age: z.number() });
const UserQuery = z.object({ verbose: z.string() });
const AuthHeaders = z.object({ authorization: z.string() });
const UserOut = z.object({ id: z.string(), name: z.string() });

app.post(
  "/users/:id",
  { body: CreateUser, query: UserQuery, headers: AuthHeaders, response: UserOut },
  (_req, ctx) => {
    const id: string = ctx.params.id;
    const name: string = ctx.body.name;
    const age: number = ctx.body.age;
    const verbose: string = ctx.query.verbose;
    const auth: string = ctx.headers.authorization;
    void [id, name, age, verbose, auth];
    // @ts-expect-error - not on the body schema
    ctx.body.email;
    // ctx.json is typed to the response schema input
    // @ts-expect-error - response requires { id, name }
    ctx.json({ id: "1" });
    return ctx.json({ id: "1", name: "ada" });
  },
);

app.get("/plain", (_req, ctx) => {
  // @ts-expect-error - no schema means no ctx.body
  ctx.body;
  return ctx.json("anything"); // untyped json responder is generic
});

// ── Typed client from the route table ───────────────────────────────────────
const api = new Swerver()
  .get("/users/:id", { response: UserOut }, (_r, ctx) => ctx.json({ id: ctx.params.id, name: "x" }))
  .post("/users", { body: CreateUser, response: UserOut }, (_r, ctx) =>
    ctx.json({ id: "1", name: ctx.body.name }),
  )
  .get("/me", { headers: AuthHeaders, response: UserOut }, (_r, ctx) =>
    ctx.json({ id: "1", name: ctx.headers.authorization }),
  );

const client = api.client("http://localhost:8080");

async function clientUse() {
  const r1 = await client.get("/users/:id", { params: { id: "7" } });
  const u1 = await r1.json();
  const name1: string = u1.name; // response typed from UserOut
  void name1;

  const r2 = await client.post("/users", { body: { name: "ada", age: 3 } });
  const u2 = await r2.json();
  const id2: string = u2.id;
  void id2;

  // Header-typed client call
  await client.get("/me", { headers: { authorization: "Bearer x" } });

  // @ts-expect-error - unknown path is not in the route table
  await client.get("/nope");
  // @ts-expect-error - missing required params
  await client.get("/users/:id");
  // @ts-expect-error - body has the wrong shape
  await client.post("/users", { body: { name: 123 } });
  // @ts-expect-error - GET /users was never registered (only POST)
  await client.get("/users");
  // @ts-expect-error - missing required headers
  await client.get("/me");
}
void clientUse;

// ── OpenAPI document ────────────────────────────────────────────────────────
export type OpenApiChecks = [Expect<Equal<ReturnType<typeof api.openapi>, Record<string, unknown>>>];

// ── Mock client (same typing as the network client, in-process) ─────────────
export type RequestCheck = [Expect<Equal<ReturnType<typeof api.request>, Promise<Response>>>];

const mock = api.mockClient();
async function mockUse() {
  const r = await mock.post("/users", { body: { name: "ada", age: 3 } });
  const u = await r.json();
  const id: string = u.id; // typed the same as the network client
  void id;
  // @ts-expect-error - wrong body shape, checked in-process too
  await mock.post("/users", { body: { name: 123 } });
}
void mockUse;
