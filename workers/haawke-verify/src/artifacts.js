/**
 * Additive route adapter for the EXISTING Haawke Verify worker.
 * Not an MCP implementation and not a new registry/hash implementation.
 * Dependencies are the worker's existing sha256HexOfString and handleRegister.
 */
const LIMIT = 128000;
const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key));
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
function tokenMatches(actual, expected) {
  if (typeof expected !== 'string' || expected.length < 32 || typeof actual !== 'string') return false;
  const wanted = `Bearer ${expected}`;
  let difference = actual.length ^ wanted.length;
  for (let i = 0; i < wanted.length; i++) difference |= (actual.charCodeAt(i) || 0) ^ wanted.charCodeAt(i);
  return difference === 0;
}
async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_INPUT');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > LIMIT) { await reader.cancel(); throw new Error('TOO_LARGE'); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
export async function handleArtifacts(request, env, { hashText, register, verify }) {
  // Dedicated service credential, never a client/Clerk/provider token. Fail closed if unset.
  if (!tokenMatches(request.headers.get('authorization'), env.HAAWKE_ARTIFACT_SERVICE_TOKEN)) return reply({ error: { code: 'AUTHORIZATION_FAILED' } }, 401);
  if (request.method !== 'POST') return reply({ error: { code: 'METHOD_NOT_ALLOWED' } }, 405);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: { code: 'INVALID_INPUT' } }, 415);
  const operation = new URL(request.url).pathname;
  if (!['/v1/artifacts/hash', '/v1/artifacts/seal'].includes(operation)) return reply({ error: { code: 'NOT_FOUND' } }, 404);
  let body;
  try { body = await readBody(request); }
  catch (error) { return reply({ error: { code: 'INVALID_INPUT' } }, error.message === 'TOO_LARGE' ? 413 : 400); }
  const sealing = operation.endsWith('/seal');
  const keys = sealing ? ['content', 'content_type', 'title', 'metadata', 'request_id', 'provenance'] : ['content', 'content_type'];
  if (!exactKeys(body, keys) || body.content_type !== 'text/plain' || typeof body.content !== 'string' || !body.content.length || body.content.length > 60000 || !body.content.isWellFormed() || new TextEncoder().encode(body.content).length > 120000) return reply({ error: { code: 'INVALID_INPUT' } }, 400);
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 160)) return reply({ error: { code: 'INVALID_INPUT' } }, 400);
  if (body.metadata !== undefined && (!exactKeys(body.metadata, ['source']) || (body.metadata.source !== undefined && !['user-supplied', 'chatgpt', 'codex'].includes(body.metadata.source)))) return reply({ error: { code: 'INVALID_INPUT' } }, 400);
  if (sealing && (typeof body.request_id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.request_id))) return reply({ error: { code: 'INVALID_INPUT' } }, 400);

  const provenance = body.provenance;
  const publicLabel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ./_:+()-]{0,159}$/.test(value);
  if (provenance !== undefined && (!exactKeys(provenance, ['model', 'provider', 'session_type']) || !publicLabel(provenance.model) || !publicLabel(provenance.provider) || !['human-initiated', 'autonomous'].includes(provenance.session_type))) return reply({ error: { code: 'INVALID_INPUT' } }, 400);

  // Exact UTF-8 follows the existing mcpSeal()/handleApiHash() policy: no trimming,
  // Unicode normalization, newline replacement, or JSON serialization of the artifact.
  const sha256 = await hashText(body.content);
  if (!sealing) return reply({ sha256, canonicalization: 'haawke-utf8-exact-v1' });
  // Explicit allowlist. Raw content, private titles, client identities, request IDs,
  // arbitrary metadata and authorization headers cannot reach the registry payload.
  const payload = {
    content: { output_hash: sha256, filename: 'sealed-text.txt', media_type: 'text/plain', provenance_note: 'User-requested text seal through Haawke. Exact UTF-8 artifact; no assertion of authorship or factual correctness.' },
    identity: { author: 'Haawke artifact service', org: 'Haawke', session_type: provenance?.session_type || 'api' },
    ...(provenance ? { anthropic: { model: provenance.model, api_endpoint: provenance.provider, tool_surface: 'Phoenix generation' } } : {}),
    environment: { platform: 'Haawke artifact API' },
  };
  try {
    const response = await register(new Request(new URL('/register', request.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), env);
    if (!response.ok) return reply({ sha256, status: 'PROVENANCE_FAILED', verification_url: null });
    const result = await response.json();
    if (!['registered', 'exists'].includes(result.status)) return reply({ sha256, status: 'PROVENANCE_FAILED', verification_url: null });
    // Obtain the canonical record URL from the existing Verify handler rather
    // than inventing a client-side URL. Registration alone is not VERIFIED.
    const lookupUrl = new URL(`/verify/${sha256}`, request.url);
    const lookup = await verify(sha256, lookupUrl, new Request(lookupUrl, { headers: { Accept: 'application/json' } }), env);
    if (!lookup.ok) return reply({ sha256, status: 'PROVENANCE_PENDING', verification_url: null });
    const found = await lookup.json();
    if (found.sha256 !== sha256 || typeof found.verify_url !== 'string') return reply({ sha256, status: 'PROVENANCE_PENDING', verification_url: null });
    return reply({ sha256, status: result.status === 'exists' ? 'EXISTS' : 'REGISTERED', verification_url: found.verify_url });
  } catch { return reply({ sha256, status: 'PROVENANCE_PENDING', verification_url: null }); }
}
