// Typed view of the subset of swerver's JSON config that swerverts emits, plus
// the generator that turns a Swerver app into a config the binary accepts.
//
// The full schema lives in the swerver repo (docs/reference/config-schema.md).
// Anything not modelled here can be passed through verbatim via `raw`.

import { brandValue, type Brand } from "./brand.ts";

// An unforgeable reference to a declared upstream. Only `app.upstream(...)`
// can mint one (it brands the name), so a route can only target an upstream
// that was actually declared: a typo becomes a compile error, not a 502.
export type UpstreamRef = Brand<string, "swerver.upstream">;

// A config that has passed validateConfig(). The spawn path accepts only this
// branded type, so an unvalidated config cannot reach swerver by construction.
export type ValidatedConfig = Brand<SwerverConfig, "swerver.validated">;

export interface ServerAddress {
  address: string;
  port: number;
  weight?: number;
}

export interface UnixServer {
  unix: string;
  weight?: number;
}

export interface Upstream {
  name: string;
  servers: (ServerAddress | UnixServer)[];
  tls?: boolean;
  tls_verify?: boolean;
  tls_sni?: string;
}

export interface Route {
  path_prefix: string;
  upstream?: string;
  host?: string;
  rewrite_pattern?: string;
  rewrite_replacement?: string;
  [key: string]: unknown;
}

export interface SwerverConfig {
  server: {
    port: number;
    address?: string;
    workers?: number;
    static_root?: string;
    [key: string]: unknown;
  };
  upstreams?: Upstream[];
  routes?: Route[];
  [key: string]: unknown;
}

export const APP_UPSTREAM = "__swerverts_app";

export interface GenerateInput {
  port: number;
  address?: string | undefined;
  workers?: number | undefined;
  staticRoot?: string | undefined;
  appSocket: string;
  // Distinct swerver path prefixes derived from the app's dynamic routes.
  appPrefixes: string[];
  // Upstreams and routes declared through the typed builder (app.upstream /
  // app.proxy). Concatenated with the generated app upstream and the raw ones.
  upstreams?: Upstream[] | undefined;
  routes?: Route[] | undefined;
  // Merged over the generated config; wins on conflicts. Use for tls, and
  // anything else swerverts does not model.
  raw?: Partial<SwerverConfig> | undefined;
}

export function generateConfig(input: GenerateInput): SwerverConfig {
  const config: SwerverConfig = {
    server: {
      port: input.port,
      ...(input.address ? { address: input.address } : {}),
      ...(input.workers ? { workers: input.workers } : {}),
      ...(input.staticRoot ? { static_root: input.staticRoot } : {}),
    },
    upstreams: [],
    routes: [],
  };

  if (input.appPrefixes.length > 0) {
    config.upstreams!.push({
      name: APP_UPSTREAM,
      servers: [{ unix: input.appSocket }],
    });
    for (const prefix of input.appPrefixes) {
      config.routes!.push({ path_prefix: prefix, upstream: APP_UPSTREAM });
    }
  }

  if (input.upstreams) config.upstreams!.push(...input.upstreams);
  if (input.routes) config.routes!.push(...input.routes);

  if (input.raw) {
    const raw = input.raw;
    return {
      ...config,
      ...raw,
      server: { ...config.server, ...(raw.server ?? {}) },
      upstreams: [...(config.upstreams ?? []), ...(raw.upstreams ?? [])],
      routes: [...(config.routes ?? []), ...(raw.routes ?? [])],
    };
  }
  return config;
}

/** Raised by validateConfig with every problem found, not just the first. */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid swerver config:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

function isUnixServer(s: ServerAddress | UnixServer): s is UnixServer {
  return "unix" in s;
}

/**
 * Check the invariants swerver would reject (or silently 502 on) before we
 * spawn it, and brand the config as validated. This is the only place a
 * `ValidatedConfig` is produced, so the spawn path can require one.
 */
export function validateConfig(config: SwerverConfig): ValidatedConfig {
  const problems: string[] = [];

  const port = config.server?.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`server.port must be an integer in 1..65535 (got ${port})`);
  }

  const upstreams = config.upstreams ?? [];
  const names = new Set<string>();
  for (const up of upstreams) {
    if (!up.name) {
      problems.push("an upstream is missing a name");
      continue;
    }
    if (names.has(up.name)) problems.push(`duplicate upstream name '${up.name}'`);
    names.add(up.name);
    if (!up.servers || up.servers.length === 0) {
      problems.push(`upstream '${up.name}' has no servers`);
    }
    if (up.tls && (up.servers ?? []).some(isUnixServer)) {
      problems.push(`upstream '${up.name}': tls is not supported on a unix-socket server`);
    }
    if (up.tls_sni && /[\x00-\x1f\x7f\r\n]/.test(up.tls_sni)) {
      problems.push(`upstream '${up.name}': tls_sni contains control characters`);
    }
  }

  for (const route of config.routes ?? []) {
    if (!route.path_prefix || !route.path_prefix.startsWith("/")) {
      problems.push(`route path_prefix must start with '/' (got '${route.path_prefix}')`);
    }
    if (route.upstream && !names.has(route.upstream)) {
      problems.push(
        `route '${route.path_prefix}' references undeclared upstream '${route.upstream}'`,
      );
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return brandValue(config);
}
