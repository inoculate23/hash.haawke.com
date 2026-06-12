// Haawke Hash — Provenance Registry
// Cloudflare Worker · haawke-verify
// verify.haawke.com / haawke-verify.haawkeai.workers.dev
// Updated June 2026:
//   - /ots now returns valid .ots files (OTS magic header prepended)
//   - /register accepts type, prompt, timestamp fields
//   - /verify/[hash] returns ots_status + bitcoin_block
//   - /recent supports ?limit=

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
    if (path === '/' || path === '') {
      return new Response(JSON.stringify({
        name: 'Haawke Provenance Registry',
        version: '1.1',
        author: 'Craig Ellenwood × Claude (Anthropic)',
        orcid: '0009-0001-6475-5109',
        org: 'Haawke Neural Technology',
        endpoints: {
          verify: 'GET /verify/[sha256hash]',
          register: 'POST /register',
          recent: 'GET /recent?limit=20',
          ots: 'POST /ots',
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
  return new Response(JSON.stringify({
    status: 'verified',
    ...record,
    registered: true,
    registered_at: record.registered,
    ots_status: record.ots_status || 'pending',
    bitcoin_block: record.bitcoin_block || null,
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
