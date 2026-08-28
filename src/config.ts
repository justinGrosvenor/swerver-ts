// Typed view of the subset of swerver's JSON config that swerverts emits, plus
// the generator that turns a Swerver app into a config the binary accepts.
//
// The full schema lives in the swerver repo (docs/reference/config-schema.md).
// Anything not modelled here can be passed through verbatim via `raw`.

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
  address?: string;
  workers?: number;
  staticRoot?: string;
  appSocket: string;
  // Distinct swerver path prefixes derived from the app's dynamic routes.
  appPrefixes: string[];
  // Merged over the generated config; wins on conflicts. Use for upstreams,
  // routes, tls, rate limits, and anything else swerverts does not model.
  raw?: Partial<SwerverConfig>;
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
