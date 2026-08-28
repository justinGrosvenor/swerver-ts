# swerverts

Run the [swerver](https://github.com/justingrosvenor/swerver) gateway with
TypeScript route handlers.

swerver is a high-performance HTTP/1.1 + HTTP/2 + HTTP/3 server and API gateway
written in Zig. swerverts lets you keep all of that (TLS, HTTP/2, HTTP/3/QUIC,
static file serving, reverse proxy, rate limiting, auth, x402 payments, WASM
filters) as the front process, and write your dynamic routes in TypeScript.

## How it works

swerver always owns the front-facing socket. Dynamic TypeScript routes can run
through either backend:

- `ffi` embeds `libswerver` in the Bun process and exchanges requests through
  bounded native slots. This is the low-latency, high-throughput path.
- `socket` runs the Bun app on a unix socket and lets swerver proxy to it. This
  is the portable fallback and the better fit for payloads beyond FFI limits.

Static files, native proxy routes, TLS, HTTP/2, HTTP/3, auth, rate limits, x402,
WASM filters, and observability stay on native swerver paths in both modes.

```
client ──▶ swerver (TLS, H2/H3, static, proxy, policy)
              │ matched TypeScript route
              ├── FFI slot ────────────────▶ Bun handler
              └── unix-socket proxy ───────▶ Bun handler
```

## Install

Requires [Bun](https://bun.sh) >= 1.2.

```sh
bun add swerverts
```

swerverts needs the swerver engine: the binary for the socket backend,
`libswerver` for the FFI backend. It locates them in this order:

1. an explicit `binaryPath` / `libraryPath` passed to `new Swerver({ ... })`
2. the `SWERVER_BIN` / `SWERVER_LIB` environment variables
3. a prebuilt `@swerver/<os>-<arch>` package, installed automatically as an
   optionalDependency for the host platform (esbuild/@swc style)

A published prebuilt makes `bun add swerverts` runnable with no extra setup. For
local development against a source checkout, point `SWERVER_BIN` / `SWERVER_LIB`
at the engine's `zig-out/bin` / `zig-out/lib`.

## Usage

```ts
import { Swerver } from "swerverts";

const app = new Swerver({
  port: 8080,
  backend: "ffi",
  staticRoot: "./public", // served by swerver, not TS
});

// params is typed from the pattern: { name: string } here.
// Return a plain value: objects become JSON, strings become text. params is
// typed from the pattern ({ name: string } here).
app.get("/hello/:name", (_req, { params }) => ({ hi: params.name }));

app.post("/echo", async (req) => (await req.text()) || "(empty)");

await app.start();
```

### Responses and errors

A handler can return a value and swerverts builds the response: objects and
arrays become JSON, strings become `text/plain`, `undefined` is `204`, and a
`Response` (or `ctx.json(...)` / `ctx.text(...)`) is used as-is when you need to
set a status or headers. When a route declares a `response` schema, the returned
value is type-checked against it and validated at runtime.

For a controlled error status, throw or return an `HttpError` via `error()`. Its
body is JSON for objects and text for strings, and it skips the error handler.

```ts
import { Swerver, error } from "swerverts";

const app = new Swerver().get("/users/:id", (_req, { params }) => {
  const user = db.get(params.id);
  if (!user) throw error(404, "user not found");
  return user; // -> 200 application/json
});
```

### Middleware and response helpers

Global and per-route middleware use onion ordering. The context includes
`json`, `text`, `html`, `redirect`, `header`, `cookie`, and shared `state`
helpers. Custom error, not-found, and method-not-allowed handlers use the same
context.

```ts
const app = new Swerver({ state: { service: "users" } })
  .use(async (_request, ctx, next) => {
    const response = await next();
    ctx.header("x-service", String(ctx.state.service));
    return response;
  })
  .onError((error, _request, ctx) => ctx.json({ error: String(error) }, 500))
  .get("/hello", { middleware: [auth] }, (_request, ctx) => {
    ctx.cookie("session", "abc", { httpOnly: true, secure: true });
    return ctx.text("hello");
  });
```

### Typed route params

Param names are read out of the pattern literal at compile time, so
`ctx.params` has exactly the keys the route declares. A wrong key is a type
error, not a runtime `undefined`:

```ts
app.get("/users/:id/posts/:postId", (_req, { params }) => {
  params.id;      // string
  params.postId;  // string
  params.nope;    // compile error
  return new Response("ok");
});

app.get("/files/*", (_req, { params }) => new Response(params.rest));
```

`route()` matches any method; the verb registrars constrain it,
and a path that matches with the wrong method returns `405` with an `Allow`
header.

### Typed, validated inputs and outputs

Pass a config object before the handler on `route`/`post`/`put`/`patch` (and
`get`/`delete`). Every field is any [Standard Schema](https://standardschema.dev)
(Zod, Valibot, ArkType, ...), so there is no library lock-in:

- `body` - JSON body, parsed and validated; `ctx.body` is its output type
- `query` - URL query params; `ctx.query` is its output type
- `headers` - request headers (lower-cased); `ctx.headers` is its output type
- `response` - types `ctx.json(...)` so you cannot return the wrong shape
- `responses` - maps status codes to distinct response schemas

```ts
import { z } from "zod";

const CreateUser = z.object({ name: z.string(), age: z.number().int().min(0) });
const UserOut = z.object({ id: z.string(), name: z.string() });

app.post(
  "/users/:id",
  { body: CreateUser, query: z.object({ dry: z.string() }), response: UserOut },
  (_req, ctx) => {
    ctx.params.id;   // string   (from the pattern)
    ctx.body.name;   // string   (from body schema)
    ctx.query.dry;   // string   (from query schema)
    return ctx.json({ id: ctx.params.id, name: ctx.body.name }); // checked against UserOut
  },
);
```

An invalid body/query/headers returns `422` with the failing issues; a non-JSON
body returns `400`:

```json
{ "error": "validation failed", "issues": [ { "message": "...", "path": "age" } ] }
```

For multi-status routes, the status and payload are checked together:

```ts
app.get(
  "/users/:id",
  { responses: { 200: UserOut, 404: ErrorOut } },
  (_request, ctx) =>
    ctx.params.id === "missing"
      ? ctx.json({ error: "not found" }, 404)
      : ctx.json({ id: ctx.params.id, name: "Ada" }, 200),
);
```

### Typed client

`app.client(baseUrl?)` returns a fetch client generated from the routes you
registered. It knows every path, its params, its body, and its response type.
Chain the route calls so the route table accumulates on the app's type:

```ts
const api = new Swerver({ port: 8080 })
  .get("/users/:id", { response: UserOut }, (_r, ctx) => ctx.json({ id: ctx.params.id, name: "ada" }))
  .post("/users", { body: CreateUser, response: UserOut }, (_r, ctx) => ctx.json({ id: "1", name: ctx.body.name }));

const client = api.client("http://localhost:8080");

const res = await client.post("/users", { body: { name: "grace", age: 30 } });
const user = await res.json(); // typed: { id: string; name: string }

client.get("/users/:id", { params: { id: "7" } });          // params required and typed
client.get("/me", { headers: { authorization: "Bearer x" } }); // headers required and typed
client.get("/nope");                                        // compile error: unknown route
client.post("/users", { body: { name: 12 } });              // compile error: wrong body
```

The call args (`params`, `body`, `query`, `headers`) are each required only when
the route declares them, and typed from its schemas.

### OpenAPI

`app.openapi(options?)` builds an OpenAPI 3.1 document from the registered
routes. Path params come from the pattern; request/response bodies and
query/header params come from the route schemas. Because there is no standard
Schema-to-JSON-Schema conversion, pass your library's converter as
`toJsonSchema` (Zod v4 ships `z.toJSONSchema`); without it the structure is
still emitted with open body schemas.

```ts
import { z } from "zod";

const doc = app.openapi({
  info: { title: "Users API", version: "1.0.0" },
  servers: [{ url: "http://localhost:8080" }],
  toJsonSchema: (schema) => z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>,
});
// doc.paths["/users/{id}"].get.parameters -> [{ name: "id", in: "path", ... }]
// doc.paths["/users"].post.responses -> { "200": ..., "400": ..., "422": ... }
```

### Interactive docs

`app.docs(options?)` serves live API docs: a Swagger UI page at `path`
(default `/docs`) and the OpenAPI document at `openapiPath` (default
`/openapi.json`). Both are excluded from the document itself. It takes the same
options as `openapi()`.

```ts
import { z } from "zod";

app.docs({
  info: { title: "Users API", version: "1.0.0" },
  toJsonSchema: (schema) => z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>,
});
// GET /docs         -> Swagger UI
// GET /openapi.json -> the spec
```

### Testing without a server

`app.request(input, init?)` dispatches one request against the registered
routes in-process, with no swerver spawned and no network. `app.mockClient()`
returns the same typed client as `client()` but backed by in-process dispatch.
Both run the full pipeline (matching, body/query/header validation, and
response validation). Ideal for fast unit tests:

```ts
const app = build();

const res = await app.request("/users/9");
expect(res.status).toBe(200);

const mock = app.mockClient();
const user = await (await mock.post("/users", { body: { name: "ada", age: 3 } })).json();
// user is typed { id: string; name: string }
```

Response validation defaults to on in `request`/`mockClient`, so a handler that
breaks its response contract fails your test with a 500.

### Response validation in development

Set `validateResponses: true` to validate every `ctx.json(...)` against the
route's `response` schema and return `500` on a mismatch (with the issues
logged). It catches handlers that violate their own declared contract. Leave it
off in production; the typed `ctx.json` already gives you compile-time safety.

```ts
const app = new Swerver({ port: 8080, validateResponses: true });
```

### Strict TypeScript

The package is written for the strict end of TypeScript and typechecks clean
under `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noUnusedLocals/Parameters`, and
`noPropertyAccessFromIndexSignature`. `test/types.test-d.ts` holds compile-only
assertions (including `@ts-expect-error` for every rejection above); run them
with `bun run typecheck`.

### Typed upstreams

`upstream()` returns an unforgeable reference. `proxy()` accepts only that
reference, so a route can never point at an upstream you did not declare (a
typo is a compile error instead of a runtime 502):

```ts
const bedrock = app.upstream("bedrock", {
  servers: [{ address: "bedrock-runtime.us-east-1.amazonaws.com", port: 443 }],
  tls: true,
});

app.proxy("/models/", bedrock);   // ok
app.proxy("/models/", "bedrock"); // compile error: not an UpstreamRef
```

Handlers use the standard `Request`/`Response` API, so a whole framework can be
mounted on a prefix:

```ts
import { Hono } from "hono";
const api = new Hono();
api.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));

app.route("/api/*", (req) => api.fetch(req));
```

### Route patterns

- `/health` exact
- `/users/:id` named param, available as `ctx.params.id`
- `/files/*` trailing wildcard, available as `ctx.params.rest`

`HEAD` and `OPTIONS` have first-class registrars and typed-client methods.
`HEAD` automatically falls back to `GET`; `Allow` includes `HEAD` whenever a
`GET` route exists. Prefix groups can accumulate into the typed client:

```ts
const api = new Swerver().group("/api", (group) =>
  group.get("/users/:id", handler).post("/users", createHandler),
);

api.client().get("/api/users/:id", { params: { id: "7" } });
```

Each pattern's static leading prefix is registered with swerver. Matching
requests enter either the FFI bridge or the Bun unix-socket upstream; the TS
router then performs fine-grained method and parameter matching.

### Full gateway config

The parsed swerver schema is typed directly: listeners, TLS, HTTP/2, QUIC,
timeouts, limits, buffer pools, admin, OTEL, global x402, Postgres, WASM/Nether,
upstream discovery and pools, auth, cache, retries, traffic splitting,
mirroring, route x402, and tenant routing. `raw` remains an escape hatch for a
new native field that lands before this package updates.

```ts
const app = new Swerver({
  port: 8443,
  tls: { cert_path: "./cert.pem", key_path: "./key.pem" },
  quic: { enabled: true, cert_path: "./cert.pem", key_path: "./key.pem" },
  bufferPool: { buffer_count: 8192 },
  otel: { enabled: true, collector_url: "https://otel.example/v1/traces" },
});

const bedrock = app.upstream("bedrock", {
  servers: [{ address: "bedrock-runtime.us-east-1.amazonaws.com", port: 443 }],
  tls: true,
  health_check: { path: "/health", interval_ms: 5000 },
});
app.proxy("/models/", bedrock, {
  rate_limit: { requests_per_second: 50, burst_size: 100 },
  retry: { max_retries: 2 },
});

app.tenant("/tenants/", {
  socket_dir: "/run/nether/tenants",
  header: "x-tenant-id",
});
```

`raw` upstreams and routes are concatenated with the generated app upstream and
routes, so static proxying and dynamic TS handlers coexist.

## Performance snapshot

Current local HTTP/1.1 development results (requests/second; per-core figure
after the dot) put the FFI backend ahead of Express and Fastify in each shown
scenario. These are tuning snapshots, not portable guarantees; rerun on the
target host and workload.

| scenario | Express | Fastify | Bun | swerverts FFI |
| --- | ---: | ---: | ---: | ---: |
| pipeline | 70,976 · 67k/core | 86,004 · 83k/core | 231,352 · 229k/core | 101,535 · 85k/core |
| baseline | 66,810 · 66k/core | 83,633 · 83k/core | 198,052 · 196k/core | 90,440 · 74k/core |
| JSON | 47,026 · 41k/core | 62,659 · 61k/core | 112,166 · 111k/core | 59,105 · 47k/core |
| static | 32,728 · 15k/core | 27,325 · 14k/core | 55,398 · 54k/core | 42,321 · 36k/core |

The FFI JSON helper serializes directly into the native response slot. The
content-type-only path stays minimal, while arbitrary request/response headers
and repeated `Set-Cookie` values use the full ABI path.

## API

### `new Swerver(options)`

| option | default | meaning |
| --- | --- | --- |
| `port` | `8080` | front-facing listen port |
| `address` | swerver default | front bind address |
| `workers` | `1` | swerver worker processes |
| `staticRoot` | none | directory served as static files |
| `backend` | `socket` | `socket` or in-process `ffi` |
| `libraryPath` | resolved | explicit `libswerver` path for FFI |
| `state` | `{}` | mutable state exposed as `ctx.state` |
| `raw` | none | extra config merged over the generated one |
| `binaryPath` | resolved | explicit path to the swerver binary |
| `readyTimeoutMs` | `5000` | how long `start()` waits for the port |
| `validateResponses` | `false` | validate `ctx.json` against the response schema, 500 on mismatch |

### `app.route(pattern, handler)` and verb methods

Register a dynamic route. `handler` is `(req: Request, ctx: { params }) =>
Response | Promise<Response>`, and `ctx.params` is typed from the pattern.
`route` matches any method; `get/post/put/patch/delete/head/options` constrain
it. Pass `{ body: schema }` before the handler on any registrar to
validate the JSON body and get a typed `ctx.body`.

### `app.upstream(name, def)` / `app.proxy(...)` / `app.tenant(...)`

Declare a swerver upstream and proxy a path prefix to it. `upstream` returns an
`UpstreamRef` that `proxy` requires, so upstream references are checked at
compile time. `def` is an upstream minus its `name` (servers, `tls`, ...).
`tenant` creates a Nether tenant-as-upstream route without a static upstream.

### `app.client(baseUrl?)` / `app.openapi(options?)` / `app.docs(options?)`

`client` returns a typed fetch client for the registered routes (chain the
route calls so the table accumulates). `openapi` returns an OpenAPI 3.1
document; pass `toJsonSchema` to convert your schemas. `docs` serves Swagger UI
plus the spec.

### `app.request(input, init?)` / `app.mockClient()`

Exercise handlers in-process without spawning swerver. `request` dispatches a
single request; `mockClient` returns the same typed client as `client()`,
backed by in-process dispatch. Both for tests.

### `app.start()` returns a `RunningSwerver`

`start()` validates the config, starts the selected backend, and resolves once
the front port accepts connections. It returns a running handle:

```ts
const server = await app.start();
server.port; // number
server.url;  // "http://localhost:8080"
await server.stop();
```

The handle has no `route`/`upstream`/`proxy` methods, so adding routes after
start is a compile error, not just a runtime throw. The swerver child is reaped
automatically if the process exits without `stop()`. A `Swerver` instance is
one-shot; create a new instance after stopping instead of restarting it.

For FFI, `stop()` first closes host-route admission, drains every admitted JS
handler and native slot, then tears down the reactor and bridge storage. New
host-route requests receive `503` during that drain rather than being stranded.

### Backend limits

The FFI backend uses 256 bounded request slots, a 32 KiB request-body slot, and
40 KiB request/response header blocks. Response capacity is bounded by both the
128 KiB native slot and the configured native buffer's safe single-copy size
(about 63.5 KiB with defaults). Oversize requests fail with `413`; oversize
responses fail closed with `500`. Use the socket backend for larger bodies or
when process isolation matters. The FFI backend embeds one native
server/reactor per process.

### Config validation

`start()` runs `validateConfig()` before spawning swerver and throws a
`ConfigError` (listing every problem) if the config is invalid: bad ports,
certificate mismatches, invalid Postgres/WASM pool sizes, duplicate upstreams,
illegal tenant combinations, `tls` on a unix-socket server, or undeclared
primary/split/mirror upstreams. Nothing is
spawned when validation fails. `validateConfig` is also exported for use in
tests or CI; it returns a `ValidatedConfig`, the only type the spawn path
accepts.

## License

MIT
