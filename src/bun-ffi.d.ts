// Minimal ambient declarations for the slice of `bun:ffi` swerver-ts uses,
// so the FFI backend typechecks under strict TS without a bun-types dependency.
declare module "bun:ffi" {
  type FFITypeValue = number & { readonly __ffiType: unique symbol };
  export const FFIType: {
    readonly ptr: FFITypeValue;
    readonly u64: FFITypeValue;
    readonly u32: FFITypeValue;
    readonly u16: FFITypeValue;
    readonly i32: FFITypeValue;
    readonly void: FFITypeValue;
  };
  export function dlopen(
    path: string,
    symbols: Record<string, { args: FFITypeValue[]; returns: FFITypeValue }>,
  ): { symbols: Record<string, (...args: never[]) => unknown>; close(): void };
  export function ptr(view: ArrayBufferView | ArrayBuffer): number;
  export function toArrayBuffer(ptr: number, byteOffset: number, byteLength: number): ArrayBuffer;
}
