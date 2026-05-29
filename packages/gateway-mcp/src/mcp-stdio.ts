#!/usr/bin/env node
/**
 * AEGIS MCP stdio entrypoint.
 *
 * Runs the same audit-tool catalog as the existing AegisMcpServer
 * (query_traces / list_violations / get_agent_stats / list_policies /
 * query_anomalies) but speaks JSON-RPC 2.0 over stdin/stdout per the
 * MCP stdio transport spec. Use this when:
 *
 *   - You want to bake AEGIS into a tool like mcp2cli / Claude Desktop
 *     and the HTTP gateway is already running in Docker (so binding
 *     8080 again would collide).
 *   - You want a single-purpose, no-network MCP read-only audit pane.
 *
 * Reported by githb-ac in Issue #4 — the existing server entrypoint
 * (server.ts) always binds an Express HTTP listener, which prevents
 * it from being used as a stdio MCP server alongside the gateway.
 *
 * Critical invariants for stdio MCP:
 *   - **stdout is JSON-RPC only**. All logs go to stderr. We use a
 *     plain console.error (no pino) inside the loop to keep the
 *     contract obvious to anyone reading the file.
 *   - **No port binding**. We never construct an http.Server.
 *   - **One JSON object per line**. We buffer stdin and split on \n;
 *     the MCP stdio transport guarantees newline-delimited messages.
 *
 * Usage:
 *   AEGIS_DB_PATH=/path/to/agentguard.db node dist/mcp-stdio.js
 */

import Database from 'better-sqlite3';
import pino from 'pino';
import { AegisMcpServer } from './mcp/aegis-mcp-server';

// Logger to stderr so it never pollutes the JSON-RPC stream.
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' }, pino.destination(2));

const dbPath = process.env.AEGIS_DB_PATH || process.env.DB_PATH || './agentguard.db';
let db: Database.Database;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(
    `[aegis-mcp-stdio] Cannot open AEGIS database at ${dbPath}: ${(err as Error).message}\n` +
    `Set AEGIS_DB_PATH to point at the gateway's SQLite file.`,
  );
  process.exit(1);
}

const server = new AegisMcpServer(db, logger);

/** Build a JSON-RPC reply (or null for notifications). Wraps the
 *  existing AegisMcpServer.callTool so transport changes don't fork
 *  the tool catalog. */
function processMessage(msg: any): object | null {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'aegis-audit-stdio', version: '1.0.0' },
      },
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: server.tools } };
  }
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    try {
      const result = server.callTool(name, args);
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      };
    } catch (err: any) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: err.message } };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function emit(obj: object): void {
  // process.stdout.write is sync for TTY but buffered for pipes —
  // we still get newline-delimited frames as the spec requires.
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let buf = '';
process.stdin.on('data', (chunk: Buffer) => {
  buf += chunk.toString('utf8');
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      emit({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    const reply = processMessage(msg);
    if (reply) emit(reply);
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Announce readiness to stderr only — never stdout.
console.error(`[aegis-mcp-stdio] ready (db=${dbPath})`);
