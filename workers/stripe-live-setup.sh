#!/usr/bin/env bash
# Haawke Hash — Stripe Live Setup
# Run once with your live secret key: bash workers/stripe-live-setup.sh sk_live_...
#
# What this does:
#   1. Creates live Creator Pro + Studio products and prices
#   2. Creates 4 payment links (tier-specific success URLs)
#   3. Registers the haawke-license webhook endpoint (live)
#   4. Patches the worker's PRICE_TIERS map with live price IDs
#   5. Sets STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET on the worker
#   6. Redeploys haawke-license with live price IDs
#   7. Prints live payment link URLs for landing.html
#
# Prerequisites:
#   - stripe CLI installed
#   - wrangler installed and authenticated (craig@haawke.com)
#   - Run from the repo root directory

set -euo pipefail

LIVE_KEY="${1:-}"
if [ -z "$LIVE_KEY" ]; then
  echo "Usage: bash workers/stripe-live-setup.sh sk_live_..."
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/workers/haawke-license"
WORKER_SRC="$WORKER_DIR/src/index.js"
SUCCESS_BASE="https://hash.haawke.com/success"
WEBHOOK_URL="https://haawke-license.haawkeai.workers.dev/webhook"

s() { stripe "$@" --api-key "$LIVE_KEY"; }

extract_id() { grep '"id"' | head -1 | sed 's/.*"id": "\([^"]*\)".*/\1/'; }
extract_url() { grep '"url"' | grep 'buy.stripe.com\|donate.stripe.com' | head -1 | sed 's/.*"url": "\([^"]*\)".*/\1/'; }
extract_secret() { grep '"secret"' | head -1 | sed 's/.*"secret": "\([^"]*\)".*/\1/'; }

echo ""
echo "── Creating live products ────────────────────────────────────────"

PRO_PROD=$(s products create \
  --name="Haawke Creator Pro" \
  --description="Unlimited hashing, all 5 certificate templates, EXIF/XMP/ID3 embedding, batch processing, auto-caption, OPFS history" \
  | extract_id)
echo "Creator Pro: $PRO_PROD"

STUDIO_PROD=$(s products create \
  --name="Haawke Studio" \
  --description="5 seats, shared team database, API access 5K calls/month, white-label certificates, all Creator Pro features" \
  | extract_id)
echo "Studio:      $STUDIO_PROD"

echo ""
echo "── Creating live prices ─────────────────────────────────────────"

PRO_MONTHLY=$(s prices create --product="$PRO_PROD" \
  --unit-amount=900 --currency=usd \
  -d "recurring[interval]=month" | extract_id)
echo "Creator Pro monthly: $PRO_MONTHLY"

PRO_ANNUAL=$(s prices create --product="$PRO_PROD" \
  --unit-amount=7900 --currency=usd \
  -d "recurring[interval]=year" | extract_id)
echo "Creator Pro annual:  $PRO_ANNUAL"

STUDIO_MONTHLY=$(s prices create --product="$STUDIO_PROD" \
  --unit-amount=4900 --currency=usd \
  -d "recurring[interval]=month" | extract_id)
echo "Studio monthly:      $STUDIO_MONTHLY"

STUDIO_ANNUAL=$(s prices create --product="$STUDIO_PROD" \
  --unit-amount=39900 --currency=usd \
  -d "recurring[interval]=year" | extract_id)
echo "Studio annual:       $STUDIO_ANNUAL"

echo ""
echo "── Creating live payment links ──────────────────────────────────"

make_link() {
  local PRICE="$1" TIER="$2"
  s payment_links create \
    -d "line_items[0][price]=$PRICE" \
    -d "line_items[0][quantity]=1" \
    -d "after_completion[type]=redirect" \
    -d "after_completion[redirect][url]=${SUCCESS_BASE}?tier=${TIER}" \
    | extract_url
}

LINK_PRO_MONTHLY=$(make_link "$PRO_MONTHLY" "pro")
LINK_PRO_ANNUAL=$(make_link "$PRO_ANNUAL" "pro")
LINK_STUDIO_MONTHLY=$(make_link "$STUDIO_MONTHLY" "studio")
LINK_STUDIO_ANNUAL=$(make_link "$STUDIO_ANNUAL" "studio")

echo "Creator Pro monthly:  $LINK_PRO_MONTHLY"
echo "Creator Pro annual:   $LINK_PRO_ANNUAL"
echo "Studio monthly:       $LINK_STUDIO_MONTHLY"
echo "Studio annual:        $LINK_STUDIO_ANNUAL"

echo ""
echo "── Registering live webhook ─────────────────────────────────────"

WEBHOOK_OUT=$(s webhook_endpoints create \
  --url="$WEBHOOK_URL" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=customer.subscription.deleted")

WEBHOOK_SECRET=$(echo "$WEBHOOK_OUT" | extract_secret)
WEBHOOK_ID=$(echo "$WEBHOOK_OUT" | extract_id)
echo "Webhook: $WEBHOOK_ID → $WEBHOOK_URL"
echo "Signing secret captured (whsec_...)"

echo ""
echo "── Patching worker PRICE_TIERS with live price IDs ─────────────"

# Replace the test PRICE_TIERS block in the worker source with live price IDs
python3 - <<PYEOF
import re, sys

with open("$WORKER_SRC") as f:
    src = f.read()

new_tiers = """const PRICE_TIERS = {
  '$PRO_MONTHLY': 'pro',     // Creator Pro Monthly \$9  (live)
  '$PRO_ANNUAL': 'pro',     // Creator Pro Annual \$79 (live)
  '$STUDIO_MONTHLY': 'studio',  // Studio Monthly \$49  (live)
  '$STUDIO_ANNUAL': 'studio',  // Studio Annual \$399 (live)
};"""

patched = re.sub(
    r'const PRICE_TIERS = \{[^}]+\};',
    new_tiers,
    src,
    flags=re.DOTALL
)

if patched == src:
    print("ERROR: PRICE_TIERS block not found in worker source", file=sys.stderr)
    sys.exit(1)

with open("$WORKER_SRC", "w") as f:
    f.write(patched)

print("PRICE_TIERS updated with live price IDs")
PYEOF

echo ""
echo "── Setting worker secrets ────────────────────────────────────────"

cd "$WORKER_DIR"
echo "$LIVE_KEY"       | wrangler secret put STRIPE_SECRET_KEY
echo "$WEBHOOK_SECRET" | wrangler secret put STRIPE_WEBHOOK_SECRET
echo "Secrets set: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET"

echo ""
echo "── Redeploying haawke-license with live price IDs ───────────────"

wrangler deploy
echo "Worker redeployed."

echo ""
echo "════════════════════════════════════════════════════════════════"
echo " DONE — paste these into landing.html pricing cards:"
echo ""
echo " Creator Pro Monthly:  $LINK_PRO_MONTHLY"
echo " Creator Pro Annual:   $LINK_PRO_ANNUAL"
echo " Studio Monthly:       $LINK_STUDIO_MONTHLY"
echo " Studio Annual:        $LINK_STUDIO_ANNUAL"
echo ""
echo " Remaining manual step:"
echo "   cd workers/haawke-license && wrangler secret put RESEND_API_KEY"
echo "   (get your key at resend.com after verifying haawke.com domain)"
echo "════════════════════════════════════════════════════════════════"
