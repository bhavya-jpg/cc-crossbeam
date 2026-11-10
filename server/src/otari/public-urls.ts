/**
 * Where the gateway can reach this server's MCP and guardrail routes.
 *
 * OTARI_PUBLIC_TOOLS_URL is the public base of the tools listener (port 8090 locally, see
 * scripts/tunnel.sh), e.g. https://abc.trycloudflare.com. OTARI_MCP_PUBLIC_URL and
 * OTARI_GUARDRAIL_URL override the two full URLs. A localhost URL counts as unreachable,
 * since the gateway can't call it, and the runner then uses its local fallbacks.
 */

export const MCP_PATH = '/api/mcp/adu-law';
export const GUARDRAIL_PATH = '/api/guardrails/check';

function parsePublic(value: string | undefined): URL | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.local');
  return isLocal ? null : url;
}

function fromBase(path: string): string | null {
  const base = parsePublic(process.env.OTARI_PUBLIC_TOOLS_URL);
  return base ? `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}` : null;
}

/** The MCP URL, if the gateway could reach it. Docs require https when a token is sent. */
export function reachableMcpUrl(): string | null {
  const configured = process.env.OTARI_MCP_PUBLIC_URL;
  const url = configured ? (parsePublic(configured) ? configured : null) : fromBase(MCP_PATH);
  if (!url) return null;
  if (process.env.MCP_ADU_LAW_TOKEN && new URL(url).protocol !== 'https:') return null;
  return url;
}

/** The guardrail service URL, if the gateway could reach it. A request-body `url` must be https. */
export function reachableGuardrailUrl(): string | null {
  const configured = process.env.OTARI_GUARDRAIL_URL;
  const url = configured ? (parsePublic(configured) ? configured : null) : fromBase(GUARDRAIL_PATH);
  return url && new URL(url).protocol === 'https:' ? url : null;
}
