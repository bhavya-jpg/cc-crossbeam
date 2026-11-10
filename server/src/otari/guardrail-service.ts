/**
 * A guardrails service the Otari gateway can call, at /api/guardrails/check.
 *
 * otari.ai has no guardrails service of its own (OTARI_FRICTION_LOG.md, finding 7), so a
 * request can name one with `url` on its guardrail entry. This one speaks the documented
 * contract:
 *
 *   POST /validate  {"profile": "...", "input_text": "...", "validate_kwargs": {...}}
 *   → {"profile": "...", "result": {"valid": false, "explanation": "...", "score": 0.9}}
 *
 * The docs don't say whether the gateway appends /validate to the URL, so the route
 * answers on both. It serves one profile, `prompt-injection`, using pattern rules for
 * common injection phrasing. That is a deliberately small detector, not a model: it
 * flags the obvious attacks and says which rule matched.
 */

import { Router } from 'express';
import { z } from 'zod';

export const GUARDRAIL_PROFILE = 'prompt-injection';

const RULES: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'override-instructions',
    pattern: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the|system)\b[^.\n]{0,25}\b(instructions?|prompts?|rules|directions|guidelines)\b/i,
  },
  {
    name: 'reveal-system-prompt',
    pattern: /\b(print|reveal|show|repeat|output|leak|display|tell me)\b[^.\n]{0,30}\b(system prompt|hidden (instructions|prompt)|initial instructions|developer message)\b/i,
  },
  { name: 'role-hijack', pattern: /\b(you are now|from now on,? you are|act as an? (unrestricted|jailbroken|unfiltered))\b|\bDAN mode\b/i },
  { name: 'injected-instructions', pattern: /(^|\n)\s*(new|updated|real) instructions?\s*:/i },
  { name: 'chat-template-markers', pattern: /<\|im_start\|>|<\|im_end\|>|\[\/?INST\]|<\/?(system|assistant)>/i },
];

export interface InjectionVerdict {
  valid: boolean;
  score: number;
  explanation: string | null;
}

export function detectInjection(text: string): InjectionVerdict {
  const matched = RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.name);
  if (matched.length === 0) return { valid: true, score: 0.02, explanation: null };
  return {
    valid: false,
    score: Math.min(0.99, 0.75 + 0.1 * matched.length),
    explanation: `Matched prompt-injection rules: ${matched.join(', ')}`,
  };
}

const validateRequest = z.object({
  profile: z.string(),
  input_text: z.string(),
  validate_kwargs: z.record(z.unknown()).optional(),
});

export const guardrailRouter = Router();

guardrailRouter.post(['/', '/validate'], (req, res) => {
  const parsed = validateRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ detail: 'Expected {"profile": string, "input_text": string}' });
    return;
  }
  const { profile, input_text } = parsed.data;
  if (profile !== GUARDRAIL_PROFILE) {
    res.status(404).json({ detail: `Unknown profile '${profile}'. This service serves '${GUARDRAIL_PROFILE}'.` });
    return;
  }
  res.json({ profile, result: detectInjection(input_text) });
});

guardrailRouter.get('/profiles', (_req, res) => {
  res.json([{ name: GUARDRAIL_PROFILE, guardrail_name: 'structura_pattern_rules' }]);
});
