// Haawke Hash — OpenTimestamps CORS Proxy
// Cloudflare Worker · haawke-ots-proxy
// Deploy to: ots.haawke.com
// Fixed: June 2026 — prepend OTS magic header to calendar responses

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

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await request.arrayBuffer();
      const hashBytes = new Uint8Array(body);

      if (hashBytes.length !== 32) {
        return new Response(
          JSON.stringify({ error: 'Expected 32-byte SHA-256 hash' }),
          { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
        );
      }

      // Try each calendar in order until one succeeds
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
          // Try next calendar
          continue;
        }
      }

      if (!calendarData) {
        return new Response(
          JSON.stringify({ error: 'All OTS calendars unavailable' }),
          { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
        );
      }

      // Build valid .ots file with magic header
      const otsFile = buildOtsFile(hashBytes, calendarData);

      return new Response(otsFile, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="proof.ots"',
          'Access-Control-Allow-Origin': '*',
          'X-OTS-Calendar': calendarUsed,
        }
      });

    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }
  }
};
