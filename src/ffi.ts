// FFI backend: load libswerver and drive the embedded server in-process, so a
// dynamic route is handled by JS on the same process with no socket hop. This
// is the fast path; the default socket backend stays the portable fallback.
//
// The host drains parked requests with swerver_poll (Bun's thread-safe callback
// is unsafe to invoke per-request under load, so we poll instead), reads each
// with swerver_request, and answers with swerver_respond.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Types for the slice of bun:ffi we use are declared in src/bun-ffi.d.ts.
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

/** The libswerver C ABI, typed. Pointers are numbers; u64 values are bigint. */
export interface Lib {
  abiVersion(): number;
  init(cfgPtr: number, cfgLen: bigint): number;
  route(handle: number, patternPtr: number, patternLen: bigint, routeId: number): number;
  wakeConnect(handle: number, pathPtr: number, pathLen: bigint): number;
  wakeClear(): void;
  poll(): bigint;
  request(reqId: bigint, outPtr: number): number;
  requestHeaders(reqId: bigint, outPtr: number): number;
  // Lengths are passed as plain numbers: bun:ffi accepts a JS number for a u64
  // *argument* (only 64-bit returns must be bigint), which avoids boxing a
  // BigInt per response. reqId stays bigint (it came from a u64 return).
  respond(
    reqId: bigint,
    status: number,
    ctypePtr: number,
    ctypeLen: number,
    bodyPtr: number,
    bodyLen: number,
  ): number;
  respondFull(
    reqId: bigint,
    status: number,
    headersPtr: number,
    headersLen: number,
    bodyPtr: number,
    bodyLen: number,
  ): number;
  // Answer with the body already written into the slot's response buffer (via
  // the resp_ptr from `request`) — no body copy.
  respondInplace(reqId: bigint, status: number, ctypePtr: number, ctypeLen: number, bodyLen: number): number;
  respondInplaceFull(
    reqId: bigint,
    status: number,
    headersPtr: number,
    headersLen: number,
    bodyLen: number,
  ): number;
  start(handle: number): number;
  shutdown(handle: number): void;
  pending(): number;
  stop(handle: number): void;
  close(): void;
}

/**
 * The prebuilt platform package for this host, if installed: @swerver/<os>-<arch>
 * ships libswerver (and the binary) as an optionalDependency, so npm/bun install
 * only the one matching the host. Mirrors the resolution in binary.ts.
 */
function platformPackageLib(libName: string): string | null {
  try {
    const resolved = require.resolve(`@swerver/${process.platform}-${process.arch}/${libName}`);
    if (existsSync(resolved)) return resolved;
  } catch {
    // Not installed for this host; fall through.
  }
  return null;
}

/**
 * Locate libswerver: explicit path, then SWERVER_LIB, then the @swerver/<os>-<arch>
 * prebuilt package, then a `lib/` sibling of SWERVER_BIN (dev layout:
 * zig-out/bin + zig-out/lib).
 */
export function resolveLib(explicit?: string): string {
  const name = process.platform === "darwin" ? "libswerver.dylib" : "libswerver.so";
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`libswerver not found at ${explicit}`);
    return explicit;
  }
  const fromEnv = process.env["SWERVER_LIB"];
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`SWERVER_LIB points at a missing file: ${fromEnv}`);
    return fromEnv;
  }
  const fromPkg = platformPackageLib(name);
  if (fromPkg) return fromPkg;
  const bin = process.env["SWERVER_BIN"];
  if (bin) {
    const candidate = join(dirname(dirname(bin)), "lib", name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `libswerver not found. Install the @swerver/${process.platform}-${process.arch} prebuilt, ` +
      `set SWERVER_LIB, pass libraryPath, or set SWERVER_BIN.`,
  );
}

const T = FFIType;

/** libswerver C ABI version this client is built against. dlopen fails on an
 * older library that lacks the newer symbols, but check explicitly for a clear
 * error rather than a cryptic missing-symbol failure. */
export const EXPECTED_ABI = 5;

export function loadLib(libPath: string): Lib {
  const { symbols, close } = dlopen(libPath, {
    swerver_abi_version: { args: [], returns: T.u32 },
    swerver_init: { args: [T.ptr, T.u64], returns: T.ptr },
    swerver_route: { args: [T.ptr, T.ptr, T.u64, T.u32], returns: T.i32 },
    swerver_wake_connect: { args: [T.ptr, T.ptr, T.u64], returns: T.i32 },
    swerver_wake_clear: { args: [], returns: T.void },
    swerver_poll: { args: [], returns: T.u64 },
    swerver_request: { args: [T.u64, T.ptr], returns: T.i32 },
    swerver_request_headers: { args: [T.u64, T.ptr], returns: T.i32 },
    swerver_respond: { args: [T.u64, T.u16, T.ptr, T.u64, T.ptr, T.u64], returns: T.i32 },
    swerver_respond_full: { args: [T.u64, T.u16, T.ptr, T.u64, T.ptr, T.u64], returns: T.i32 },
    swerver_respond_inplace: { args: [T.u64, T.u16, T.ptr, T.u64, T.u64], returns: T.i32 },
    swerver_respond_inplace_full: { args: [T.u64, T.u16, T.ptr, T.u64, T.u64], returns: T.i32 },
    swerver_start: { args: [T.ptr], returns: T.i32 },
    swerver_shutdown: { args: [T.ptr], returns: T.void },
    swerver_pending: { args: [], returns: T.u32 },
    swerver_stop: { args: [T.ptr], returns: T.void },
  });
  const s = symbols;
  const abi = s["swerver_abi_version"]!() as number;
  if (abi !== EXPECTED_ABI) {
    close();
    throw new Error(
      `libswerver ABI mismatch: loaded ${abi}, this client expects ${EXPECTED_ABI} (${libPath})`,
    );
  }
  return {
    abiVersion: () => s["swerver_abi_version"]!() as number,
    init: (c, l) => (s["swerver_init"]!(c as never, l as never) as number | null) ?? 0,
    route: (h, p, l, id) => s["swerver_route"]!(h as never, p as never, l as never, id as never) as number,
    wakeConnect: (h, p, l) => s["swerver_wake_connect"]!(h as never, p as never, l as never) as number,
    wakeClear: () => {
      s["swerver_wake_clear"]!();
    },
    poll: () => s["swerver_poll"]!() as bigint,
    request: (r, o) => s["swerver_request"]!(r as never, o as never) as number,
    requestHeaders: (r, o) => s["swerver_request_headers"]!(r as never, o as never) as number,
    respond: (r, st, cp, cl, bp, bl) =>
      s["swerver_respond"]!(r as never, st as never, cp as never, cl as never, bp as never, bl as never) as number,
    respondFull: (r, st, hp, hl, bp, bl) =>
      s["swerver_respond_full"]!(r as never, st as never, hp as never, hl as never, bp as never, bl as never) as number,
    respondInplace: (r, st, cp, cl, bl) =>
      s["swerver_respond_inplace"]!(r as never, st as never, cp as never, cl as never, bl as never) as number,
    respondInplaceFull: (r, st, hp, hl, bl) =>
      s["swerver_respond_inplace_full"]!(r as never, st as never, hp as never, hl as never, bl as never) as number,
    start: (h) => s["swerver_start"]!(h as never) as number,
    shutdown: (h) => {
      s["swerver_shutdown"]!(h as never);
    },
    pending: () => s["swerver_pending"]!() as number,
    stop: (h) => {
      s["swerver_stop"]!(h as never);
    },
    close,
  };
}

export { ptr, toArrayBuffer };
