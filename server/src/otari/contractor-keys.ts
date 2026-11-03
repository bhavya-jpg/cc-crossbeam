/**
 * Which Otari key a run uses and how the Inspector names it.
 *
 * Only labels leave the server. Raw keys stay in the environment and are never written
 * to messages, telemetry or API responses.
 */

export type KeySource = 'contractor' | 'workspace' | 'simulated';

const DEFAULT_CONTRACTOR_LABEL = 'vk_contractor_placentia_01';
const DEFAULT_CAP_USD = 5;

export function contractorKey(): string | null {
  return process.env.OTARI_CONTRACTOR_KEY || null;
}

export function describeKey(
  apiKey: string | null | undefined,
  simulated: boolean,
  labelOverride?: string,
): { label: string; source: KeySource } {
  if (simulated) return { label: labelOverride ?? DEFAULT_CONTRACTOR_LABEL, source: 'simulated' };
  if (apiKey) return { label: labelOverride ?? (process.env.OTARI_CONTRACTOR_KEY_LABEL || DEFAULT_CONTRACTOR_LABEL), source: 'contractor' };
  return { label: 'Workspace key (OTARI_API_KEY)', source: 'workspace' };
}

export function contractorBudgetCapUsd(): number {
  const configured = Number(process.env.OTARI_CONTRACTOR_BUDGET_USD);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CAP_USD;
}
