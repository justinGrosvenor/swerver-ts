// A tiny path matcher shared by the request dispatcher and the config
// generator. Patterns support ":param" segments and a trailing "*" wildcard,
// e.g. "/users/:id", "/files/*". Matching is longest-literal-prefix first so
// more specific routes win.

export type Params = Record<string, string>;

export interface CompiledRoute<H> {
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: H;
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

export function compile<H>(pattern: string, handler: H): CompiledRoute<H> {
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

export function match<H>(
  routes: CompiledRoute<H>[],
  path: string,
): { route: CompiledRoute<H>; params: Params } | null {
  for (const route of routes) {
    const m = route.regex.exec(path);
    if (!m) continue;
    const params: Params = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1] ?? "");
    });
    if (m.groups?.rest !== undefined) params.rest = m.groups.rest;
    return { route, params };
  }
  return null;
}
