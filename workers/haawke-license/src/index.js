// Haawke Hash — License Worker
// Cloudflare Worker · haawke-license
// haawke-license.haawkeai.workers.dev
//
// POST /webhook                 — Stripe webhook (checkout.session.completed,
//                                 customer.subscription.deleted)
// GET  /validate-key?key=KEY    — license validation for hash.haawke.com
// GET  /resend-key?email=E      — self-service key recovery (rate-limited, always 200)
// GET  /lookup-email?email=E    — admin lookup (X-Admin-Key header)

const PRICE_TIERS = {
  'price_1Ti5P2Gl715hGhcR6WiQAoml': 'pro',     // Creator Pro Monthly $9  (live)
  'price_1Ti5P2Gl715hGhcRcYL1QALh': 'pro',     // Creator Pro Annual $79 (live)
  'price_1Ti5P3Gl715hGhcRhhR1oD8I': 'studio',  // Studio Monthly $49  (live)
  'price_1Ti5P3Gl715hGhcRDEWKjMSx': 'studio',  // Studio Annual $399 (live)
};

// Fallback: any price on these products maps to the tier — handles future prices
const PRODUCT_TIERS = {
  'prod_UhUNKrQqoSxFOE': 'pro',    // Haawke Creator Pro (live)
  'prod_UhUNSElzOzhlRA': 'studio',  // Haawke Studio (live)
};

const TIER_NAMES = { pro: 'Creator Pro', studio: 'Studio' };

const TIER_FEATURES = {
  pro: [
    'Unlimited hashing',
    'All 5 certificate templates',
    'EXIF/ID3 metadata embedding',
    'OPFS history',
    'Batch processing',
    'Auto-caption',
  ],
  studio: [
    'Everything in Creator Pro',
    '5 seats',
    'Shared team database',
    'API access (5K calls/month)',
    'White-label certificates',
  ],
};

