// A typed fetch client generated from a Swerver app's route table. The route
// table `R` maps "METHOD /pattern" to the params, body, query, and response
// types of that route; the client turns those into typed call signatures.
//
// Everything here is types plus a small fetch wrapper. `client.post("/users/
// :id", { params: { id }, body })` fills the pattern, serializes the body, and
// returns a Response whose `.json()` is typed to the route's response.

import type { RouteEntry, RouteTable } from "./index.ts";

// All patterns registered for method M, e.g. PathsOf<R, "GET">.
type PathsOf<R extends RouteTable, M extends string> = {
  [K in keyof R]: K extends `${M} ${infer P}` ? P : never;
}[keyof R];

// The entry for one method+pattern, or never if unregistered.
type Lookup<R extends RouteTable, M extends string, P extends string> = `${M} ${P}` extends keyof R
  ? R[`${M} ${P}`]
  : never;

// Only the argument groups a route actually needs (params/body/query/headers),
// each omitted when empty/undefined.
type CallArgs<E extends RouteEntry> = ([keyof E["params"]] extends [never]
  ? {}
  : { params: E["params"] }) &
  ([E["body"]] extends [undefined] ? {} : { body: E["body"] }) &
  ([E["query"]] extends [undefined] ? {} : { query: E["query"] }) &
  ([E["headers"]] extends [undefined] ? {} : { headers: E["headers"] });

type HasKeys<T> = [keyof T] extends [never] ? false : true;

/** A Response whose `json()` is typed to the route's declared response. */
export interface ClientResponse<T> extends Response {
  json(): Promise<T>;
}

// One verb method on the client. `args` is required only when the route needs
// params, a body, or a query; otherwise it may be omitted.
type Verb<R extends RouteTable, M extends string> = <P extends PathsOf<R, M> & string>(
  path: P,
  ...rest: HasKeys<CallArgs<Lookup<R, M, P>>> extends true
    ? [args: CallArgs<Lookup<R, M, P>>]
    : [args?: Record<string, never>]
) => Promise<ClientResponse<Lookup<R, M, P>["response"]>>;

export interface Client<R extends RouteTable> {
  get: Verb<R, "GET">;
  post: Verb<R, "POST">;
  put: Verb<R, "PUT">;
  patch: Verb<R, "PATCH">;
  delete: Verb<R, "DELETE">;
}

interface RuntimeArgs {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}

function fillPath(pattern: string, params: Record<string, string> | undefined): string {
  if (!params) return pattern;
  let out = pattern;
  for (const [key, value] of Object.entries(params)) {
    const encoded = encodeURIComponent(value);
    out = key === "rest" ? out.replace("*", encoded) : out.replace(`:${key}`, encoded);
  }
  return out;
}

function makeVerb(baseUrl: string, method: string) {
  return async (path: string, args: RuntimeArgs = {}): Promise<Response> => {
    let url = baseUrl + fillPath(path, args.params);
    if (args.query) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(args.query)) {
        if (value !== undefined) qs.set(key, String(value));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const headers: Record<string, string> = { ...args.headers };
    const init: RequestInit = { method };
    if (args.body !== undefined) {
      init.body = JSON.stringify(args.body);
      headers["content-type"] = "application/json";
    }
    if (Object.keys(headers).length > 0) init.headers = headers;
    return fetch(url, init);
  };
}

export function createClient<R extends RouteTable>(baseUrl: string): Client<R> {
  const base = baseUrl.replace(/\/$/, "");
  return {
    get: makeVerb(base, "GET"),
    post: makeVerb(base, "POST"),
    put: makeVerb(base, "PUT"),
    patch: makeVerb(base, "PATCH"),
    delete: makeVerb(base, "DELETE"),
  } as unknown as Client<R>;
}
