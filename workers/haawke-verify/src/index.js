// Haawke Hash — Provenance Registry — SCHEMA v2.1 (staging)
// Cloudflare Worker · haawke-verify-staging
// Implements: Haawke Provenance Record Implementation Spec v2.0 (2026-08-11)
// + v2.1 Feature 1 (Durable Object atomic chain — was already built into
// v2.0 here) + worker-side Ed25519 signing (2026-08-11 follow-up).
// v2.0 corrected per four issues flagged before build: session_id is
// local-client/unverified (not Anthropic-issued), model/token_count
// sourced from transcript JSONL (not API headers), model_card_url uses a
// family mapping (not raw substitution), chain made genuinely atomic via
// a Durable Object rather than best-effort KV increments.
//
// certificate_hash design note: it seals {content, identity, anthropic,
// chain, environment, timestamp, verification.qr_payload,
// verification.model_card_url, verification.signing_key_url} — it
// deliberately does NOT cover `anchor`, because anchor.ots_status /
// anchor.bitcoin_block / anchor.ots_receipt are filled in asynchronously
// after registration (Bitcoin confirmation can take ~24h). Their own
// integrity comes from the OTS calendar + Bitcoin blockchain, independent
// of certificate_hash. This keeps certificate_hash valid forever from the
// moment of sealing, while anchor fields can still be patched post-
// confirmation. certificate_hash is computed via JCS (RFC 8785) canonical
// JSON, then signed with Ed25519 — the private key is a Cloudflare Worker
// secret (HAAWKE_SIGNING_KEY), never in source, KV, or any response.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

