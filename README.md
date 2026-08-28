# swerverts

Run the [swerver](https://github.com/justingrosvenor/swerver) gateway with
TypeScript route handlers.

swerver is a high-performance HTTP/1.1 + HTTP/2 + HTTP/3 server and API gateway
written in Zig. swerverts lets you keep all of that (TLS, HTTP/2, HTTP/3/QUIC,
static file serving, reverse proxy, rate limiting, auth, x402 payments, WASM
filters) as the front process, and write your dynamic routes in TypeScript.

## How it works

swerver runs as the front-facing server. Your TypeScript handlers run in a Bun
HTTP server on a unix socket, and swerver proxies to it as an ordinary
upstream. Only the routes you declare in TS pay the crossing; static files,
proxied routes, and every gateway feature stay on swerver's own paths.

```
client ──▶ swerver (Bun-free hot paths: TLS, H2, H3, static, proxy)
              │ matched dynamic route
              ▼
           Bun app server on a unix socket ──▶ your handler
```

## Install

Requires [Bun](https://bun.sh) >= 1.2 and the swerver binary. Point swerverts
at the binary with `SWERVER_BIN`, or install a `@swerver/<platform>` package,
or put `swerver` on your `PATH`.

```sh
bun add swerverts
```

## Usage

```ts
import { Swerver } from "swerverts";

const app = new Swerver({
  port: 8080,
  staticRoot: "./public", // served by swerver, not TS
});

// params is typed from the pattern: { name: string } here.
app.get("/hello/:name", (_req, { params }) =>
  Response.json({ hi: params.name }),
);

app.post("/echo", async (req) => {
  const body = await req.text();
  return new Response(body, { headers: { "content-type": "text/plain" } });
});

await app.start();
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

`route()` matches any method; `get`/`post`/`put`/`patch`/`delete` constrain it,
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
  toJsonSchema: (schema) => z.toJSONSchema(schema),
});
// doc.paths["/users/{id}"].get.parameters -> [{ name: "id", in: "path", ... }]
// doc.paths["/users"].post.responses -> { "200": ..., "400": ..., "422": ... }
```

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

Each pattern's static leading prefix is registered with swerver as a proxy
route; swerver forwards matching requests to the app server, which does the
fine-grained matching.

### Full gateway config

Anything swerverts does not model is passed straight through with `raw`, using
swerver's [JSON config schema](https://github.com/justingrosvenor/swerver/blob/main/docs/reference/config-schema.md):

```ts
const app = new Swerver({
  port: 8443,
  raw: {
    server: { tls: { cert: "./cert.pem", key: "./key.pem" }, http3: true },
    upstreams: [
      { name: "bedrock", servers: [{ address: "bedrock-runtime.us-east-1.amazonaws.com", port: 443 }], tls: true },
    ],
    routes: [
      { path_prefix: "/models/", upstream: "bedrock", rate_limit: { rps: 50 } },
    ],
  },
});
```

`raw` upstreams and routes are concatenated with the generated app upstream and
routes, so static proxying and dynamic TS handlers coexist.

## API

### `new Swerver(options)`

| option | default | meaning |
| --- | --- | --- |
| `port` | `8080` | front-facing listen port |
| `address` | swerver default | front bind address |
| `workers` | `1` | swerver worker processes |
| `staticRoot` | none | directory served as static files |
| `raw` | none | extra config merged over the generated one |
| `binaryPath` | resolved | explicit path to the swerver binary |
| `readyTimeoutMs` | `5000` | how long `start()` waits for the port |
| `validateResponses` | `false` | validate `ctx.json` against the response schema, 500 on mismatch |

### `app.route(pattern, handler)` and `app.get/post/put/patch/delete`

Register a dynamic route. `handler` is `(req: Request, ctx: { params }) =>
Response | Promise<Response>`, and `ctx.params` is typed from the pattern.
`route` matches any method; the verb methods constrain it. Pass
`{ body: schema }` before the handler on `route`/`post`/`put`/`patch` to
validate the JSON body and get a typed `ctx.body`.

### `app.upstream(name, def)` / `app.proxy(prefix, ref, opts?)`

Declare a swerver upstream and proxy a path prefix to it. `upstream` returns an
`UpstreamRef` that `proxy` requires, so upstream references are checked at
compile time. `def` is an upstream minus its `name` (servers, `tls`, ...).

### `app.client(baseUrl?)` / `app.openapi(options?)`

`client` returns a typed fetch client for the registered routes (chain the
route calls so the table accumulates). `openapi` returns an OpenAPI 3.1
document; pass `toJsonSchema` to convert your schemas.

### `app.start()` returns a `RunningSwerver`

`start()` validates the config, launches the app server, spawns swerver, and
resolves once the front port accepts connections. It returns a running handle:

```ts
const server = await app.start();
server.port; // number
server.url;  // "http://localhost:8080"
await server.stop();
```

The handle has no `route`/`upstream`/`proxy` methods, so adding routes after
start is a compile error, not just a runtime throw. The swerver child is reaped
automatically if the process exits without `stop()`.

### Config validation

`start()` runs `validateConfig()` before spawning swerver and throws a
`ConfigError` (listing every problem) if the config is invalid: a bad port, an
upstream with no servers, a duplicate upstream name, `tls` on a unix-socket
server, or a route that references an upstream you never declared. Nothing is
spawned when validation fails. `validateConfig` is also exported for use in
tests or CI; it returns a `ValidatedConfig`, the only type the spawn path
accepts.

## License

MIT
