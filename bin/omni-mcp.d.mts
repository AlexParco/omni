/** Tipos de `omni-mcp.mjs` para los tests en TypeScript. */
import type { ControlReply } from './omni-client.mjs'
export const PROTOCOL_VERSION: string
export interface Tool {
  name: string
  command: string
  description: string
  inputSchema: Record<string, unknown>
}
export const TOOLS: Tool[]
export function fromOf(env?: NodeJS.ProcessEnv): string
export interface McpServer {
  handle(message: unknown): Promise<Record<string, unknown> | null>
}
export function createMcpServer(opts?: { call?: (command: Record<string, unknown>) => Promise<ControlReply>; from?: string; tools?: Tool[]; name?: string }): McpServer
export function main(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, server?: McpServer): void
