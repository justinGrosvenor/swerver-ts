// Run: SWERVER_BIN=../swerver/zig-out/bin/swerver bun run examples/hello.ts
// Then: curl localhost:8080/hello/ada

import { Swerver } from "../src/index.ts";

const app = new Swerver({ port: 8080 });

// ctx.params.name is typed as string, inferred from the ":name" in the pattern.
app.get("/hello/:name", (_req, { params }) => Response.json({ hi: params.name }));

app.post("/echo", async (req) => {
  const body = await req.text();
  return new Response(body || "(empty)", { headers: { "content-type": "text/plain" } });
});

// Declare an upstream and proxy a prefix to it. `api` is an unforgeable token;
// app.proxy will not accept a bare string, so upstream names cannot be typo'd.
const api = app.upstream("api", { servers: [{ address: "127.0.0.1", port: 9001 }] });
app.proxy("/api/", api);

await app.start();
console.log("swerverts up on http://localhost:8080  (Ctrl-C to stop)");

process.on("SIGINT", async () => {
  await app.stop();
  process.exit(0);
});
