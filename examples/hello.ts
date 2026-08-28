// Run: SWERVER_BIN=../swerver/zig-out/bin/swerver bun run examples/hello.ts
// Then: curl localhost:8080/hello/ada

import { z } from "zod";
import { Swerver } from "../src/index.ts";

const app = new Swerver({ port: 8080 });

// ctx.params.name is typed as string, inferred from the ":name" in the pattern.
app.get("/hello/:name", (_req, { params }) => Response.json({ hi: params.name }));

app.post("/echo", async (req) => {
  const body = await req.text();
  return new Response(body || "(empty)", { headers: { "content-type": "text/plain" } });
});

// Validated body + typed response: ctx.body is typed from the schema, an
// invalid body -> 422, and ctx.json is checked against the response schema.
const CreateUser = z.object({ name: z.string(), age: z.number().int().min(0) });
const UserOut = z.object({ id: z.string(), name: z.string(), age: z.number() });
app.post("/users/:id", { body: CreateUser, response: UserOut }, (_req, ctx) =>
  ctx.json({ id: ctx.params.id, name: ctx.body.name, age: ctx.body.age }),
);

// Declare an upstream and proxy a prefix to it. `api` is an unforgeable token;
// app.proxy will not accept a bare string, so upstream names cannot be typo'd.
const api = app.upstream("api", { servers: [{ address: "127.0.0.1", port: 9001 }] });
app.proxy("/api/", api);

const server = await app.start();
console.log(`swerverts up on ${server.url}  (Ctrl-C to stop)`);

process.on("SIGINT", async () => {
  await server.stop();
  process.exit(0);
});
