// Haawke Hash — Provenance Registry — SCHEMA v2.0 (staging)
// Cloudflare Worker · haawke-verify-staging
// Implements: Haawke Provenance Record Implementation Spec v2.0 (2026-08-11),
// corrected per the four issues flagged before build (see commit message /
// PR description): session_id is local-client/unverified (not Anthropic-
// issued), model/token_count sourced from transcript JSONL (not API
// headers), model_card_url uses a family mapping (not raw substitution),
// and the chain (sequence_number + previous_seal_hash) is made genuinely
// atomic via a Durable Object rather than best-effort KV increments.
//
// record_hash design note: it seals {content, identity, anthropic, chain,
// environment, timestamp, verification.qr_payload, verification.model_card_url}
// — it deliberately does NOT cover `anchor`, because anchor.ots_status /
// anchor.bitcoin_block / anchor.ots_receipt are filled in asynchronously
// after registration (Bitcoin confirmation can take ~24h). Their own
// integrity comes from the OTS calendar + Bitcoin blockchain, independent
// of record_hash. This keeps record_hash valid forever from the moment of
// sealing, while anchor fields can still be patched post-confirmation.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

// OpenTimestamps file magic header
const OTS_MAGIC = new Uint8Array([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d,
  0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
  0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf,
  0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94
]);

const CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
  'https://ots.btc.catallaxy.com/calendar',
];

function buildOtsFile(hashBytes, calendarData) {
  const out = new Uint8Array(OTS_MAGIC.length + 1 + 1 + 32 + calendarData.byteLength);
  let offset = 0;
  out.set(OTS_MAGIC, offset);           offset += OTS_MAGIC.length;
  out[offset] = 0x01;                   offset++;
  out[offset] = 0x08;                   offset++;
  out.set(hashBytes, offset);           offset += 32;
  out.set(new Uint8Array(calendarData), offset);
  return out;
}