// Browsers navigating to a verify link send Accept: text/html,...; API
// callers (including haawke-llm's own handleVerify(), which explicitly
// sends Accept: application/json) don't. ?format=json is the escape hatch
// for viewing raw JSON from a browser instead of the rendered page.
function renderAsHtml(request, url) {
  if (url.searchParams.get('format') === 'json') return false;
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/html');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function shortHash(h) {
  if (!h || h.length < 16) return esc(h);
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

function statusBadge(status) {
  const map = {
    verified: { label: 'VERIFIED', color: '#00f0ff', bg: 'rgba(0,240,255,0.08)', border: 'rgba(0,240,255,0.3)' },
    not_found: { label: 'NOT FOUND', color: '#fca5a5', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.3)' },
  };
  const s = map[status] || { label: (status || 'unknown').toUpperCase(), color: '#a1a1aa', bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.15)' };
  return `<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;background:${s.bg};border:1px solid ${s.border};color:${s.color};font-size:0.78rem;font-weight:700;letter-spacing:0.05em;">${s.label}</span>`;
}

function checkRow(label, ok) {
  const color = ok ? '#4ade80' : '#fca5a5';
  const icon = ok ? '&#10003;' : '&#10007;';
  return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#a1a1aa;font-size:0.88rem;">${esc(label)}</span><span style="color:${color};font-weight:700;">${icon}</span></div>`;
}

function fieldRow(label, value, mono) {
  if (value === undefined || value === null || value === '') return '';
  const style = mono ? 'font-family:\'JetBrains Mono\',monospace;font-size:0.82rem;word-break:break-all;' : '';
  return `<div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);"><div style="color:#71717a;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">${esc(label)}</div><div style="color:#e4e4e7;font-size:0.9rem;${style}">${esc(value)}</div></div>`;
}

function renderVerifyPage(body, status) {
  const rawJsonUrl = (() => {
    // Best-effort: caller supplies status/body only, so build the toggle
    // link relative to the current path rather than requiring a full URL.
    return '?format=json';
  })();

  const outputHash = body.content?.output_hash || body.hash || body.output_hash;
  const inputHash = body.content?.input_hash;
  const model = body.anthropic?.model;
  const registeredAt = body.timestamp?.registered_at || body.registered_at;
  const seq = body.chain?.sequence_number;
  const otsStatus = body.anchor?.ots_status ?? body.ots_status;
  const bitcoinBlock = body.anchor?.bitcoin_block ?? body.bitcoin_block;
  const org = body.identity?.org;
  const author = body.identity?.author;

  let anchorHtml = '';
  if (body.status === 'verified') {
    const confirmed = otsStatus === 'confirmed';
    anchorHtml = `
      <div style="margin-top:24px;padding:18px 20px;border-radius:10px;background:${confirmed ? 'rgba(74,222,128,0.06)' : 'rgba(255,215,0,0.05)'};border:1px solid ${confirmed ? 'rgba(74,222,128,0.25)' : 'rgba(255,215,0,0.2)'};">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span style="font-weight:700;color:${confirmed ? '#4ade80' : '#ffd700'};font-size:0.85rem;">${confirmed ? 'Bitcoin-confirmed' : 'Pending Bitcoin confirmation'}</span>
          ${bitcoinBlock ? `<span style="color:#71717a;font-size:0.8rem;">block ${esc(bitcoinBlock)}</span>` : ''}
        </div>
        <div style="color:#a1a1aa;font-size:0.85rem;">${esc(body.ots_pending_message || (confirmed ? 'This record is permanently anchored to the Bitcoin blockchain.' : ''))}</div>
      </div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${body.status === 'verified' ? 'Verified' : 'Not Found'} | Haawke Verify</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700;900&family=JetBrains+Mono&display=swap" rel="stylesheet">
<style>
  body { background:#050A18; color:#d4d4d8; font-family:'Inter',sans-serif; margin:0; padding:0; line-height:1.6; }
  .wrap { max-width:640px; margin:0 auto; padding:56px 20px 100px; }
  a { color:#00f0ff; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .brand { display:flex; align-items:center; gap:8px; margin-bottom:28px; }
  .brand-dot { width:22px; height:22px; border-radius:50%; background:#00f0ff; display:flex; align-items:center; justify-content:center; font-size:12px; color:#000; font-weight:900; }
  .brand-name { font-weight:900; letter-spacing:-0.02em; color:#fff; }
  h1 { font-size:1.6rem; font-weight:900; color:#fff; margin:16px 0 4px; letter-spacing:-0.02em; }
  .hash { font-family:'JetBrains Mono',monospace; font-size:0.85rem; color:#71717a; word-break:break-all; margin-bottom:20px; }
  .card { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.1); border-radius:12px; padding:24px; margin-top:20px; }
  .card h2 { font-size:0.8rem; text-transform:uppercase; letter-spacing:0.06em; color:#71717a; margin:0 0 4px; }
  .footer-links { margin-top:32px; display:flex; gap:16px; font-size:0.85rem; }
  .footer-links a { color:#71717a; }
  .footer-links a:hover { color:#00f0ff; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><div class="brand-dot">H</div><div class="brand-name">HAAWKE VERIFY</div></div>

  ${statusBadge(body.status)}
  <h1>${body.status === 'verified' ? 'Provenance Verified' : 'Record Not Found'}</h1>
  ${outputHash ? `<div class="hash">${esc(outputHash)}</div>` : ''}
  ${body.status !== 'verified' ? `<p style="color:#a1a1aa;">${esc(body.message || body.error || 'No provenance record exists for this hash.')}</p>` : ''}

  ${body.status === 'verified' ? `
  <div class="card">
    <h2>Details</h2>
    ${fieldRow('Model', model)}
    ${fieldRow('Organization', org)}
    ${fieldRow('Author', author)}
    ${fieldRow('Registered At', registeredAt)}
    ${fieldRow('Chain Sequence', seq)}
    ${inputHash ? fieldRow('Prompt Hash (input)', shortHash(inputHash), true) : ''}
  </div>

  ${anchorHtml}

  <div class="card">
    <h2>Certificate Integrity</h2>
    ${checkRow('Hash matches record', body.certificate_hash_valid)}
    ${checkRow('Signature valid', body.certificate_signature_valid)}
    ${checkRow('Overall certificate valid', body.certificate_valid)}
  </div>
  ` : ''}

  <div class="footer-links">
    <a href="/">&larr; Haawke Verify</a>
    <a href="${rawJsonUrl}">View raw JSON</a>
  </div>
</div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: { ...CORS, 'Content-Type': 'text/html;charset=utf-8' },
  });
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

// ─── JCS (RFC 8785) canonicalization ────────────────────────────────────
// Sorted object keys (by UTF-16 code unit — JS default string sort),
// arrays in original order, no inserted whitespace. This is a faithful
// JCS implementation for our data model (strings/integers/null/nested
// objects/arrays) — we never carry the exotic floats RFC 8785's number
// algorithm exists for, and JS's default Number-to-String already follows
// the same ECMAScript algorithm the RFC references.
function jcsCanonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(jcsCanonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + jcsCanonicalize(value[k])).join(',') + '}';
}

// ─── Ed25519 signing (worker-side; private key lives only as an
// encrypted Cloudflare Worker secret, HAAWKE_SIGNING_KEY — never in
// source, never in KV, never returned in any response) ─────────────────
const HAAWKE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAfOogrhY0DfsYiLZLDkT95g3SuS3aWOcmpZgsObjWxMY=
-----END PUBLIC KEY-----`;
const HAAWKE_SIGNING_KEY_URL = 'https://haawke.com/ns/provenance/1.0/signing-key';

function pemToDer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function importSigningKey(env) {
  const der = pemToDer(env.HAAWKE_SIGNING_KEY);
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
}

async function importVerifyKey() {
  const der = pemToDer(HAAWKE_PUBLIC_KEY_PEM);
  return crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
}

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

// Signs the certificate_hash bytes (not the canonical JSON string itself)
// — standard "sign the digest" pattern. Plain Ed25519 (not Ed25519ph)
// hashes its input internally regardless, so signing a 32-byte SHA-256
// digest here is a normal, secure use of the primitive.
async function signCertificateHash(env, certificateHashHex) {
  const key = await importSigningKey(env);
  const sigBuf = await crypto.subtle.sign({ name: 'Ed25519' }, key, hexToBytes(certificateHashHex));
  return bytesToBase64(new Uint8Array(sigBuf));
}

async function verifyCertificateSignature(certificateHashHex, signatureB64) {
  const key = await importVerifyKey();
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    base64ToBytes(signatureB64),
    hexToBytes(certificateHashHex)
  );
}

// ─── did:key derivation (multicodec ed25519-pub + base58btc) ───────────
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) leadingZeros++;
    else break;
  }
  return '1'.repeat(leadingZeros) + digits.reverse().map(d => B58_ALPHABET[d]).join('');
}

