// Emit an OpenAPI 3.1 document from a Swerver app's registered routes.
//
// Path parameters are read from the route pattern. Request/response bodies and
// query/header parameters come from the route's Standard Schemas, converted to
// JSON Schema by a caller-supplied `toJsonSchema` (there is no standard
// Schema -> JSON Schema conversion, so this stays library-agnostic). Without a
// converter the structure is still emitted, with open ({}) body schemas and no
// enumerated query/header params. Pass e.g. Zod v4's `z.toJSONSchema`.

import type { CompiledRoute } from "./router.ts";
import type { Schema } from "./schema.ts";

export interface OpenApiOptions {
  info?: { title?: string; version?: string; description?: string };
  servers?: { url: string; description?: string }[];
  toJsonSchema?: ((schema: Schema) => Record<string, unknown>) | undefined;
}

export type OpenApiDocument = Record<string, unknown>;

interface Parameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: Record<string, unknown>;
}

function toOpenApiPath(pattern: string): string {
  return pattern
    .split("/")
    .map((seg) => (seg === "*" ? "{rest}" : seg.startsWith(":") ? `{${seg.slice(1)}}` : seg))
    .join("/");
}

function pathParams(pattern: string): Parameter[] {
  const params: Parameter[] = [];
  for (const seg of pattern.split("/")) {
    if (seg === "*") params.push({ name: "rest", in: "path", required: true, schema: { type: "string" } });
    else if (seg.startsWith(":")) {
      params.push({ name: seg.slice(1), in: "path", required: true, schema: { type: "string" } });
    }
  }
  return params;
}

// Turn an object JSON Schema into individual query/header parameters.
function schemaToParams(
  schema: Schema,
  where: "query" | "header",
  toJsonSchema: OpenApiOptions["toJsonSchema"],
): Parameter[] {
  if (!toJsonSchema) return [];
  const js = toJsonSchema(schema);
  if (js["type"] !== "object" || typeof js["properties"] !== "object") return [];
  const properties = js["properties"] as Record<string, Record<string, unknown>>;
  const required = Array.isArray(js["required"]) ? (js["required"] as string[]) : [];
  return Object.entries(properties).map(([name, propSchema]) => ({
    name,
    in: where,
    required: required.includes(name),
    schema: propSchema,
  }));
}

function jsonContent(
  schema: Schema | undefined,
  toJsonSchema: OpenApiOptions["toJsonSchema"],
): Record<string, unknown> {
  const inner = schema && toJsonSchema ? toJsonSchema(schema) : {};
  return { "application/json": { schema: inner } };
}

export function buildOpenApi(
  routes: CompiledRoute<unknown>[],
  options: OpenApiOptions = {},
): OpenApiDocument {
  const toJsonSchema = options.toJsonSchema;
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    if (!route.method) continue; // any-method routes have no single verb

    const oaPath = toOpenApiPath(route.pattern);
    const item = paths[oaPath] ?? (paths[oaPath] = {});
    const { body, query, headers, response } = route.schemas;

    const parameters: Parameter[] = [
      ...pathParams(route.pattern),
      ...(query ? schemaToParams(query, "query", toJsonSchema) : []),
      ...(headers ? schemaToParams(headers, "header", toJsonSchema) : []),
    ];

    const responses: Record<string, unknown> = {
      "200": response
        ? { description: "OK", content: jsonContent(response, toJsonSchema) }
        : { description: "OK" },
    };
    if (body) responses["400"] = { description: "Invalid JSON body" };
    if (body || query || headers) responses["422"] = { description: "Validation failed" };

    const operation: Record<string, unknown> = { responses };
    if (parameters.length > 0) operation["parameters"] = parameters;
    if (body) {
      operation["requestBody"] = { required: true, content: jsonContent(body, toJsonSchema) };
    }

    item[route.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: options.info?.title ?? "swerverts API",
      version: options.info?.version ?? "0.0.0",
      ...(options.info?.description ? { description: options.info.description } : {}),
    },
    ...(options.servers ? { servers: options.servers } : {}),
    paths,
  };
}
