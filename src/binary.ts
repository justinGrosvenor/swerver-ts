// Locate the swerver binary. Resolution order:
//   1. explicit path passed to Swerver({ binaryPath })
//   2. SWERVER_BIN environment variable
//   3. a platform package @swerver/<os>-<arch> (published from the swerver repo)
//   4. "swerver" on PATH
//
// The platform-package step mirrors the esbuild/@swc layout: prebuilt binaries
// ship as optionalDependencies so npm installs only the one for the host.

import { existsSync } from "node:fs";

function platformPackage(): string | null {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  const arch =
    process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  const pkg = `@swerver/${os}-${arch}`;
  try {
    // The platform package exposes the binary path via its "bin" export.
    const resolved = require.resolve(`${pkg}/swerver`);
    if (existsSync(resolved)) return resolved;
  } catch {
    // Not installed for this host; fall through.
  }
  return null;
}

export function resolveBinary(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`swerver binary not found at ${explicit}`);
    }
    return explicit;
  }
  const fromEnv = process.env["SWERVER_BIN"];
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`SWERVER_BIN points at a missing file: ${fromEnv}`);
    }
    return fromEnv;
  }
  const fromPkg = platformPackage();
  if (fromPkg) return fromPkg;
  // Last resort: rely on PATH. Bun.spawn/child_process resolves it.
  return "swerver";
}
