// Nominal ("branded") types. TypeScript is structural: two strings are
// interchangeable no matter what they mean. A brand attaches a phantom tag
// carried only in the type system (zero runtime cost) so that a value can be
// required to have come from a specific place.
//
// The brand key is a module-private `unique symbol`. Because it is never
// exported, no code outside this module can name it, so no object literal can
// satisfy a branded type by accident: the only way to obtain one is a cast
// performed here (or by a factory in this package). That is what makes a
// branded value "unforgeable" from user code.

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Assert that a raw value carries a brand. Call sites live inside the package. */
export function brandValue<B extends string, T>(value: T): Brand<T, B> {
  return value as Brand<T, B>;
}

/** Strip the brand back to the underlying type (e.g. for serialization). */
export function unbrand<T, B extends string>(value: Brand<T, B>): T {
  return value as T;
}
