// --- Otari Models ---
// Each role tries its models in order. Override with OTARI_MODEL_<ROLE> and
// OTARI_MODEL_<ROLE>_FALLBACK; a routing policy name also works as a model.

function roleModels(role: string, primary: string, fallback: string): string[] {
  return [process.env[`OTARI_MODEL_${role}`] || primary, process.env[`OTARI_MODEL_${role}_FALLBACK`] || fallback];
}

export const OTARI_MODELS = {
  // The extractor reads plan images, so both of its models must accept image input.
  extractor: roleModels('EXTRACTOR', 'alibaba/qwen3-vl-235b-a22b-instruct', 'deepseek/deepseek-v4.1-flash'),
  researcher: roleModels('RESEARCHER', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'),
  analyst: roleModels('ANALYST', 'deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4.1-flash'),
  drafter: roleModels('DRAFTER', 'deepseek/deepseek-v4-pro-0813', 'moonshotai/kimi-k2.6'),
};

/** Used only when a response carries no `usage.cost_usd`. */
export const OTARI_COST_PER_1K = {
  input: Number(process.env.OTARI_FALLBACK_INPUT_USD_PER_1K) || 0.003,
  output: Number(process.env.OTARI_FALLBACK_OUTPUT_USD_PER_1K) || 0.015,
};

export const OTARI_REQUEST_TIMEOUT_MS = Number(process.env.OTARI_REQUEST_TIMEOUT_MS) || 290_000;

// --- Flow Types ---
// 'city-review' and 'corrections-analysis' are stored in projects.flow_type
// 'corrections-response' is an internal flow type for Phase 2 of the contractor flow
export type InternalFlowType = 'city-review' | 'corrections-analysis' | 'corrections-response';

// --- Budget per Flow ---

export const FLOW_BUDGET: Record<InternalFlowType, { maxTurns: number; maxBudgetUsd: number }> = {
  'city-review':          { maxTurns: 500, maxBudgetUsd: 50.00 },
  'corrections-analysis': { maxTurns: 500, maxBudgetUsd: 50.00 },
  'corrections-response': { maxTurns: 150, maxBudgetUsd: 20.00 },
};

// --- Onboarded Cities ---
// Cities with dedicated, verified skill data. These use offline reference files
// instead of web search — faster, more reliable, higher quality.
// Key: city slug (lowercase, hyphenated). Value: skill directory name.
export const ONBOARDED_CITIES: Record<string, string> = {
  'placentia': 'placentia-adu',
  'buena-park': 'buena-park-adu',
};

/** Normalize city name to slug for lookup */
export function citySlug(city: string): string {
  return city.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/** Check if a city has a dedicated skill */
export function isCityOnboarded(city: string): boolean {
  return citySlug(city) in ONBOARDED_CITIES;
}

/** Get the skill name for an onboarded city */
export function getCitySkillName(city: string): string | null {
  return ONBOARDED_CITIES[citySlug(city)] ?? null;
}

// --- Skills per Flow ---
// Returns the skill list dynamically based on flow type and city.
// City-review: NO web search — onboarded cities only, use dedicated skill.
// Corrections-analysis: web search available as fallback, but onboarded cities use dedicated skill.
// Corrections-response: no research needed — just generates deliverables.

export function getFlowSkills(flowType: InternalFlowType, city: string): string[] {
  const citySkill = getCitySkillName(city);

  if (flowType === 'city-review') {
    // NO adu-city-research — city review only works with onboarded cities
    const skills = [
      'california-adu',
      'adu-plan-review',
      'adu-targeted-page-viewer',
    ];
    if (citySkill) skills.push(citySkill);
    return skills;
  }

  if (flowType === 'corrections-analysis') {
    const skills = [
      'california-adu',
      'adu-corrections-flow',
      'adu-targeted-page-viewer',
    ];
    if (citySkill) {
      // Onboarded city — use dedicated skill, skip web search
      skills.push(citySkill);
    } else {
      // Non-onboarded city — need web search
      skills.push('adu-city-research');
    }
    return skills;
  }

  // corrections-response — no research, just deliverables
  const skills = [
    'california-adu',
    'adu-corrections-complete',
  ];
  if (citySkill) skills.push(citySkill);
  return skills;
}
