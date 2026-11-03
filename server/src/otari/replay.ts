/**
 * Hybrid mode's stand-in for a model call the gateway refused for lack of funds. Every
 * request still goes to the gateway first; this runs only after a real
 * `402 insufficient_funds`, and turns off by itself once the account has funds.
 *
 * It replays real output recorded by an earlier CrossBeam run on the Placentia project
 * in test-assets/correction-01. Telemetry and documents both say that no model ran, so
 * nothing here can be mistaken for a live completion or a real guardrail verdict.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileBlock, simulateOtariResponse, type SimStage } from './simulation.js';

const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../test-assets');
const RECORDED_DIR = path.join(ASSETS_DIR, 'correction-01');

export const RECORDED_BANNER =
  '> **RECORDED SAMPLE.** From an earlier CrossBeam run on 1232 N Jefferson St, shown because Otari returned 402 insufficient_funds. No model produced this copy. Do not submit it to a building department.\n\n';

const NOT_RUN = 'Not run: the gateway returned 402 insufficient_funds, so no model or tool was called.';

const text = (relative: string, base = RECORDED_DIR) => fs.readFileSync(path.join(base, relative), 'utf-8');
const json = (relative: string) => ({ recorded_sample: true, ...JSON.parse(text(relative)) });
const doc = (name: string, relative: string, base?: string) => fileBlock(name, RECORDED_BANNER + text(relative, base));

interface RecordedSheet {
  sheet_id?: string;
  page_number?: number;
  description?: string;
  observations?: unknown;
}

/** The recorded observations for the pages this request asked about. */
function recordedSheets(body: unknown): unknown[] {
  const { sheets_reviewed: reviewed = [] } = JSON.parse(text('sheet_observations.json')) as { sheets_reviewed?: RecordedSheet[] };
  const content = (body as { messages?: Array<{ content?: unknown }> } | undefined)?.messages?.[1]?.content;
  const prompt = Array.isArray(content) ? String((content[0] as { text?: unknown } | undefined)?.text ?? '') : '';
  const pages = new Set((/pages: ([\d, ]+)/.exec(prompt)?.[1] ?? '').split(',').map((page) => Number(page.trim())));
  return reviewed
    .filter((sheet) => pages.has(sheet.page_number ?? -1))
    .map((sheet) => ({ page: sheet.page_number, sheet_id: sheet.sheet_id, sheet_title: sheet.description, discipline: null, observations: sheet.observations }));
}

function recordedText(stage: SimStage | undefined, body: unknown): string {
  switch (stage) {
    case 'extract-corrections':
      return fileBlock('corrections_parsed.json', json('corrections_parsed.json'));
    case 'extract-sheets':
      return fileBlock('sheet_observations.json', { recorded_sample: true, sheets: recordedSheets(body) });
    case 'research':
      return fileBlock('city_research_findings.json', { recorded_sample: true, sources: [], findings: [{ topic: 'City research', rule: NOT_RUN, citation: null }] });
    case 'spatial-compute':
    case 'spatial-verify':
      return fileBlock('spatial_analysis.json', { recorded_sample: true, checks: [], note: NOT_RUN });
    case 'draft-analysis':
      return [
        fileBlock('state_law_findings.json', json('state_law_findings.json')),
        fileBlock('corrections_categorized.json', json('corrections_categorized.json')),
        fileBlock('contractor_questions.json', json('contractor_questions.json')),
      ].join('\n');
    case 'draft-response':
      return [
        doc('response_letter.md', 'output-02/response_letter.md'),
        doc('professional_scope.md', 'output-02/professional_scope.md'),
        doc('corrections_report.md', 'output-02/corrections_report.md'),
        fileBlock('sheet_annotations.json', json('sheet_annotations.json')),
      ].join('\n');
    case 'draft-review':
      return [
        doc('draft_corrections.md', 'corrections/DRAFT-CORRECTIONS-1232-N-Jefferson.md', ASSETS_DIR),
        fileBlock('draft_corrections.json', { recorded_sample: true, items: [] }),
        fileBlock('review_summary.json', { recorded_sample: true, note: NOT_RUN }),
      ].join('\n');
    default:
      return 'OK';
  }
}

export function replayResponse(request: { path: string; body?: unknown; stage?: SimStage }): Response {
  const response = simulateOtariResponse({ method: 'POST', ...request, recordedText: recordedText(request.stage, request.body) });
  // No provider served this, no guardrail evaluated it and no container ran, so none is reported.
  const headers = new Headers(response.headers);
  for (const name of ['Otari-Provider', 'Otari-Fallback', 'Otari-Attempt-Count', 'Otari-Guardrails', 'Otari-Container-Id', 'X-Otari-Container-Id', 'Otari-Container-Expires-At', 'Otari-Simulated', 'Otari-Request-ID']) {
    headers.delete(name);
  }
  return new Response(response.body, { status: response.status, headers });
}
