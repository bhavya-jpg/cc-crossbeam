/**
 * Per-call telemetry from the first fully live run through the Otari gateway: Phase 1 on
 * the Placentia project, 6 Nov 2026. Every figure is what the gateway reported on that run
 * (Otari-Model, Otari-Provider, usage.cost_usd, latency). The landing page plays it back;
 * nothing there is a live call.
 */
export const RUN = {
  label: 'Recorded from the live Otari run · 6 Nov 2026 · 1232 N Jefferson St, Placentia, CA',
  durationS: 747,
  items: 14,
}

export type StageId = 'extractor' | 'researcher' | 'analyst' | 'drafter'

export interface Call {
  /** Seconds after the run started that the call finished. */
  at: number
  latencyMs: number
  costUsd: number
  status: number
}

export interface Stage {
  id: StageId
  index: string
  title: string
  model: string
  provider: string
  job: string
  gateway: string[]
  calls: Call[]
}

export const STAGES: Stage[] = [
  {
    id: 'extractor',
    index: '01',
    title: 'Extractor',
    model: 'Qwen3-VL-235B-A22B',
    provider: 'deepinfra',
    job: 'Reads the scanned corrections letter and all 15 plan sheets as images.',
    gateway: ['Vision model through /chat/completions', 'Prompt-injection guardrail requested', 'Streamed past the CDN’s 30 s limit'],
    calls: [
      { at: 178, latencyMs: 177488, costUsd: 0.002377, status: 200 },
      { at: 326, latencyMs: 116746, costUsd: 0.002227, status: 200 },
      { at: 326, latencyMs: 117037, costUsd: 0.002231, status: 200 },
      { at: 393, latencyMs: 184034, costUsd: 0.00267, status: 200 },
    ],
  },
  {
    id: 'researcher',
    index: '02',
    title: 'Researcher',
    model: 'gpt-oss-120b',
    provider: 'deepinfra',
    job: 'Looks up Placentia’s ADU rules and the state law each item cites.',
    gateway: ['Asked for web search and fetch first', '2 × 403: tools off for the workspace', 'Fell back to verified local references'],
    calls: [
      { at: 395, latencyMs: 1746, costUsd: 0, status: 403 },
      { at: 395, latencyMs: 380, costUsd: 0, status: 403 },
      { at: 501, latencyMs: 105446, costUsd: 0.000874, status: 200 },
    ],
  },
  {
    id: 'analyst',
    index: '03',
    title: 'Analyst',
    model: 'DeepSeek-V4-Pro',
    provider: 'deepinfra',
    job: 'Checks setbacks, lot coverage and fee thresholds with real arithmetic.',
    gateway: ['otari_code_execution sandbox', 'Container otari_cntr_9b61… reused across 2 turns', 'Second turn verifies the first'],
    calls: [
      { at: 536, latencyMs: 34832, costUsd: 0.030903, status: 200 },
      { at: 565, latencyMs: 28929, costUsd: 0.021399, status: 200 },
    ],
  },
  {
    id: 'drafter',
    index: '04',
    title: 'Drafter',
    model: 'DeepSeek-V4-Pro',
    provider: 'deepinfra',
    job: 'Sorts every item and writes the questions only the contractor can answer.',
    gateway: ['Reads 28+ California ADU law references', 'Through MCP when the gateway can reach it', '4 auto-fixable · 3 for you · 5 for a professional'],
    calls: [
      { at: 569, latencyMs: 3696, costUsd: 0.034818, status: 200 },
      { at: 572, latencyMs: 3679, costUsd: 0.006996, status: 200 },
      { at: 576, latencyMs: 4012, costUsd: 0.010951, status: 200 },
      { at: 579, latencyMs: 3131, costUsd: 0.007222, status: 200 },
      { at: 746, latencyMs: 167078, costUsd: 0.083503, status: 200 },
    ],
  },
]

export const ALL_CALLS = STAGES.flatMap((stage) => stage.calls)

export const clock = (s: number) => `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`

export const RUN_FACTS = {
  items: RUN.items,
  calls: ALL_CALLS.length,
  costUsd: ALL_CALLS.reduce((sum, call) => sum + call.costUsd, 0),
  duration: clock(RUN.durationS),
}
