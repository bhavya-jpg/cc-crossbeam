/**
 * Inspector API, called only by the frontend's own /api/otari/* routes, which check that
 * the signed-in user may see the project. A shared token keeps this server's public URL
 * from bypassing that check.
 */

import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { otari, OtariClient, type TraceSummary } from '../otari/client.js';
import { DEMO_SCENARIOS, runDemoScenario, type DemoResult, type DemoScenario } from '../otari/demo.js';
import { getTelemetryMessages } from '../services/supabase.js';

const CONVERSATION_ID = /^crossbeam-(?:demo-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-\d+$/i;
const TELEMETRY_PREFIX = '[OTARI_TELEMETRY] ';

export function requireInspectorToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.OTARI_INSPECTOR_TOKEN;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'OTARI_INSPECTOR_TOKEN is not configured' });
    }
    return next();
  }
  const given = Buffer.from(req.headers.authorization ?? '');
  const wanted = Buffer.from(`Bearer ${expected}`);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function demoControlsEnabled(): boolean {
  const flag = process.env.OTARI_DEMO_CONTROLS;
  return flag === 'true' || (flag !== 'false' && process.env.NODE_ENV !== 'production');
}

export interface OtariRouterDeps {
  client: OtariClient;
  loadTelemetry: (projectId: string) => Promise<string[]>;
  runDemo: (scenario: DemoScenario, projectId: string) => Promise<DemoResult>;
}

/** The run's trace from the gateway, or the reason it isn't available. */
async function gatewayTrace(client: OtariClient, conversationId: string): Promise<{ trace: unknown } | { reason: string }> {
  if (client.isSimulating()) return { reason: 'Demo simulation is active, so the gateway has no trace for this run.' };
  if (!process.env.OTARI_MASTER_KEY) return { reason: 'OTARI_MASTER_KEY is not set.' };
  try {
    const { data } = await client.listTraces({ q: conversationId, limit: 5 });
    const match = data.items.find((item: TraceSummary) => item.trace_id === conversationId) ?? data.items[0];
    if (!match) return { reason: 'The gateway has no trace for this conversation yet.' };
    const { data: trace } = await client.getTrace(match.trace_id, { workspace_id: match.workspace_id });
    return { trace };
  } catch (error) {
    return { reason: `The gateway refused the trace read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function createOtariRouter(deps: OtariRouterDeps): Router {
  const router = Router();
  const running = new Set<string>();
  router.use(requireInspectorToken);

  router.post('/demo', async (req, res) => {
    if (!demoControlsEnabled()) {
      return res.status(403).json({ error: 'Demo controls are turned off on this server. Set OTARI_DEMO_CONTROLS=true to allow them.' });
    }
    const parsed = z.object({ project_id: z.string().uuid(), scenario: z.enum(DEMO_SCENARIOS) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

    const { project_id: projectId, scenario } = parsed.data;
    if (running.has(projectId)) return res.status(409).json({ error: 'A demo is already running on this project' });
    running.add(projectId);
    try {
      return res.json(await deps.runDemo(scenario, projectId));
    } catch (error) {
      console.error('Demo failed:', error);
      return res.status(500).json({ error: 'The demo could not run' });
    } finally {
      running.delete(projectId);
    }
  });

  router.get('/traces/:conversationId', async (req, res) => {
    const { conversationId } = req.params;
    const projectId = CONVERSATION_ID.exec(conversationId)?.[1];
    if (!projectId) return res.status(400).json({ error: 'Invalid conversation ID' });

    const gateway = await gatewayTrace(deps.client, conversationId);
    if ('trace' in gateway) {
      return res.json({ conversationId, source: 'gateway', reason: null, trace: gateway.trace, spans: [] });
    }

    const spans = (await deps.loadTelemetry(projectId))
      .flatMap((content) => {
        try {
          return [JSON.parse(content.slice(TELEMETRY_PREFIX.length)) as { conversationId?: string }];
        } catch {
          return [];
        }
      })
      .filter((span) => span.conversationId === conversationId);
    return res.json({ conversationId, source: 'collected', reason: gateway.reason, trace: null, spans });
  });

  return router;
}

export const otariRouter = createOtariRouter({
  client: otari,
  loadTelemetry: getTelemetryMessages,
  runDemo: runDemoScenario,
});
