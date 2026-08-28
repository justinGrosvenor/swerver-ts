// Standard Schema (https://standardschema.dev) is a tiny interface that Zod,
// Valibot, ArkType and others implement, so swerverts can accept any of them
// for request-body validation without depending on a specific library. The
// spec asks consumers to vendor these types rather than add a dependency.

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output>;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment>;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  export type InferInput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["input"];
  export type InferOutput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"];
}

/** Run a schema, awaiting async validators. Returns the spec Result. */
export async function runValidation<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>> {
  return schema["~standard"].validate(value) as Promise<
    StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>
  >;
}

/** Flatten spec issue paths to dotted strings for a JSON error body. */
export function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>) {
  return issues.map((issue) => ({
    message: issue.message,
    path: (issue.path ?? [])
      .map((seg) => (typeof seg === "object" ? seg.key : seg))
      .join("."),
  }));
}
