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
  max_fails?: number;
  fail_timeout_ms?: number;
  backup?: boolean;
}

export interface UnixServer {
  unix: string;
  weight?: number;
  max_fails?: number;
  fail_timeout_ms?: number;
  backup?: boolean;
}

export type LoadBalancer = "round_robin" | "least_conn" | "ip_hash" | "random" | "weighted_round_robin";

export interface HealthCheck {
  interval_ms?: number;
  timeout_ms?: number;
  path?: string;
  expected_status?: number;
  expected_body?: string;
  healthy_threshold?: number;
  unhealthy_threshold?: number;
}

export interface ConnectionPool {
  max_connections?: number;
  max_idle?: number;
  idle_timeout_ms?: number;
  connect_timeout_ms?: number;
}

export interface DnsDiscovery {
  hostname: string;
  port?: number;
  interval_s?: number;
}

export interface ConsulDiscovery {
  service: string;
  address?: string;
  port?: number;
  interval_s?: number;
  token?: string;
}

export interface Upstream {
  name: string;
  servers: (ServerAddress | UnixServer)[];
  load_balancer?: LoadBalancer;
  health_check?: HealthCheck;
  connection_pool?: ConnectionPool;
  dns_discovery?: DnsDiscovery;
  consul_discovery?: ConsulDiscovery;
  allow_private?: boolean;
  tls?: boolean;
  tls_verify?: boolean;
  tls_sni?: string;
}

export interface ApiKeyAuth {
  type: "api_key";
  keys: Array<{ key?: string; key_hash?: string; name: string }>;
  header_name?: string;
  query_param?: string;
}

export interface JwtAuth {
  type: "jwt";
  secret: string;
  issuer?: string;
  audience?: string;
  claims_to_headers?: Array<{ claim: string; header: string }>;
}

export interface ForwardAuth {
  type: "forward_auth";
  url: string;
  headers_forward?: string[];
  headers_upstream?: string[];
  timeout_ms?: number;
}

export interface AnonymousAuth {
  type: "anonymous";
  subject?: string;
}

export interface AuthChain {
  type: "chain";
  methods: AuthConfig[];
}

export type AuthConfig = ApiKeyAuth | JwtAuth | ForwardAuth | AnonymousAuth | AuthChain;

export interface RateLimitConfig {
  requests_per_second?: number;
  burst_size?: number;
  key?: "ip" | "consumer";
}

export interface CacheConfig {
  ttl_s?: number;
  max_entries?: number;
  vary?: string[];
}

export interface RetryConfig {
  max_retries?: number;
}

export interface TrafficTarget {
  upstream: string;
  weight?: number;
}

export interface X402RouteConfig {
  price: string;
  asset: string;
  network: string;
  pay_to: string;
  scheme?: "exact" | "upto";
  max_timeout_seconds?: number;
  settlement_url?: string;
  gateway_id?: string;
  extra_name?: string;
  extra_version?: string;
  facilitator_url?: string;
  extensions?: Record<string, unknown>;
  resource_url?: string;
  inline_receipt?: boolean;
}

export interface TenantConfig {
  socket_dir: string;
  header?: string;
  skip_filter_when_warm?: boolean;
}

export interface ProxyOptions {
  host?: string;
  rewrite_pattern?: string;
  rewrite_replacement?: string;
  connect_timeout_ms?: number;
  send_timeout_ms?: number;
  read_timeout_ms?: number;
  total_timeout_ms?: number;
  max_response_bytes?: number;
  auth?: AuthConfig;
  rate_limit?: RateLimitConfig;
  cache?: CacheConfig;
  traffic_split?: TrafficTarget[];
  mirror?: string;
  body_schema?: Record<string, unknown>;
  upstream_headers?: Array<{ name: string; value: string }>;
  retry?: RetryConfig;
  x402?: X402RouteConfig;
}

export interface Route extends ProxyOptions {
  path_prefix: string;
  upstream?: string;
  tenant?: TenantConfig;
  [key: string]: unknown;
}

export interface TlsCertificate {
  hostnames: string[];
  cert_path: string;
  key_path: string;
}

export interface TlsConfig {
  cert_path?: string;
  key_path?: string;
  certificates?: TlsCertificate[];
  client_ca_path?: string;
  client_cert_required?: boolean;
}

