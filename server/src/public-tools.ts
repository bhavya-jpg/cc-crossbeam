/**
 * The only routes the Otari gateway needs to call back: the ADU law MCP server and the
 * guardrails service. Locally they get their own listener (PUBLIC_TOOLS_PORT, default
 * 8090, loopback only) so a tunnel exposes these two routes and not /generate, /extract
 * or /api/otari, which spend money or read project data.
 */

import express from 'express';
import { guardrailRouter } from './otari/guardrail-service.js';
import { aduLawMcpRouter } from './otari/mcp.js';
import { GUARDRAIL_PATH, MCP_PATH } from './otari/public-urls.js';

export function mountPublicTools(app: express.Express): void {
  app.use(MCP_PATH, aduLawMcpRouter);
  app.use(GUARDRAIL_PATH, guardrailRouter);
}

export function createPublicToolsApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', routes: [MCP_PATH, GUARDRAIL_PATH] });
  });
  mountPublicTools(app);
  app.use((_req, res) => {
    res.status(404).json({ detail: 'Not found' });
  });
  return app;
}
