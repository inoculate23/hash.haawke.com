// Haawke Hash — Provenance Registry
// Cloudflare Worker · haawke-verify
// verify.haawke.com / haawke-verify.haawkeai.workers.dev
// Updated June 2026:
//   - /ots now returns valid .ots files (OTS magic header prepended)
//   - /register accepts type, prompt, timestamp fields
//   - /verify/[hash] returns ots_status + bitcoin_block + ots_pending_hours
//   - /recent supports ?limit=
//   - /ots/confirm patches KV with confirmed block (shared-secret protected)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

/**
 * Wrap raw calendar response into a valid .ots file.
 * Format: [magic][version=0x01][sha256_tag=0x08][32-byte digest][calendar body]
 */
function buildOtsFile(hashBytes, calendarData) {
  const out = new Uint8Array(
    OTS_MAGIC.length + 1 + 1 + 32 + calendarData.byteLength
  );
  let offset = 0;
  out.set(OTS_MAGIC, offset);           offset += OTS_MAGIC.length;
  out[offset] = 0x01;                   offset++;  // version varint
  out[offset] = 0x08;                   offset++;  // sha256 op tag
  out.set(hashBytes, offset);           offset += 32;
  out.set(new Uint8Array(calendarData), offset);
  return out;
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
      return handleVerify(hash, env);
    }
    if (path === '/recent' && request.method === 'GET') {
      return handleRecent(url, env);
    }
    if (path === '/ots/confirm' && request.method === 'POST') {
      return handleOtsConfirm(request, env);
    }
    if (path === '/ots/tag' && request.method === 'POST') {
      return handleOtsTag(request, env);
    }
    if (path === '/' || path === '') {
      return new Response(JSON.stringify({
        name: 'Haawke Provenance Registry',
        version: '1.2',
        author: 'Craig Ellenwood × Claude (Anthropic)',
        orcid: '0009-0001-6475-5109',
        org: 'Haawke Neural Technology',
        endpoints: {
          verify: 'GET /verify/[sha256hash]',
          register: 'POST /register',
          recent: 'GET /recent?limit=20',
          ots: 'POST /ots',
          ots_confirm: 'POST /ots/confirm  (secret-protected)',
          ots_tag: 'POST /ots/tag  (secret-protected)',
        },
        tool: 'https://hash.haawke.com',
      }, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
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
      return new Response(
        JSON.stringify({ error: 'Expected 32-byte SHA-256 hash' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
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
      return new Response(
        JSON.stringify({ error: 'All OTS calendars unavailable' }),
        { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
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
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleRegister(request, env) {
  try {
    const body = await request.json();
    const { hash, filename, author, orcid, org, source, type, prompt, timestamp } = body;

    if (!hash || hash.length !== 64) {
      return new Response(JSON.stringify({ error: 'Invalid hash — must be 64 character SHA-256' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const existing = await env.PROVENANCE.get(hash);
    if (existing) {
      const record = JSON.parse(existing);
      return new Response(JSON.stringify({
        status: 'exists',
        message: 'This hash is already registered. First record preserved.',
        record,
      }), {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const record = {
      hash,
      filename: filename || 'unknown',
      author: author || 'Anonymous',
      orcid: orcid || null,
      org: org || null,
      source: source || null,
      type: type || null,
      prompt: prompt || null,
      timestamp: timestamp || null,
      ots_status: 'pending',
      bitcoin_block: null,
      registered: new Date().toISOString(),
      tool: 'Haawke Hash v1.3',
      registry: 'https://verify.haawke.com',
    };

    await env.PROVENANCE.put(hash, JSON.stringify(record));

    const recentsRaw = await env.PROVENANCE.get('__recents__');
    const recents = recentsRaw ? JSON.parse(recentsRaw) : [];
    recents.unshift({
      hash,
      filename: record.filename,
      author: record.author,
      org: record.org,
      type: record.type,
      source: record.source,
      registered: record.registered,
    });
    if (recents.length > 100) recents.pop();
    await env.PROVENANCE.put('__recents__', JSON.stringify(recents));

    return new Response(JSON.stringify({
      status: 'registered',
      message: 'Provenance record created.',
      record,
    }), {
      status: 201,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleVerify(hash, env) {
  if (!hash || hash.length !== 64) {
    return new Response(JSON.stringify({ error: 'Invalid hash format' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const raw = await env.PROVENANCE.get(hash);
  if (!raw) {
    return new Response(JSON.stringify({
      status: 'not_found',
      hash,
      registered: false,
      message: 'No provenance record found for this hash.',
    }), {
      status: 404,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const record = JSON.parse(raw);
  const otsStatus = record.ots_status || 'pending';

  let otsPendingHours = null;
  let otsPendingMessage = null;
  if (otsStatus === 'pending' && record.registered) {
    const elapsedMs = Date.now() - new Date(record.registered).getTime();
    otsPendingHours = Math.round(elapsedMs / 3600000 * 10) / 10;
    otsPendingMessage = `Submitted to Bitcoin calendars, awaiting block confirmation (typically within 24h). Pending ${otsPendingHours}h.`;
    if (otsPendingHours >= 48) {
      console.warn(`[OTS-STALE] hash=${hash.slice(0, 16)} pending ${otsPendingHours}h since ${record.registered}`);
    }
  }

  return new Response(JSON.stringify({
    status: 'verified',
    ...record,
    registered: true,
    registered_at: record.registered,
    ots_status: otsStatus,
    bitcoin_block: record.bitcoin_block || null,
    ots_pending_hours: otsPendingHours,
    ots_pending_message: otsPendingMessage,
  }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function handleRecent(url, env) {
  let limit = parseInt(url.searchParams.get('limit'), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;

  const recentsRaw = await env.PROVENANCE.get('__recents__');
  const recents = recentsRaw ? JSON.parse(recentsRaw) : [];
  const records = recents.slice(0, limit);

  return new Response(JSON.stringify({
    status: 'ok',
    count: records.length,
    records,
  }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// Statuses that /ots/tag may set — never 'confirmed' (that goes through /ots/confirm with a block)
const TAGGABLE_STATUSES = new Set(['legacy_unparseable', 'stamp_failed', 'pending']);

async function handleOtsTag(request, env) {
  try {
    const authHeader = request.headers.get('X-Confirm-Secret') || '';
    if (!env.OTS_CONFIRM_SECRET || authHeader !== env.OTS_CONFIRM_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json();
    const { hash, ots_status, note } = body;

    if (!hash || hash.length !== 64) {
      return new Response(JSON.stringify({ error: 'Invalid hash — must be 64 character SHA-256' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (!TAGGABLE_STATUSES.has(ots_status)) {
      return new Response(JSON.stringify({ error: `Invalid ots_status. Allowed: ${[...TAGGABLE_STATUSES].join(', ')}` }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const raw = await env.PROVENANCE.get(hash);
    if (!raw) {
      return new Response(JSON.stringify({ error: 'Hash not found in registry' }), {
        status: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const record = JSON.parse(raw);
    const prev = record.ots_status;
    record.ots_status = ots_status;
    if (note) record.ots_tag_note = note;
    record.ots_tagged_at = new Date().toISOString();
    await env.PROVENANCE.put(hash, JSON.stringify(record));

    console.log(`[OTS-TAG] hash=${hash.slice(0, 16)} ${prev} → ${ots_status}`);

    return new Response(JSON.stringify({
      status: 'tagged',
      hash,
      ots_status,
      prev_status: prev,
      note: note || null,
    }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleOtsConfirm(request, env) {
  try {
    // Shared-secret gate — set via: wrangler secret put OTS_CONFIRM_SECRET
    const authHeader = request.headers.get('X-Confirm-Secret') || '';
    if (!env.OTS_CONFIRM_SECRET || authHeader !== env.OTS_CONFIRM_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json();
    const { hash, bitcoin_block } = body;

    if (!hash || hash.length !== 64) {
      return new Response(JSON.stringify({ error: 'Invalid hash — must be 64 character SHA-256' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (!bitcoin_block || typeof bitcoin_block !== 'number') {
      return new Response(JSON.stringify({ error: 'bitcoin_block must be a number' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const raw = await env.PROVENANCE.get(hash);
    if (!raw) {
      return new Response(JSON.stringify({ error: 'Hash not found in registry' }), {
        status: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const record = JSON.parse(raw);
    if (record.ots_status === 'confirmed') {
      return new Response(JSON.stringify({
        status: 'already_confirmed',
        bitcoin_block: record.bitcoin_block,
        message: 'Record was already confirmed — no change made.',
      }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    record.ots_status = 'confirmed';
    record.bitcoin_block = bitcoin_block;
    record.ots_confirmed_at = new Date().toISOString();
    await env.PROVENANCE.put(hash, JSON.stringify(record));

    console.log(`[OTS-CONFIRM] hash=${hash.slice(0, 16)} block=${bitcoin_block}`);

    return new Response(JSON.stringify({
      status: 'confirmed',
      hash,
      bitcoin_block,
      ots_confirmed_at: record.ots_confirmed_at,
    }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}
