// Run: SWERVER_BIN=../swerver/zig-out/bin/swerver bun run examples/hello.ts
// Then: curl localhost:8080/hello/ada

import { Swerver } from "../src/index.ts";

const app = new Swerver({ port: 8080 });

app.route("/hello/:name", (_req, { params }) =>
  Response.json({ hi: params.name }),
);

app.route("/echo", async (req) => {
  const body = await req.text();
  return new Response(body || "(empty)", {
    headers: { "content-type": "text/plain" },
  });
});

await app.start();
console.log("swerverts up on http://localhost:8080  (Ctrl-C to stop)");

process.on("SIGINT", async () => {
  await app.stop();
  process.exit(0);
});
