/**
 * Read-only MCP server over the ADU law references, at POST /api/mcp/adu-law.
 *
 * Speaks the subset of streamable HTTP MCP a tool client needs: one JSON-RPC
 * request per POST, answered as `application/json`, with no sessions or SSE.
 * Set MCP_ADU_LAW_TOKEN to require a bearer token. The drafter also calls
 * `callAduLawTool` directly when the gateway can't reach this server.
 */

import { timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { listReferences, readReference, searchReferences } from './skills.js';

const MAX_DOC_CHARS = 30_000;
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const ADU_LAW_TOOLS = [
  {
    name: 'list_references',
    description: 'List the California ADU law and onboarded-city reference documents, with their ids.',
    inputSchema: {
      type: 'object',
      properties: { skill: { type: 'string', description: 'Optional skill name, e.g. california-adu or placentia-adu.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'search_references',
    description: 'Keyword search across the ADU law references. Returns ranked document ids with snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or a code section, e.g. "side setback 66314".' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_reference',
    description: 'Read one reference document by the id returned from list_references or search_references.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'For example california-adu/standards-setbacks.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
] as const;

export const ADU_LAW_TOOL_NAMES = ADU_LAW_TOOLS.map((tool) => tool.name);

const listArgs = z.object({ skill: z.string().optional() });
const searchArgs = z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).optional() });
const readArgs = z.object({ id: z.string().min(1) });

export interface AduLawToolResult {
  text: string;
  isError: boolean;
}

export function callAduLawTool(name: string, args: unknown): AduLawToolResult {
  try {
    switch (name) {
      case 'list_references':
        return { text: JSON.stringify(listReferences(listArgs.parse(args ?? {}).skill)), isError: false };
      case 'search_references': {
        const { query, limit } = searchArgs.parse(args);
        return { text: JSON.stringify(searchReferences(query, { limit })), isError: false };
      }
      case 'read_reference': {
        const doc = readReference(readArgs.parse(args).id);
        return doc
          ? { text: doc.text.slice(0, MAX_DOC_CHARS), isError: false }
          : { text: 'Unknown reference id. Use list_references or search_references.', isError: true };
      }
      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  } catch (error) {
    return { text: `Invalid arguments: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

function hasValidToken(req: Request, expected: string): boolean {
  const provided = Buffer.from(req.get('authorization') ?? '');
  const required = Buffer.from(`Bearer ${expected}`);
  return provided.length === required.length && timingSafeEqual(provided, required);
}

const rpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});

function rpcResult(res: Response, id: string | number, result: unknown) {
  res.json({ jsonrpc: '2.0', id, result });
}

function rpcError(res: Response, id: string | number | null, code: number, message: string, status = 200) {
  res.status(status).json({ jsonrpc: '2.0', id, error: { code, message } });
}

export const aduLawMcpRouter = Router();

aduLawMcpRouter.post('/', (req, res) => {
  const token = process.env.MCP_ADU_LAW_TOKEN;
  if (token && !hasValidToken(req, token)) {
    res.set('WWW-Authenticate', 'Bearer');
    rpcError(res, null, -32001, 'Unauthorized', 401);
    return;
  }

  const parsed = rpcRequest.safeParse(req.body);
  if (!parsed.success) {
    rpcError(res, null, -32600, 'Invalid JSON-RPC request', 400);
    return;
  }

  const { id, method, params } = parsed.data;
  // A notification has no id and gets no JSON-RPC reply.
  if (id === undefined) {
    res.status(202).end();
    return;
  }

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      rpcResult(res, id, {
        protocolVersion: typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'structura-adu-law', version: '1.0.0' },
      });
      return;
    }
    case 'ping':
      rpcResult(res, id, {});
      return;
    case 'tools/list':
      rpcResult(res, id, { tools: ADU_LAW_TOOLS });
      return;
    case 'tools/call': {
      const { text, isError } = callAduLawTool(String(params?.name ?? ''), params?.arguments);
      rpcResult(res, id, { content: [{ type: 'text', text }], isError });
      return;
    }
    default:
      rpcError(res, id, -32601, `Method not found: ${method}`);
  }
});

// No server-initiated stream and no sessions to close.
aduLawMcpRouter.all('/', (_req, res) => {
  res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed' });
});