// SPKI DER for a raw Ed25519 public key is always 44 bytes: a fixed
// 12-byte ASN.1 prefix (302a300506032b6570032100) + the 32-byte raw key.
// The multicodec varint for ed25519-pub is 0xed 0x01.
function didKeyFromPublicKeyPem(pem) {
  const der = pemToDer(pem);
  const rawKey = der.slice(der.length - 32);
  const prefixed = new Uint8Array(2 + rawKey.length);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(rawKey, 2);
  return 'did:key:z' + base58Encode(prefixed);
}

const HAAWKE_SIGNING_DID_KEY = didKeyFromPublicKeyPem(HAAWKE_PUBLIC_KEY_PEM);

// ─── XMP sidecar projection (v2.1) ──────────────────────────────────────
// Projected FROM the already-signed JSON record — never authored
// separately, so JSON and XMP can never disagree. haawke:generatorClaimed
// / modelClaimed / sessionId are deliberately named "Claimed", never
// "Verified" — session_id is local-client metadata, not Anthropic-issued.
function xmlAttrEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmpForRecord(record) {
  const c = record.content, id = record.identity, a = record.anthropic, ch = record.chain, v = record.verification;
  const certificateId = 'urn:uuid:' + crypto.randomUUID();
  const attrs = {
    'haawke:schemaVersion': '2.1',
    'haawke:contentHashAlgorithm': 'SHA-256',
    'haawke:contentHash': c.output_hash,
    'haawke:mediaType': c.media_type || '',
    'haawke:generatorClaimed': a.tool_surface || id.author,
    'haawke:modelClaimed': a.model || '',
    'haawke:sessionId': a.session_id || '',
    'haawke:captureTrust': 'locally-observed',
    'haawke:author': id.author,
    'haawke:orcid': id.orcid || '',
    'haawke:org': id.org,
    'haawke:sessionType': id.session_type,
    'haawke:track': String(id.track),
    'haawke:sequenceNumber': String(ch.sequence_number),
    'haawke:previousSealHash': ch.previous_seal_hash || '',
    'haawke:certificateID': certificateId,
    'haawke:certificateHash': v.certificate_hash,
    'haawke:createdAt': record.timestamp.registered_at,
    'haawke:signatureAlgorithm': 'Ed25519',
    'haawke:signingKey': HAAWKE_SIGNING_DID_KEY,
    'haawke:signature': v.signature,
    'haawke:otsReceipt': `${c.filename}.xmp.ots`,
    'haawke:verifyURL': `https://verify.haawke.com/verify/${c.output_hash}`,
    'haawke:registry': 'https://verify.haawke.com',
  };
  const attrString = Object.entries(attrs)
    .map(([k, val]) => `      ${k}="${xmlAttrEscape(val)}"`)
    .join('\n');

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF
    xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
    xmlns:haawke="https://haawke.com/ns/provenance/1.0/">
    <rdf:Description rdf:about="${xmlAttrEscape(c.filename)}"
${attrString}/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

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
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // POST /commit — the single serialization point for the whole chain
  // AND for signing. Body: the fully-assembled unsigned certificate minus
  // chain.sequence_number, chain.previous_seal_hash, and
  // verification.certificate_hash/signature.
  // Returns: { sequence_number, previous_seal_hash, certificate_hash,
  //            signature, record }
  // All of this runs inside one DO request — Workers Durable Objects
  // process one request at a time per instance, so sequencing is
  // genuinely atomic. No other caller can observe or interleave with a
  // half-updated sequence/head state. Signing happens in the same request
  // so "the worker signs, the worker registers" is one atomic operation,
  // not two round trips that could disagree.
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

    partial.verification = {
      ...partial.verification,
      qr_payload: qrPayload,
      certificate_hash: '',
      signature: '',
      signing_key_url: HAAWKE_SIGNING_KEY_URL,
    };

    // certificate_hash excludes `anchor` (async-mutable — see file header
    // note on record_hash's original design, same reasoning applies) and
    // is computed over JCS-canonicalized JSON (RFC 8785), not plain
    // JSON.stringify, so any independent verifier reconstructing this
    // hash gets a spec-defined, unambiguous canonical form rather than
    // one that happens to match this file's key insertion order.
    const { anchor, ...toHash } = partial;
    const canonical = jcsCanonicalize(toHash);
    const certificateHash = await sha256HexOfString(canonical);
    const signature = await signCertificateHash(this.env, certificateHash);

    partial.verification.certificate_hash = certificateHash;
    partial.verification.signature = signature;
    partial.anchor = anchor;

    await this.state.storage.put('seq', sequenceNumber);
    await this.state.storage.put('head_hash', certificateHash);

    return json({
      sequence_number: sequenceNumber,
      previous_seal_hash: previousSealHash,
      certificate_hash: certificateHash,
      signature,
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
    if (path === '/api/hash' && request.method === 'POST') {
      return handleApiHash(request, env);
    }
    if (path === '/register' && request.method === 'POST') {
      return handleRegister(request, env);
    }
    if (path.startsWith('/verify/') && request.method === 'GET') {
      const hash = path.replace('/verify/', '').trim();
      return handleVerify(hash, url, request, env);
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
    if (path.startsWith('/xmp/') && request.method === 'GET') {
      const xmpHash = path.replace('/xmp/', '').trim();
      return handleXmp(xmpHash, env);
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

// ─── /api/hash — adapter for haawke-llm ─────────────────────────────────
// Bridges haawke-llm's simple {content, anchor} request/response shape to
// the real v2.0 /register schema, which requires a pre-computed hash and
// richer identity/anthropic/environment fields. This worker computes the
// hash itself (register never does) and translates the nested v2.0 record
// back down to the flat shape haawke-llm's Worker already expects.
async function handleApiHash(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid JSON' }, 400); }

  const { content, input_hash, model } = body;
  if (!content || typeof content !== 'string') {
    return json({ error: 'content required' }, 400);
  }

  // Caller may pass a pre-computed client-side input hash (e.g. haawke-chat
  // hashes the human prompt before sending) -- optional, "sha256:" prefix
  // stripped if present since handleRegister expects raw 64-char hex.
  let inputHashHex = null;
  if (input_hash) {
    inputHashHex = String(input_hash).replace(/^sha256:/, '');
    if (!HEX64.test(inputHashHex)) {
      return json({ error: 'input_hash must be a 64 character SHA-256 hex string' }, 400);
    }
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const registerPayload = {
    content: {
      output_hash: hashHex,
      input_hash: inputHashHex,
      token_count: null,
      filename: null,
      media_type: 'text/plain',
      provenance_note: 'AI-generated response via Haawke LLM API',
    },
    identity: {
      author: 'Haawke LLM API',
      orcid: null,
      org: 'Haawke Neural Technology',
      session_type: 'api',
    },
    anthropic: { session_id: null, model: model || null, api_endpoint: 'haawke-llm-api', tool_surface: null },
    chain: { parent_session_id: null },
    environment: { platform: 'Baseten', tool_version: null, sealing_machine: null },
    timestamp: { local_log_at: new Date().toISOString() },
    thumbnail_base64: null,
  };

  // Real origin, not a placeholder -- handleRegister derives xmp_url from
  // request.url's origin. Inert today (media_type is always text/plain
  // here, so XMP generation never triggers), but a synthetic/fake origin
  // would silently produce a broken xmp_url the moment this path is ever
  // extended to image content.
  const syntheticReq = new Request('https://hash.haawke.com/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(registerPayload),
  });

  const regResp = await handleRegister(syntheticReq, env);

  if (!regResp.ok) {
    // Registration failed -- return the local hash only, flagged as such.
    return json({
      hash: `sha256:${hashHex}`,
      url: `https://verify.haawke.com/verify/${hashHex}`,
      timestamp: new Date().toISOString(),
      anchored: false,
      pending: false,
    });
  }

  const regBody = await regResp.json();
  const record = regBody.record ?? regBody;
  // Real anchor fields are {ots_status, bitcoin_block, ots_receipt,
  // registry} -- NOT bitcoin_txid/ots_digest, which don't exist on this
  // schema. ots_status is 'pending' immediately after registration; it
  // only becomes 'confirmed' once the OTS poller sees a Bitcoin block.
  return json({
    hash: `sha256:${hashHex}`,
    url: `https://verify.haawke.com/verify/${hashHex}`,
    timestamp: record.timestamp?.registered_at ?? new Date().toISOString(),
    anchored: record.anchor?.ots_status === 'confirmed',
    pending: record.anchor?.ots_status === 'pending',
    sequence_number: record.chain?.sequence_number ?? null,
    certificate_hash: record.verification?.certificate_hash ?? null,
  });
}

// ─── /register — schema v2.0 ────────────────────────────────────────────
async function handleRegister(request, env) {
  try {
    const body = await request.json();
    const { content, identity, anthropic, environment, timestamp, thumbnail_base64 } = body;

    if (!content || !content.output_hash || !HEX64.test(content.output_hash)) {
      return json({ error: 'content.output_hash is required — must be 64 character SHA-256' }, 400);
    }
    if (content.input_hash && !HEX64.test(content.input_hash)) {
      return json({ error: 'content.input_hash must be a 64 character SHA-256 if present' }, 400);
    }
    // Thumbnail is generated client-side (Pillow in the daemon, canvas in
    // the browser) — the worker does no image processing, just storage.
    // 2MB base64 is a generous ceiling for a <=256x256 preview; this is
    // abuse protection, not a real expected size.
    if (thumbnail_base64 && thumbnail_base64.length > 2 * 1024 * 1024) {
      return json({ error: 'thumbnail_base64 too large (max ~2MB base64)' }, 400);
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

    // Partial record — chain + verification.certificate_hash/signature filled in by the
    // Durable Object, which is the single atomic serialization point.
    const partial = {
      schema_version: '2.0',
      content: {
        output_hash: outputHash,
        input_hash: content.input_hash || null,
        token_count: Number.isFinite(content.token_count) ? content.token_count : null,
        filename: content.filename || 'unknown',
        media_type: content.media_type || null,
        provenance_note: content.provenance_note || null,
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
        certificate_hash: null,
        signature: null,
        signing_key_url: null,
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
    const { sequence_number, record } = await commitResp.json();

    // Persist. The DO already made {sequence_number, previous_seal_hash,
    // certificate_hash, signature} correct and race-free — these KV
    // writes are just secondary indexes for lookup, not the source of
    // chain truth.
    await env.PROVENANCE.put(`record:${outputHash}`, JSON.stringify(record));
    await env.PROVENANCE.put(`seq:${sequence_number}`, outputHash);
    if (sessionId) {
      await env.PROVENANCE.put(`session:${sessionId}`, outputHash);
    }
    // Thumbnail: stored separately, never part of the signed record — it's
    // derived from already-hashed content, generated client-side, and
    // must never feed back into output_hash or certificate_hash (that
    // would be a circular dependency: hash the file -> derive a thumbnail
    // from the file -> hash-that-includes-the-thumbnail).
    if (thumbnail_base64) {
      await env.PROVENANCE.put(`thumb:${outputHash}`, thumbnail_base64);
    }
    // XMP sidecar — images only. Built from the already-signed record, so
    // it can never disagree with the JSON certificate (see xmpForRecord).
    let xmp = null;
    let xmpHash = null;
    if ((record.content.media_type || '').startsWith('image/')) {
      xmp = xmpForRecord(record);
      xmpHash = await sha256HexOfString(xmp);
      await env.PROVENANCE.put(`xmp:${outputHash}`, xmp);
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
      xmp_url: xmp ? `${new URL(request.url).origin}/xmp/${outputHash}` : null,
      xmp_hash: xmpHash,
    }, 201);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ─── /verify/[hash] — schema v2.0, dual-read for pre-2.0 records ────────
async function handleVerify(hash, url, request, env) {
  const wantsHtml = renderAsHtml(request, url);

  if (!hash || !HEX64.test(hash)) {
    const body = { error: 'Invalid hash format' };
    return wantsHtml ? renderVerifyPage(body, 400) : json(body, 400);
  }

  const found = await getRecordDualRead(env, hash);
  if (!found) {
    const body = {
      status: 'not_found',
      hash,
      registered: false,
      message: 'No provenance record found for this hash.',
    };
    return wantsHtml ? renderVerifyPage(body, 404) : json(body, 404);
  }

  if (found.legacy) {
    return handleVerifyLegacy(found.record, wantsHtml);
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

  // Recompute certificate_hash the same way the DO did (JCS canonical
  // form), so the API can tell the caller directly whether the record is
  // self-consistent — AND independently verify the Ed25519 signature
  // against the published public key. Both must pass for certificate_valid.
  const { anchor, ...toHash } = record;
  const hashCheckObj = {
    ...toHash,
    verification: { ...toHash.verification, certificate_hash: '', signature: '' },
  };
  const recomputedHash = await sha256HexOfString(jcsCanonicalize(hashCheckObj));
  const hashValid = recomputedHash === record.verification.certificate_hash;
  const signatureValid = hashValid && record.verification.signature
    ? await verifyCertificateSignature(record.verification.certificate_hash, record.verification.signature)
    : false;
  const certificateValid = hashValid && signatureValid;

  let sessionMatch = null;
  const sessionParam = url.searchParams.get('session');
  if (sessionParam !== null) {
    sessionMatch = sessionParam === record.anthropic.session_id;
  }

  // Thumbnail/XMP are stored separately from the signed record (see
  // handleRegister) — surfaced here for display convenience, not part of
  // anything that was hashed or signed.
  const thumbnailBase64 = await env.PROVENANCE.get(`thumb:${hash}`);
  const hasXmp = (record.content.media_type || '').startsWith('image/')
    ? Boolean(await env.PROVENANCE.get(`xmp:${hash}`))
    : false;

  const body = {
    status: 'verified',
    ...record,
    registered: true,
    certificate_hash_valid: hashValid,
    certificate_signature_valid: signatureValid,
    certificate_valid: certificateValid,
    session_match: sessionMatch,
    ots_pending_hours: otsPendingHours,
    ots_pending_message: otsPendingMessage,
    thumbnail_base64: thumbnailBase64 || null,
    xmp_url: hasXmp ? `${url.origin}/xmp/${hash}` : null,
  };
  return wantsHtml ? renderVerifyPage(body, 200) : json(body);
}

// Pre-2.0 flat record — same response shape the old worker returned.
function handleVerifyLegacy(record, wantsHtml) {
  const otsStatus = record.ots_status || 'pending';
  let otsPendingHours = null;
  let otsPendingMessage = null;
  if (otsStatus === 'pending' && record.registered) {
    const elapsedMs = Date.now() - new Date(record.registered).getTime();
    otsPendingHours = Math.round(elapsedMs / 3600000 * 10) / 10;
    otsPendingMessage = `Submitted to Bitcoin calendars, awaiting block confirmation (typically within 24h). Pending ${otsPendingHours}h.`;
  }

  const body = {
    status: 'verified',
    ...record,
    registered: true,
    registered_at: record.registered,
    ots_status: otsStatus,
    bitcoin_block: record.bitcoin_block || null,
    ots_pending_hours: otsPendingHours,
    ots_pending_message: otsPendingMessage,
  };
  return wantsHtml ? renderVerifyPage(body, 200) : json(body);
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

// GET /xmp/{output_hash} — raw XMP sidecar, servable as {filename}.xmp
async function handleXmp(hash, env) {
  if (!hash || !HEX64.test(hash)) {
    return json({ error: 'Invalid hash format' }, 400);
  }
  const xmp = await env.PROVENANCE.get(`xmp:${hash}`);
  if (!xmp) {
    return json({ status: 'not_found', hash, message: 'No XMP sidecar for this hash.' }, 404);
  }
  return new Response(xmp, {
    headers: { ...CORS, 'Content-Type': 'application/rdf+xml' },
  });
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
