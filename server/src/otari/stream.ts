/**
 * Rebuilds a complete response from an Otari server-sent event stream.
 *
 * otari.ai sits behind a CDN that ends any request with no response bytes after about
 * 30 seconds (an HTML 504 with no Otari-Request-ID, seen 2026-11-06). Long generations
 * therefore stream, and this turns the stream back into the JSON body the non-streamed
 * call would have returned, so callers don't change. The gateway's headers arrive
 * before the stream, except `Otari-Guardrails`, which streams don't carry.
 */

interface SseEvent {
  event: string | null;
  data: string;
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return events;
}

/** A failure the gateway reported inside a stream that had already started. */
export class StreamFailure extends Error {
  constructor(message: string, readonly code: string | null, readonly body: unknown) {
    super(message);
  }
}

function payloads(text: string): Array<{ event: string | null; json: Record<string, unknown> }> {
  return parseSse(text)
    .filter((e) => e.data !== '[DONE]')
    .map((e) => {
      try {
        return { event: e.event, json: JSON.parse(e.data) as Record<string, unknown> };
      } catch {
        return null;
      }
    })
    .filter((e): e is { event: string | null; json: Record<string, unknown> } => e !== null);
}

function failure(json: Record<string, unknown>): StreamFailure | null {
  const error = (json.error ?? (json.response as Record<string, unknown> | undefined)?.error) as
    | { message?: unknown; code?: unknown }
    | string
    | undefined;
  if (!error) return null;
  const message = typeof error === 'string' ? error : typeof error.message === 'string' ? error.message : JSON.stringify(error);
  const code = typeof error === 'object' && typeof error.code === 'string' ? error.code : null;
  return new StreamFailure(message, code, json);
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Folds `chat.completion.chunk` events into one `chat.completion`. */
export function collectChatStream(text: string): Record<string, unknown> {
  const choices = new Map<number, {
    role: string;
    content: string;
    reasoning: string;
    finish: string | null;
    tools: Map<number, { id?: string; type: string; function: { name: string; arguments: string } }>;
  }>();
  let base: Record<string, unknown> = {};
  let usage: unknown;

  for (const { json } of payloads(text)) {
    const failed = failure(json);
    if (failed) throw failed;
    if (!base.id) base = { id: json.id, model: json.model, created: json.created };
    if (json.usage) usage = json.usage;
    for (const choice of (json.choices as Array<Record<string, unknown>> | undefined) ?? []) {
      const index = Number(choice.index ?? 0);
      const acc = choices.get(index) ?? { role: 'assistant', content: '', reasoning: '', finish: null, tools: new Map() };
      choices.set(index, acc);
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.role === 'string') acc.role = delta.role;
      if (typeof delta.content === 'string') acc.content += delta.content;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string') acc.reasoning += reasoning;
      for (const call of (delta.tool_calls as ToolCallDelta[] | undefined) ?? []) {
        const at = call.index ?? acc.tools.size;
        const tool = acc.tools.get(at) ?? { type: 'function', function: { name: '', arguments: '' } };
        acc.tools.set(at, tool);
        if (call.id) tool.id = call.id;
        if (call.type) tool.type = call.type;
        if (call.function?.name) tool.function.name += call.function.name;
        if (call.function?.arguments) tool.function.arguments += call.function.arguments;
      }
      if (typeof choice.finish_reason === 'string') acc.finish = choice.finish_reason;
    }
  }

  if (choices.size === 0) throw new StreamFailure('stream ended without a completion', null, text.slice(0, 2000));
  return {
    ...base,
    object: 'chat.completion',
    choices: [...choices.entries()].sort(([a], [b]) => a - b).map(([index, c]) => ({
      index,
      finish_reason: c.finish,
      message: {
        role: c.role,
        content: c.content,
        ...(c.reasoning ? { reasoning_content: c.reasoning } : {}),
        ...(c.tools.size > 0 ? { tool_calls: [...c.tools.entries()].sort(([a], [b]) => a - b).map(([, t]) => t) } : {}),
      },
    })),
    ...(usage ? { usage } : {}),
  };
}

const FINAL_RESPONSE_EVENTS = new Set(['response.completed', 'response.incomplete']);

/** Returns the full response object carried by the stream's final event. */
export function collectResponsesStream(text: string): Record<string, unknown> {
  let final: Record<string, unknown> | null = null;
  for (const { event, json } of payloads(text)) {
    const type = event ?? (json.type as string | undefined) ?? null;
    if (type === 'response.failed' || type === 'error') {
      throw failure(json) ?? new StreamFailure(`stream reported ${type}`, null, json);
    }
    if (type && FINAL_RESPONSE_EVENTS.has(type) && json.response) final = json.response as Record<string, unknown>;
  }
  if (!final) throw new StreamFailure('stream ended without response.completed', null, text.slice(0, 2000));
  return final;
}
