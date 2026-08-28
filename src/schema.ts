// Standard Schema (https://standardschema.dev) is a tiny interface that Zod,
// Valibot, ArkType and others implement, so swerverts can accept any of them
// for validation without depending on a specific library.
//
// `Schema` here is a deliberately loose structural bound: its `validate`
// returns `unknown`. That matters under `exactOptionalPropertyTypes`, where the
// spec's precise discriminated `Result` union (success has `issues?: undefined`)
// does not accept a concrete library's `Result` as a subtype, which would make
// `S extends StandardSchema<unknown>` reject a real Zod schema. The loose bound
// sidesteps that; the precise `Result` shape is used only at the call boundary
// in `runValidation`, where we cast.

export interface Schema {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => unknown;
    readonly types?: { readonly input: unknown; readonly output: unknown } | undefined;
  };
}

/** The type a schema produces after validation (what handlers receive). */
export type InferOutput<S extends Schema> =
  NonNullable<S["~standard"]["types"]> extends { output: infer O } ? O : unknown;

/** The type a schema accepts as input (what a client sends). */
export type InferInput<S extends Schema> =
  NonNullable<S["~standard"]["types"]> extends { input: infer I } ? I : unknown;

// ── Precise runtime result shape (per the spec) ─────────────────────────────

export interface Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

export type ValidationResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly value?: undefined; readonly issues: ReadonlyArray<Issue> };

/** Run a schema, awaiting async validators. Returns the spec Result. */
export async function runValidation<S extends Schema>(
  schema: S,
  value: unknown,
): Promise<ValidationResult<InferOutput<S>>> {
  const result = schema["~standard"].validate(value) as
    | ValidationResult<InferOutput<S>>
    | Promise<ValidationResult<InferOutput<S>>>;
  return result;
}

/** Flatten spec issue paths to dotted strings for a JSON error body. */
export function formatIssues(issues: ReadonlyArray<Issue>): { message: string; path: string }[] {
  return issues.map((issue) => ({
    message: issue.message,
    path: (issue.path ?? [])
      .map((seg) => (typeof seg === "object" ? seg.key : seg))
      .join("."),
  }));
}
