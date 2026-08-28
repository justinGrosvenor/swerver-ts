declare module "bun:test" {
  export function describe(name: string, body: () => void): void;
  export function test(name: string, body: () => void | Promise<void>): void;
  export namespace test {
    function skip(name: string, body: () => void | Promise<void>): void;
  }
  export function expect<T>(value: T): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toBeDefined(): void;
  };
}
