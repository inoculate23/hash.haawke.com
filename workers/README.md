# Haawke Cloudflare Workers

Built from `cloudflare -build` spec, June 2026. Three workers, all validated
locally with `wrangler dev` (see verification notes at the bottom).

| Worker | URL | Status |
|---|---|---|
| haawke-ots-proxy | haawke-ots-proxy.haawkeai.workers.dev | fixed — ready to deploy |
| haawke-verify | haawke-verify.haawkeai.workers.dev | updated — ready to deploy |
| haawke-license | haawke-license.haawkeai.workers.dev | new — ready to deploy |

## Deploy (Tasks 1–3)

Order matters per the spec — the OTS fix ships first:

```bash
cd workers/haawke-ots-proxy && wrangler deploy
cd ../haawke-verify         && wrangler deploy
cd ../haawke-license        && wrangler deploy
```

KV namespaces are already created and wired into each `wrangler.toml`:

- `PROVENANCE` → `61c3afcf84844c3cbe7969ea88b9fbb3` (existing registry, preserved)
- `HAAWKE_LICENSES` → `7ed83b355ec5452584d6b5e2d0d929c8` (created June 11, 2026)
- `HAAWKE_EMAILS` → `6fb1b4bf4a4047e7a947e8be65b81b37` (created June 11, 2026)

## Verify the OTS fix after deploy (Task 1)

```bash
printf 'test' | shasum -a 256 | awk '{print $1}' | xxd -r -p | \
  curl -s -X POST --data-binary @- \
  https://haawke-verify.haawkeai.workers.dev/ots | xxd | head -3
# First bytes must be: 004f 7065 6e54 696d 6573 7461 6d70 7300 (\x00OpenTimestamps\x00)
```

Note: the frontend (index.html) calls `haawke-verify.haawkeai.workers.dev/ots`,
not the standalone ots-proxy — the magic-header fix is applied to **both** workers.

## License worker secrets (Task 3)

After deploying haawke-license, set its four secrets:

```bash
cd workers/haawke-license
uuidgen | wrangler secret put ADMIN_KEY          # save the UUID somewhere safe
wrangler secret put STRIPE_SECRET_KEY            # sk_test_... (test mode for now)
wrangler secret put STRIPE_WEBHOOK_SECRET        # whsec_... — see Task 5 below
wrangler secret put RESEND_API_KEY               # re_... — see Task 6 below
```

The webhook returns 503 until the Stripe secrets are set; email sending is
skipped (license still stored) until RESEND_API_KEY is set.

## Stripe webhook (Task 5)

Register in the Stripe dashboard (test mode):
- URL: `https://haawke-license.haawkeai.workers.dev/webhook`
- Events: `checkout.session.completed`, `customer.subscription.deleted`
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET` above.

Local testing: `stripe listen --forward-to https://haawke-license.haawkeai.workers.dev/webhook`
(use the `whsec_...` that `stripe listen` prints while testing this way).

## Payment links (Task 4)

```bash
for PRICE in price_1Th97UGl715hGhcRWwop5Ejx price_1Th97VGl715hGhcRz8FtBFPV \
             price_1Th98rGl715hGhcRltDkB5i0 price_1Th98sGl715hGhcRliBBDRV8; do
  stripe payment_links create \
    -d "line_items[0][price]=$PRICE" \
    -d "line_items[0][quantity]=1" \
    -d "after_completion[type]=redirect" \
    -d "after_completion[redirect][url]=https://hash.haawke.com/success"
done
```

## Resend (Task 6)

1. resend.com → add + verify the `haawke.com` sending domain (required before
   `noreply@haawke.com` can send)
2. Create API key → `wrangler secret put RESEND_API_KEY`

## What was validated locally (June 11, 2026)

- `/ots` output parses cleanly with the real OpenTimestamps CLI (`ots info`) —
  the old deployed worker's output failed with "not a timestamp file"
- File layout matches known-good CLI-made .ots files in `provenance/`:
  `[31-byte magic][0x01 version][0x08 sha256 tag][32-byte digest][calendar ops]`
- `/register` stores author/org/orcid/type/prompt/timestamp; duplicate hashes
  preserve the first record
- `/verify/[hash]` returns `registered: true`, `ots_status`, `bitcoin_block`
  plus all stored fields (existing field names preserved for the live frontend)
- `/recent?limit=N` clamps 1–100, defaults 20
- `/validate-key` returns `{valid, tier, email}`, CORS locked to hash.haawke.com
- `/webhook` → 503 when Stripe secrets unset, signature verification with
  5-minute replay window; `/lookup-email` → 401 without X-Admin-Key
