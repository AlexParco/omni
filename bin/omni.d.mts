/** Tipos de `omni.mjs` para los tests en TypeScript. */
export const USAGE: string
export type Parsed =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'command'; type: string; args: Record<string, unknown>; json: boolean }
export function parseArgs(argv: string[]): Parsed
export function formatResult(type: string, result: unknown): string
export function main(argv?: string[], out?: { write(s: string): unknown }, err?: { write(s: string): unknown }): Promise<number>
