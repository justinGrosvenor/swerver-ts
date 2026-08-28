// A tiny path matcher shared by the request dispatcher and the config
// generator. Patterns support ":param" segments and a trailing "*" wildcard,
// e.g. "/users/:id", "/files/*". Matching is longest-literal-prefix first so
// more specific routes win.

// ── Type-level param extraction ────────────────────────────────────────────
// Turn a pattern string literal into the exact shape of its params object:
//   "/users/:id"                 -> { id: string }
//   "/users/:id/posts/:postId"   -> { id: string; postId: string }
//   "/files/*"                   -> { rest: string }
//   "/health"                    -> {}
// A ":name" segment contributes a key; a "*" contributes "rest". This is all
// phantom typing, erased at runtime; the values still come from `match()`.

type ColonNames<P extends string> = P extends `${string}:${infer Tail}`
  ? Tail extends `${infer Name}/${infer Rest}`
    ? Name | ColonNames<`/${Rest}`>
    : Tail
  : never;

type WildName<P extends string> = P extends `${string}*${string}` ? "rest" : never;

export type ParamNames<P extends string> = ColonNames<P> | WildName<P>;

export type ParamsOf<P extends string> = { [K in ParamNames<P>]: string };

/** Runtime params are a plain string map; the typed view narrows the keys. */
export type Params = Record<string, string>;

import type { StandardSchemaV1 } from "./schema.ts";

export interface CompiledRoute<H> {
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: H;
  // Optional HTTP method constraint (set by app.get/post/...). Undefined means
  // the route matches any method.
  method?: string;
  // Optional request-body schema; when present the dispatcher validates the
  // JSON body before calling the handler.
  schema?: StandardSchemaV1;
  // The static leading path, up to the first ":" or "*". This is what swerver
  // matches on as a route path_prefix.
  prefix: string;
}

function literalPrefix(pattern: string): string {
  const stop = pattern.search(/[:*]/);
  if (stop === -1) return pattern;
  // Trim back to the last "/" so we key on whole segments.
  const head = pattern.slice(0, stop);
  const slash = head.lastIndexOf("/");
  return slash <= 0 ? "/" : head.slice(0, slash + 1);
}

export function compile<H>(
  pattern: string,
  handler: H,
  method?: string,
  schema?: StandardSchemaV1,
): CompiledRoute<H> {
  const paramNames: string[] = [];
  const source = pattern
    .split("/")
    .map((seg) => {
      if (seg === "*") return "(?<rest>.*)";
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return {
    pattern,
    regex: new RegExp(`^${source}/?$`),
    paramNames,
    handler,
    method,
    schema,
    prefix: literalPrefix(pattern),
  };
}

export function sortBySpecificity<H>(routes: CompiledRoute<H>[]): CompiledRoute<H>[] {
  // Longer literal prefixes and fewer params are more specific.
  return [...routes].sort((a, b) => {
    if (b.prefix.length !== a.prefix.length) return b.prefix.length - a.prefix.length;
    return a.paramNames.length - b.paramNames.length;
  });
}

export type MatchResult<H> =
  | { kind: "ok"; route: CompiledRoute<H>; params: Params }
  | { kind: "method"; allowed: string[] } // path matched, method did not -> 405
  | { kind: "none" };

export function match<H>(routes: CompiledRoute<H>[], path: string, method: string): MatchResult<H> {
  const methodMismatch = new Set<string>();
  for (const route of routes) {
    const m = route.regex.exec(path);
    if (!m) continue;
    if (route.method && route.method !== method) {
      methodMismatch.add(route.method);
      continue;
    }
    const params: Params = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1] ?? "");
    });
    if (m.groups?.rest !== undefined) params.rest = m.groups.rest;
    return { kind: "ok", route, params };
  }
  if (methodMismatch.size > 0) return { kind: "method", allowed: [...methodMismatch] };
  return { kind: "none" };
}