export interface QuicConfig {
  enabled?: boolean;
  port?: number;
  cert_path?: string;
  key_path?: string;
  max_idle_timeout_ms?: number;
  max_streams_bidi?: number;
  max_streams_uni?: number;
}

export interface Http2Config {
  max_streams?: number;
  max_header_list_size?: number;
  initial_window_size?: number;
  max_frame_size?: number;
  h2c_only?: boolean;
}

export interface ListenerConfig {
  address?: string;
  port: number;
  use_tls?: boolean;
  h2c_only?: boolean;
  quic_enabled?: boolean;
  quic_port?: number;
}

export interface AdminConfig {
  enabled?: boolean;
  port?: number;
  address?: string;
  api_key?: string;
}

export interface OtelConfig {
  enabled?: boolean;
  collector_url?: string;
  service_name?: string;
  flush_interval_s?: number;
  sample_rate?: number;
  max_batch_size?: number;
  headers?: string;
}

export interface BufferPoolConfig {
  buffer_size?: number;
  buffer_count?: number;
  body_buffer_size?: number;
  body_buffer_count?: number;
}

export interface X402Config {
  enabled?: boolean;
  facilitator_url?: string;
  facilitator_timeout_ms?: number;
  payment_required_b64?: string;
}

export interface PostgresConfig {
  url: string;
  password_env?: string;
  pool_size_per_worker?: number;
  statement_timeout_ms?: number;
  allow_cleartext_password?: boolean;
  ssl_root_cert?: string;
}

export interface WasmFilterConfig {
  match: string;
  module: string;
  instances?: number;
  fuel?: number;
  response_fail_closed?: boolean;
}

export interface TimeoutsConfig {
  idle_ms?: number;
  header_ms?: number;
  body_ms?: number;
  write_ms?: number;
}

export interface LimitsConfig {
  max_header_bytes?: number;
  max_body_bytes?: number;
  max_header_count?: number;
}

export interface ServerConfig {
  port: number;
  address?: string;
  workers?: number;
  max_connections?: number;
  static_root?: string;
  cache_static_files?: boolean;
  disable_middleware?: boolean;
  preencoded?: boolean;
  allowed_hosts?: string[];
  listeners?: ListenerConfig[];
  [key: string]: unknown;
}

export interface SwerverConfig {
  server: ServerConfig;
  timeouts?: TimeoutsConfig;
  limits?: LimitsConfig;
  buffer_pool?: BufferPoolConfig;
  tls?: TlsConfig;
  http2?: Http2Config;
  quic?: QuicConfig;
  x402?: X402Config;
  admin?: AdminConfig;
  otel?: OtelConfig;
  postgres?: PostgresConfig;
  upstreams?: Upstream[];
  routes?: Route[];
  wasm_filters?: WasmFilterConfig[];
  wasm_control_socket?: string;
  wasm_control_connections?: number;
  wasm_host_call_deadline_ms?: number;
  tenant_idle_ttl_ms?: number;
  [key: string]: unknown;
}

export const APP_UPSTREAM = "__swerverts_app";