// ─── Model family mapping (verified against anthropic.com/claude/* pages —
// individual version strings like "claude-sonnet-5" are NOT valid paths,
// only the family slug is: /claude/sonnet, /claude/opus, /claude/haiku) ───
function modelCardUrl(model) {
  if (!model || typeof model !== 'string') return null;
  const m = model.toLowerCase();
  if (m.includes('sonnet')) return 'https://www.anthropic.com/claude/sonnet';
  if (m.includes('opus'))   return 'https://www.anthropic.com/claude/opus';
  if (m.includes('haiku'))  return 'https://www.anthropic.com/claude/haiku';
  return null; // unknown family — omit rather than guess a URL that may 404
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256HexOfString(str) {
  return sha256Hex(new TextEncoder().encode(str));
}

const HEX64 = /^[0-9a-f]{64}$/;

// ─── Dual-read KV compat ─────────────────────────────────────────────────
// The pre-2.0 worker stored records under the raw hash as the KV key
// ({hash} -> record). Schema v2.0 stores under `record:{hash}` instead.
// Reads try the new key first, then fall back to the old one, so existing
// production records stay resolvable without being touched or migrated.
// New writes always go to `record:{hash}` only — existing keys are never
// written to, moved, or deleted.
async function getRecordDualRead(env, hash) {
  const v2Raw = await env.PROVENANCE.get(`record:${hash}`);
  if (v2Raw) return { raw: v2Raw, record: JSON.parse(v2Raw), legacy: false };

  const legacyRaw = await env.PROVENANCE.get(hash);
  if (legacyRaw) return { raw: legacyRaw, record: JSON.parse(legacyRaw), legacy: true };

  return null;
}

export class SequenceCounter {
  constructor(state) {
    this.state = state;
  }

  // POST /commit — the single serialization point for the whole chain.
  // Body: the fully-assembled record minus chain.sequence_number,
  // chain.previous_seal_hash, and verification.record_hash.
  // Returns: { sequence_number, previous_seal_hash, record_hash, record }
  // All of this runs inside one DO request — Workers Durable Objects
  // process one request at a time per instance, so this is genuinely
  // atomic. No other caller can observe or interleave with a half-updated
  // sequence/head state.
  async fetch(request) {
    const url = new URL(request.url);

    // GET /state — authoritative latest sequence number + head hash.
    // KV mirrors of this (e.g. a `chain:latest` key) are NOT safe to read
    // for this purpose: concurrent requests' KV writes aren't ordered, so
    // a lower-sequence request's write can land after a higher one's and
    // silently under-report the latest count. The DO's own storage is the
    // only place this is race-free.
    if (url.pathname === '/state' && request.method === 'GET') {
      const seqRaw = await this.state.storage.get('seq');
      const headRaw = await this.state.storage.get('head_hash');
      return json({
        sequence_number: (typeof seqRaw === 'number') ? seqRaw : 0,
        head_hash: headRaw || null,
      });
    }

    if (url.pathname !== '/commit' || request.method !== 'POST') {
      return json({ error: 'not found' }, 404);
    }

    const partial = await request.json();

    const seqRaw = await this.state.storage.get('seq');
    const headRaw = await this.state.storage.get('head_hash');
    const seq = (typeof seqRaw === 'number') ? seqRaw : 0;
    const previousSealHash = (seq === 0) ? null : (headRaw || null);
    const sequenceNumber = seq + 1;

    partial.chain = {
      ...partial.chain,
      sequence_number: sequenceNumber,
      previous_seal_hash: previousSealHash,
    };

    // qr_payload depends on sequence_number, which is only known once we're
    // inside this atomic commit — build it here, before hashing, so it's
    // part of the sealed record rather than patched on afterward (a patch
    // would make record_hash mismatch the stored record).
    const sessionIdForQr = (partial.anthropic && partial.anthropic.session_id) || '';
    const qrPayload = `https://verify.haawke.com/verify/${partial.content.output_hash}?session=${sessionIdForQr}&seq=${sequenceNumber}`;

    partial.verification = { ...partial.verification, qr_payload: qrPayload, record_hash: '' };

    // record_hash excludes `anchor` — see file header note.
    const { anchor, ...toHash } = partial;
    const canonical = JSON.stringify(toHash);
    const recordHash = await sha256HexOfString(canonical);

    partial.verification.record_hash = recordHash;
    partial.anchor = anchor;

    await this.state.storage.put('seq', sequenceNumber);
    await this.state.storage.put('head_hash', recordHash);

    return json({
      sequence_number: sequenceNumber,
      previous_seal_hash: previousSealHash,
      record_hash: recordHash,
      record: partial,
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/ots' && request.method === 'POST') {
      return handleOTS(request);
    }
    if (path === '/register' && request.method === 'POST') {
      return handleRegister(request, env);
    }
    if (path.startsWith('/verify/') && request.method === 'GET') {
      const hash = path.replace('/verify/', '').trim();
      return handleVerify(hash, url, env);
    }
    if (path === '/recent' && request.method === 'GET') {
      return handleRecent(url, env);
    }
    if (path === '/chain' && request.method === 'GET') {
      return handleChain(env);
    }
    if (path.startsWith('/session/') && request.method === 'GET') {
      const sessionId = path.replace('/session/', '').trim();
      return handleSession(sessionId, env);
    }
    if (path.startsWith('/model/') && request.method === 'GET') {
      const model = decodeURIComponent(path.replace('/model/', '').trim());
      return handleModel(model, env);
    }
    if (path === '/ots/confirm' && request.method === 'POST') {
      return handleOtsConfirm(request, env);
    }
    if (path === '/ots/tag' && request.method === 'POST') {
      return handleOtsTag(request, env);
    }
    if (path === '/' || path === '') {
      return json({
        name: 'Haawke Provenance Registry',
        version: '2.0',
        schema: 'https://github.com/inoculate23/hash.haawke.com — Provenance Record Implementation Spec v2.0',
        org: 'Haawke Neural Technology',
        endpoints: {
          verify: 'GET /verify/[sha256hash]?session=[session_id]',
          register: 'POST /register',
          recent: 'GET /recent?limit=20',
          chain: 'GET /chain',
          session: 'GET /session/[session_id]',
          model: 'GET /model/[model_string]',
          ots: 'POST /ots',
          ots_confirm: 'POST /ots/confirm  (secret-protected)',
          ots_tag: 'POST /ots/tag  (secret-protected)',
        },
        tool: 'https://hash.haawke.com',
      });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};

async function handleOTS(request) {
  try {
    const body = await request.arrayBuffer();
    const hashBytes = new Uint8Array(body);

    if (hashBytes.length !== 32) {
      return json({ error: 'Expected 32-byte SHA-256 hash' }, 400);
    }

    let calendarData = null;
    let calendarUsed = null;

    for (const calendar of CALENDARS) {
      try {
        const resp = await fetch(`${calendar}/digest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: body,
        });
        if (resp.ok) {
          calendarData = await resp.arrayBuffer();
          calendarUsed = calendar.replace('https://', '').split('/')[0];
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!calendarData) {
      return json({ error: 'All OTS calendars unavailable' }, 502);
    }

    const otsFile = buildOtsFile(hashBytes, calendarData);

    return new Response(otsFile, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="proof.ots"',
        'X-OTS-Calendar': calendarUsed,
      },
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ─── /register — schema v2.0 ────────────────────────────────────────────
async function handleRegister(request, env) {
  try {
    const body = await request.json();
    const { content, identity, anthropic, environment, timestamp } = body;

    if (!content || !content.output_hash || !HEX64.test(content.output_hash)) {
      return json({ error: 'content.output_hash is required — must be 64 character SHA-256' }, 400);
    }
    if (content.input_hash && !HEX64.test(content.input_hash)) {
      return json({ error: 'content.input_hash must be a 64 character SHA-256 if present' }, 400);
    }

    const outputHash = content.output_hash;

    const existing = await getRecordDualRead(env, outputHash);
    if (existing) {
      return json({
        status: 'exists',
        message: existing.legacy
          ? 'This hash is already registered (pre-2.0 record). First record preserved.'
          : 'This hash is already registered. First record preserved.',
        record: existing.record,
      });
    }

    if (!identity || !identity.author) {
      return json({ error: 'identity.author is required' }, 400);
    }
    const track = identity.orcid ? 1 : 2;
    if (identity.track && identity.track !== track) {
      return json({ error: `identity.track (${identity.track}) inconsistent with orcid presence (expected track ${track})` }, 400);
    }

    const registeredAt = new Date().toISOString();

    const sessionId = (anthropic && anthropic.session_id) || null;
    const model = (anthropic && anthropic.model) || null;

    // Partial record — chain + verification.record_hash filled in by the
    // Durable Object, which is the single atomic serialization point.
    const partial = {
      schema_version: '2.0',
      content: {
        output_hash: outputHash,
        input_hash: content.input_hash || null,
        token_count: Number.isFinite(content.token_count) ? content.token_count : null,
        filename: content.filename || 'unknown',
      },
      identity: {
        author: identity.author,
        orcid: identity.orcid || null,
        org: identity.org || 'Haawke Neural Technology',
        session_type: identity.session_type || (identity.orcid ? 'human-initiated' : 'autonomous'),
        track,
      },
      anthropic: {
        session_id: sessionId,
        session_id_source: sessionId ? 'local-client, unverified' : null,
        model,
        api_endpoint: (anthropic && anthropic.api_endpoint) || null,
        tool_surface: (anthropic && anthropic.tool_surface) || null,
      },
      chain: {
        parent_session_id: (body.chain && body.chain.parent_session_id) || null,
      },
      environment: {
        platform: (environment && environment.platform) || null,
        tool_version: (environment && environment.tool_version) || null,
        sealing_machine: (environment && environment.sealing_machine) || null,
      },
      timestamp: {
        registered_at: registeredAt,
        local_log_at: (timestamp && timestamp.local_log_at) || null,
        bitcoin_submitted_at: null,
      },
      anchor: {
        ots_status: 'pending',
        bitcoin_block: null,
        ots_receipt: null,
        registry: 'https://verify.haawke.com',
      },
      verification: {
        record_hash: null,
        qr_payload: null,
        model_card_url: modelCardUrl(model),
      },
    };

    const doId = env.SEQUENCER.idFromName('global');
    const stub = env.SEQUENCER.get(doId);
    const commitResp = await stub.fetch('http://do/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    if (!commitResp.ok) {
      return json({ error: 'Sequencer commit failed' }, 502);
    }
    const { sequence_number, previous_seal_hash, record_hash, record } = await commitResp.json();

    // Persist. The DO already made {sequence_number, previous_seal_hash,
    // record_hash} correct and race-free — these KV writes are just
    // secondary indexes for lookup, not the source of chain truth.
    await env.PROVENANCE.put(`record:${outputHash}`, JSON.stringify(record));
    await env.PROVENANCE.put(`seq:${sequence_number}`, outputHash);
    if (sessionId) {
      await env.PROVENANCE.put(`session:${sessionId}`, outputHash);
    }
    if (model) {
      // Best-effort display counter, not a security claim — read-then-write
      // on KV can under-count by a handful under heavy concurrency. Unlike
      // the chain, nothing depends on this being exact.
      const countKey = `model:${model}:count`;
      const countRaw = await env.PROVENANCE.get(countKey);
      const count = (parseInt(countRaw, 10) || 0) + 1;
      await env.PROVENANCE.put(countKey, String(count));
    }

    const recentsRaw = await env.PROVENANCE.get('__recents__');
    const recents = recentsRaw ? JSON.parse(recentsRaw) : [];
    recents.unshift({
      hash: outputHash,
      filename: record.content.filename,
      author: record.identity.author,
      org: record.identity.org,
      session_type: record.identity.session_type,
      model: record.anthropic.model,
      sequence_number,
      registered: record.timestamp.registered_at,
    });
    if (recents.length > 100) recents.pop();
    await env.PROVENANCE.put('__recents__', JSON.stringify(recents));

    return json({
      status: 'registered',
      message: 'Provenance record created.',
      record,
    }, 201);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ─── /verify/[hash] — schema v2.0, dual-read for pre-2.0 records ────────
async function handleVerify(hash, url, env) {
  if (!hash || !HEX64.test(hash)) {
    return json({ error: 'Invalid hash format' }, 400);
  }

  const found = await getRecordDualRead(env, hash);
  if (!found) {
    return json({
      status: 'not_found',
      hash,
      registered: false,
      message: 'No provenance record found for this hash.',
    }, 404);
  }

  if (found.legacy) {
    return handleVerifyLegacy(found.record);
  }

  const record = found.record;

  const otsStatus = record.anchor.ots_status || 'pending';
  let otsPendingHours = null;
  let otsPendingMessage = null;
  if (otsStatus === 'pending' && record.timestamp.registered_at) {
    const elapsedMs = Date.now() - new Date(record.timestamp.registered_at).getTime();
    otsPendingHours = Math.round(elapsedMs / 3600000 * 10) / 10;
    otsPendingMessage = `Submitted to Bitcoin calendars, awaiting block confirmation (typically within 24h). Pending ${otsPendingHours}h.`;
  }

  // Recompute record_hash the same way the DO did, so the API can tell
  // the caller directly whether the record is self-consistent (spec
  // verification step 2), without them having to reimplement the
  // canonicalization rule.
  const { anchor, ...toHash } = record;
  const hashCheckObj = { ...toHash, verification: { ...toHash.verification, record_hash: '' } };
  const recomputed = await sha256HexOfString(JSON.stringify(hashCheckObj));
  const recordHashValid = recomputed === record.verification.record_hash;

  let sessionMatch = null;
  const sessionParam = url.searchParams.get('session');
  if (sessionParam !== null) {
    sessionMatch = sessionParam === record.anthropic.session_id;
  }

  return json({
    status: 'verified',
    ...record,
    registered: true,
    record_hash_valid: recordHashValid,
    session_match: sessionMatch,
    ots_pending_hours: otsPendingHours,
    ots_pending_message: otsPendingMessage,
  });
}

// Pre-2.0 flat record — same response shape the old worker returned, so
// the existing verify.haawke.com legacy renderer (already deployed on the
// provenance-v2 branch, schema_version-gated) keeps working unmodified.
function handleVerifyLegacy(record) {
  const otsStatus = record.ots_status || 'pending';
  let otsPendingHours = null;
  let otsPendingMessage = null;
  if (otsStatus === 'pending' && record.registered) {
    const elapsedMs = Date.now() - new Date(record.registered).getTime();
    otsPendingHours = Math.round(elapsedMs / 3600000 * 10) / 10;
    otsPendingMessage = `Submitted to Bitcoin calendars, awaiting block confirmation (typically within 24h). Pending ${otsPendingHours}h.`;
  }

  return json({
    status: 'verified',
    ...record,
    registered: true,
    registered_at: record.registered,
    ots_status: otsStatus,
    bitcoin_block: record.bitcoin_block || null,
    ots_pending_hours: otsPendingHours,
    ots_pending_message: otsPendingMessage,
  });
}

async function handleRecent(url, env) {
  let limit = parseInt(url.searchParams.get('limit'), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;

  const recentsRaw = await env.PROVENANCE.get('__recents__');
  const recents = recentsRaw ? JSON.parse(recentsRaw) : [];
  const records = recents.slice(0, limit);

  return json({ status: 'ok', count: records.length, records });
}

// ─── /chain — sequence + gap detection ──────────────────────────────────
async function handleChain(env) {
  // Ask the Durable Object directly — it's the only race-free source for
  // "how many sequence numbers have actually been issued." A KV mirror
  // written per-request would under-report under concurrency, since
  // concurrent requests' KV writes aren't ordered relative to each other.
  const doId = env.SEQUENCER.idFromName('global');
  const stub = env.SEQUENCER.get(doId);
  const stateResp = await stub.fetch('http://do/state');
  const { sequence_number: latestSeq } = await stateResp.json();

  const gaps = [];
  let latestHash = null;
  // Bounded scan — fine at current record volumes; if this ever needs to
  // scale past a few thousand seals, replace with a maintained gap index.
  for (let n = 1; n <= latestSeq; n++) {
    const hash = await env.PROVENANCE.get(`seq:${n}`);
    if (!hash) gaps.push(n);
    else if (n === latestSeq) latestHash = hash;
  }

  return json({
    status: 'ok',
    latest_sequence_number: latestSeq,
    latest_output_hash: latestHash,
    chain_unbroken: gaps.length === 0,
    gaps,
  });
}

async function handleSession(sessionId, env) {
  if (!sessionId) {
    return json({ error: 'session_id required' }, 400);
  }
  const hash = await env.PROVENANCE.get(`session:${sessionId}`);
  if (!hash) {
    return json({ status: 'not_found', session_id: sessionId }, 404);
  }
  const raw = await env.PROVENANCE.get(`record:${hash}`);
  return json({ status: 'ok', session_id: sessionId, record: raw ? JSON.parse(raw) : null });
}

async function handleModel(model, env) {
  if (!model) {
    return json({ error: 'model required' }, 400);
  }
  const countRaw = await env.PROVENANCE.get(`model:${model}:count`);
  const count = parseInt(countRaw, 10) || 0;

  // Best-effort listing — filters the recents cache rather than a full KV
  // scan. Records that have aged out of __recents__ (>100 back) won't
  // appear here; the count above is still exact.
  const recentsRaw = await env.PROVENANCE.get('__recents__');
  const recents = recentsRaw ? JSON.parse(recentsRaw) : [];
  const records = recents.filter(r => r.model === model);

  return json({ status: 'ok', model, count, records });
}

// Statuses that /ots/tag may set — never 'confirmed' (that goes through /ots/confirm with a block)
const TAGGABLE_STATUSES = new Set(['legacy_unparseable', 'stamp_failed', 'pending']);

async function handleOtsTag(request, env) {
  try {
    const authHeader = request.headers.get('X-Confirm-Secret') || '';
    if (!env.OTS_CONFIRM_SECRET || authHeader !== env.OTS_CONFIRM_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const body = await request.json();
    const { hash, ots_status, note } = body;

    if (!hash || !HEX64.test(hash)) {
      return json({ error: 'Invalid hash — must be 64 character SHA-256' }, 400);
    }
    if (!TAGGABLE_STATUSES.has(ots_status)) {
      return json({ error: `Invalid ots_status. Allowed: ${[...TAGGABLE_STATUSES].join(', ')}` }, 400);
    }

    const raw = await env.PROVENANCE.get(`record:${hash}`);
    if (!raw) {
      return json({ error: 'Hash not found in registry' }, 404);
    }

    const record = JSON.parse(raw);
    const prev = record.anchor.ots_status;
    record.anchor.ots_status = ots_status;
    if (note) record.anchor.ots_tag_note = note;
    record.anchor.ots_tagged_at = new Date().toISOString();
    await env.PROVENANCE.put(`record:${hash}`, JSON.stringify(record));

    console.log(`[OTS-TAG] hash=${hash.slice(0, 16)} ${prev} → ${ots_status}`);

    return json({ status: 'tagged', hash, ots_status, prev_status: prev, note: note || null });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleOtsConfirm(request, env) {
  try {
    const authHeader = request.headers.get('X-Confirm-Secret') || '';
    if (!env.OTS_CONFIRM_SECRET || authHeader !== env.OTS_CONFIRM_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const body = await request.json();
    const { hash, bitcoin_block, ots_receipt } = body;

    if (!hash || !HEX64.test(hash)) {
      return json({ error: 'Invalid hash — must be 64 character SHA-256' }, 400);
    }
    if (!bitcoin_block || typeof bitcoin_block !== 'number') {
      return json({ error: 'bitcoin_block must be a number' }, 400);
    }

    const raw = await env.PROVENANCE.get(`record:${hash}`);
    if (!raw) {
      return json({ error: 'Hash not found in registry' }, 404);
    }

    const record = JSON.parse(raw);
    if (record.anchor.ots_status === 'confirmed') {
      return json({
        status: 'already_confirmed',
        bitcoin_block: record.anchor.bitcoin_block,
        message: 'Record was already confirmed — no change made.',
      });
    }

    record.anchor.ots_status = 'confirmed';
    record.anchor.bitcoin_block = bitcoin_block;
    if (ots_receipt) record.anchor.ots_receipt = ots_receipt;
    record.timestamp.bitcoin_submitted_at = new Date().toISOString();
    await env.PROVENANCE.put(`record:${hash}`, JSON.stringify(record));

    console.log(`[OTS-CONFIRM] hash=${hash.slice(0, 16)} block=${bitcoin_block}`);

    return json({
      status: 'confirmed',
      hash,
      bitcoin_block,
      bitcoin_submitted_at: record.timestamp.bitcoin_submitted_at,
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