const ALLOWED_ORIGINS = [
  'https://hash.haawke.com',
  'https://haawke.com',
  'http://localhost:8788',
  'http://localhost:3000',
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : 'https://hash.haawke.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }
    if (url.pathname === '/validate-key' && request.method === 'GET') {
      return handleValidateKey(url, env, request);
    }
    if (url.pathname === '/resend-key' && request.method === 'GET') {
      return handleResendKey(url, env, request);
    }
    if (url.pathname === '/lookup-email' && request.method === 'GET') {
      return handleLookupEmail(url, env, request);
    }
    return new Response('Not found', { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Stripe webhook
// ---------------------------------------------------------------------------

async function handleWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
    return json({ error: 'Worker not configured: missing Stripe secrets' }, 503);
  }

  const payload = await request.text();
  const sigHeader = request.headers.get('stripe-signature') || '';

  const valid = await verifyStripeSignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return json({ error: 'Invalid signature' }, 400);
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch (e) {
    return json({ error: 'Invalid JSON payload' }, 400);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(event.data.object, env);
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event.data.object, env);
    }
    return json({ received: true }, 200);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = {};
  for (const item of sigHeader.split(',')) {
    const [k, v] = item.split('=');
    if (k === 'v1') (parts.v1 = parts.v1 || []).push(v);
    else parts[k] = v;
  }
  if (!parts.t || !parts.v1) return false;

  // Reject events older than 5 minutes (replay protection)
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > 300) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${parts.t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');

  return parts.v1.some(sig => timingSafeEqual(sig, expected));
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleCheckoutCompleted(session, env) {
  const email = session.customer_details?.email || session.customer_email;
  if (!email) throw new Error('No customer email on checkout session');

  // checkout.session.completed doesn't include line items — fetch them
  const resp = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  if (!resp.ok) throw new Error(`Stripe line_items fetch failed: ${resp.status}`);
  const lineItems = await resp.json();

  let tier = null;
  for (const item of lineItems.data || []) {
    const priceId = item.price?.id;
    const productId = item.price?.product;
    tier = PRICE_TIERS[priceId] || PRODUCT_TIERS[productId] || null;
    if (tier) break;
  }
  if (!tier) throw new Error('No recognized price in checkout session');

  const normalizedEmail = email.toLowerCase().trim();

  // Reuse the existing key if this email already has one (idempotent retries,
  // tier upgrades keep the same key)
  let key = await env.HAAWKE_EMAILS.get(normalizedEmail);
  if (!key) key = crypto.randomUUID();

  const license = {
    email: normalizedEmail,
    tier,
    created: new Date().toISOString(),
    active: true,
    stripe_customer: session.customer || null,
    stripe_subscription: session.subscription || null,
  };

  await env.HAAWKE_LICENSES.put(key, JSON.stringify(license));
  await env.HAAWKE_EMAILS.put(normalizedEmail, key);

  await sendLicenseEmail(normalizedEmail, key, tier, env);
}

async function handleSubscriptionDeleted(subscription, env) {
  // Subscription payload carries the customer id, not the email
  const resp = await fetch(
    `https://api.stripe.com/v1/customers/${subscription.customer}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  if (!resp.ok) throw new Error(`Stripe customer fetch failed: ${resp.status}`);
  const customer = await resp.json();
  const email = (customer.email || '').toLowerCase().trim();
  if (!email) return;

  const key = await env.HAAWKE_EMAILS.get(email);
  if (!key) return;

  const raw = await env.HAAWKE_LICENSES.get(key);
  if (!raw) return;

  const license = JSON.parse(raw);
  license.active = false;
  license.deactivated = new Date().toISOString();
  await env.HAAWKE_LICENSES.put(key, JSON.stringify(license));
}

async function sendLicenseEmail(email, key, tier, env) {
  if (!env.RESEND_API_KEY) return; // email delivery not configured yet

  const tierName = TIER_NAMES[tier] || tier;
  const features = (TIER_FEATURES[tier] || [])
    .map(f => `<li>${f}</li>`).join('\n');

  const html = `
    <div style="font-family: -apple-system, Segoe UI, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
      <h2>Your Haawke ${tierName} license key</h2>
      <p style="font-size: 18px; background: #f4f4f4; padding: 16px; border-radius: 8px; font-family: monospace; letter-spacing: 1px;">
        ${key}
      </p>
      <p>Enter it at <a href="https://hash.haawke.com/app">hash.haawke.com</a> — open <strong>Author Details</strong> and paste your key into the <strong>License</strong> field, then press Apply.</p>
      <p>Your key unlocks:</p>
      <ul>${features}</ul>
      <p>Verify your files at <a href="https://verify.haawke.com">verify.haawke.com</a><br>
      Paper: <a href="https://doi.org/10.5281/zenodo.20574737">doi.org/10.5281/zenodo.20574737</a></p>
      <p style="color: #666;">Craig Ellenwood &times; Claude (Anthropic)<br>Haawke Neural Technology</p>
    </div>`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Haawke Hash <noreply@haawke.com>',
      to: [email],
      subject: 'Your Haawke Hash License Key',
      html,
    }),
  });
  if (!resp.ok) {
    // Don't fail the webhook over email delivery — the license is already
    // stored and retrievable via /lookup-email
    console.log(`Resend error ${resp.status}: ${await resp.text()}`);
  }
}

// ---------------------------------------------------------------------------
// License validation (called by hash.haawke.com)
// ---------------------------------------------------------------------------

async function handleValidateKey(url, env, request) {
  const cors = corsHeaders(request);
  const key = (url.searchParams.get('key') || '').trim();

  if (!key) {
    return json({ valid: false, tier: 'free', error: 'Missing key' }, 400, cors);
  }

  const raw = await env.HAAWKE_LICENSES.get(key);
  if (!raw) {
    return json({ valid: false, tier: 'free' }, 200, cors);
  }

  const license = JSON.parse(raw);
  if (!license.active) {
    return json({ valid: false, tier: 'free', reason: 'deactivated' }, 200, cors);
  }

  return json({ valid: true, tier: license.tier, email: license.email }, 200, cors);
}

// ---------------------------------------------------------------------------
// Self-service key recovery
// ---------------------------------------------------------------------------

async function handleResendKey(url, env, request) {
  const cors = corsHeaders(request);
  const email = (url.searchParams.get('email') || '').toLowerCase().trim();

  if (email?.includes('@')) {
    const cooldownKey = `__cooldown__${email}`;
    const onCooldown = await env.HAAWKE_EMAILS.get(cooldownKey);

    if (!onCooldown) {
      const licenseKey = await env.HAAWKE_EMAILS.get(email);
      if (licenseKey) {
        const raw = await env.HAAWKE_LICENSES.get(licenseKey);
        if (raw) {
          const license = JSON.parse(raw);
          if (license.active) {
            // Set cooldown before sending to prevent races
            await env.HAAWKE_EMAILS.put(cooldownKey, '1', { expirationTtl: 300 });
            await sendLicenseEmail(license.email, licenseKey, license.tier, env);
          }
        }
      }
    }
  }

  // Always return the same response — never reveal whether email exists
  return json({ sent: true, message: "If that email has a license, we've sent it." }, 200, cors);
}

// ---------------------------------------------------------------------------
// Admin email lookup
// ---------------------------------------------------------------------------

async function handleLookupEmail(url, env, request) {
  if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const email = (url.searchParams.get('email') || '').toLowerCase().trim();
  if (!email) {
    return json({ error: 'Missing email' }, 400);
  }

  const key = await env.HAAWKE_EMAILS.get(email);
  if (!key) {
    return json({ found: false, email }, 404);
  }

  const raw = await env.HAAWKE_LICENSES.get(key);
  const license = raw ? JSON.parse(raw) : null;

  return json({ found: true, email, key, license }, 200);
}