export interface GenerateInput {
  port: number;
  address?: string | undefined;
  workers?: number | undefined;
  staticRoot?: string | undefined;
  cacheStaticFiles?: boolean | undefined;
  disableMiddleware?: boolean | undefined;
  preencoded?: boolean | undefined;
  maxConnections?: number | undefined;
  allowedHosts?: string[] | undefined;
  listeners?: ListenerConfig[] | undefined;
  timeouts?: SwerverConfig["timeouts"] | undefined;
  limits?: SwerverConfig["limits"] | undefined;
  bufferPool?: BufferPoolConfig | undefined;
  tls?: TlsConfig | undefined;
  http2?: Http2Config | undefined;
  quic?: QuicConfig | undefined;
  x402?: X402Config | undefined;
  admin?: AdminConfig | undefined;
  otel?: OtelConfig | undefined;
  postgres?: PostgresConfig | undefined;
  wasmFilters?: WasmFilterConfig[] | undefined;
  wasmControlSocket?: string | undefined;
  wasmControlConnections?: number | undefined;
  wasmHostCallDeadlineMs?: number | undefined;
  tenantIdleTtlMs?: number | undefined;
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
      ...(input.cacheStaticFiles !== undefined ? { cache_static_files: input.cacheStaticFiles } : {}),
      ...(input.disableMiddleware !== undefined ? { disable_middleware: input.disableMiddleware } : {}),
      ...(input.preencoded !== undefined ? { preencoded: input.preencoded } : {}),
      ...(input.maxConnections !== undefined ? { max_connections: input.maxConnections } : {}),
      ...(input.allowedHosts ? { allowed_hosts: input.allowedHosts } : {}),
      ...(input.listeners ? { listeners: input.listeners } : {}),
    },
    ...(input.timeouts ? { timeouts: input.timeouts } : {}),
    ...(input.limits ? { limits: input.limits } : {}),
    ...(input.bufferPool ? { buffer_pool: input.bufferPool } : {}),
    ...(input.tls ? { tls: input.tls } : {}),
    ...(input.http2 ? { http2: input.http2 } : {}),
    ...(input.quic ? { quic: input.quic } : {}),
    ...(input.x402 ? { x402: input.x402 } : {}),
    ...(input.admin ? { admin: input.admin } : {}),
    ...(input.otel ? { otel: input.otel } : {}),
    ...(input.postgres ? { postgres: input.postgres } : {}),
    ...(input.wasmFilters ? { wasm_filters: input.wasmFilters } : {}),
    ...(input.wasmControlSocket ? { wasm_control_socket: input.wasmControlSocket } : {}),
    ...(input.wasmControlConnections !== undefined
      ? { wasm_control_connections: input.wasmControlConnections }
      : {}),
    ...(input.wasmHostCallDeadlineMs !== undefined
      ? { wasm_host_call_deadline_ms: input.wasmHostCallDeadlineMs }
      : {}),
    ...(input.tenantIdleTtlMs !== undefined ? { tenant_idle_ttl_ms: input.tenantIdleTtlMs } : {}),
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
  for (const listener of config.server?.listeners ?? []) {
    if (!Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65535) {
      problems.push(`listener.port must be an integer in 1..65535 (got ${listener.port})`);
    }
  }
  if (config.tls && Boolean(config.tls.cert_path) !== Boolean(config.tls.key_path)) {
    problems.push("tls.cert_path and tls.key_path must be set together");
  }
  if (config.quic?.enabled && (!config.quic.cert_path || !config.quic.key_path)) {
    problems.push("quic cert_path and key_path are required when QUIC is enabled");
  }
  if (config.admin?.enabled && !config.admin.api_key) {
    problems.push("admin.api_key is required when the admin API is enabled");
  }
  if (
    config.postgres?.pool_size_per_worker !== undefined &&
    (config.postgres.pool_size_per_worker < 1 || config.postgres.pool_size_per_worker > 4)
  ) {
    problems.push("postgres.pool_size_per_worker must be in 1..4");
  }
  if (
    config.wasm_control_connections !== undefined &&
    (config.wasm_control_connections < 1 || config.wasm_control_connections > 16)
  ) {
    problems.push("wasm_control_connections must be in 1..16");
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
    if ((!up.servers || up.servers.length === 0) && !up.dns_discovery && !up.consul_discovery) {
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
    if (route.tenant) {
      if (route.upstream) problems.push(`tenant route '${route.path_prefix}' cannot set upstream`);
      if (!route.tenant.socket_dir?.startsWith("/")) {
        problems.push(`tenant route '${route.path_prefix}' socket_dir must be absolute`);
      }
      if (route.cache || route.traffic_split || route.mirror) {
        problems.push(`tenant route '${route.path_prefix}' cannot use cache, traffic_split, or mirror`);
      }
    } else if (!route.upstream) {
      problems.push(`route '${route.path_prefix}' must set upstream or tenant`);
    }
    for (const target of route.traffic_split ?? []) {
      if (!names.has(target.upstream)) {
        problems.push(`route '${route.path_prefix}' references undeclared split upstream '${target.upstream}'`);
      }
    }
    if (route.mirror && !names.has(route.mirror)) {
      problems.push(`route '${route.path_prefix}' references undeclared mirror upstream '${route.mirror}'`);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return brandValue(config);
}
