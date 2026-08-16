# Haawke Hash — Claude Skills File
## Free Tier · hash.haawke.com

---

## What This File Does

This skills file teaches Claude how to help you use **Haawke Hash** and **Haawke Verify** — a cryptographic provenance system that lets you prove any file existed at a specific point in time, anchored to the Bitcoin blockchain.

Install this file in your Claude Desktop MCP configuration or paste it into a Claude Project as context.

---

## What Haawke Hash Does

**Haawke Hash** (hash.haawke.com) is a browser-based tool that:

- Computes a SHA-256 cryptographic fingerprint of any file — entirely in your browser. Your file never leaves your device.
- Registers that fingerprint to a public immutable ledger (Haawke Verify)
- Submits the fingerprint to the Bitcoin blockchain via OpenTimestamps for permanent timestamping

**Haawke Verify** (verify.haawke.com) is a public registry where anyone can check whether a file hash has been registered and when.

**Why this matters:**
- Proves a file existed at a specific date and time
- Proves a file has not been modified since registration
- The Bitcoin timestamp cannot be altered or deleted by anyone
- Useful for: copyright protection, contract evidence, photo/document authentication, AI-generated content provenance

---

## How to Use Haawke Hash (Free Tier)

### Hash a file
1. Go to hash.haawke.com
2. Drag and drop any file onto the hash zone, or click to browse
3. The SHA-256 hash is computed instantly in your browser
4. Click "Register + Timestamp" to register to the public ledger
5. Your file hash is now on the Bitcoin blockchain

### What you receive
- SHA-256 hash (64-character hex string)
- Registration timestamp
- Verify URL: `verify.haawke.com/#[your-hash]`
- Provenance certificate (PDF download)
- OpenTimestamps .ots proof file (Bitcoin proof — confirms within 1-2 hours)

### Verify a file
1. Go to verify.haawke.com
2. Paste a SHA-256 hash, or go directly to `verify.haawke.com/#[hash]`
3. The registry shows: registration date, file name, author (if provided), OTS status

### Free tier limits
- 50 hashes per month
- 1 certificate template (Circuit)
- Client-side only — no team features

---

## How Claude Can Help You

When you have this skills file installed, Claude can help you with:

**File hashing workflow:**
- "Help me hash this file for copyright protection"
- "What files should I hash before publishing?"
- "Explain what my SHA-256 hash means"
- "How do I verify this hash belongs to my file?"

**Understanding your certificate:**
- "What does my provenance certificate prove?"
- "How do I use this in a legal context?"
- "When will my Bitcoin timestamp confirm?"

**Registry lookups:**
- "Check if hash [hash] is registered"
- "What does verify.haawke.com show for my file?"

**General provenance guidance:**
- "What files should creators hash regularly?"
- "How does OpenTimestamps work?"
- "Can I use this as copyright evidence?"

---
---

## MCP Server — Direct Claude Integration

**Haawke Hash is available as an MCP server**, allowing Claude to hash and verify files directly without opening a browser.

### Connect via Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "haawke": {
      "type": "url",
      "url": "https://mcp.haawke.com/sse",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

Get your API key at hash.haawke.com/dashboard.

---

### Available MCP Tools

**`haawke_hash`**
Compute and register a SHA-256 hash.
- Input: file content or string
- Returns: hash, registration timestamp, verify URL, certificate URL
- Consumes: 1 credit

**`haawke_verify`**
Look up a hash in the public registry.
- Input: SHA-256 hash string
- Returns: registration date, OTS status, author, file name
- Consumes: 0 credits (verify is always free)

**`haawke_certificate`**
Generate a provenance certificate PDF for a registered hash.
- Input: SHA-256 hash string
- Returns: certificate download URL
- Consumes: 1 credit (paid tiers only)

---

### Credit Tiers

| Tier | Credits/month | Price |
|------|--------------|-------|
| Free | 50 | $0 |
| Creator | 500 | $9/mo |
| Pro | 5,000 | $29/mo |
| Studio | Unlimited | $99/mo |

Credits reset monthly. Unused credits do not roll over.

---

### Example Claude Prompts (MCP)

- "Hash this document and give me the verify URL"
- "Verify hash `a3f2...` and tell me when it was registered"
- "Hash everything in this project folder before I publish"
- "Generate a provenance certificate for my last hash"

---

*MCP Server · mcp.haawke.com · August 2026*

---

## Optional: Install Mempalace for Session Memory

**Mempalace** gives Claude persistent memory across sessions — Claude remembers your files, hashes, and provenance history between conversations.

Install: github.com/mempalace/mempalace

With Mempalace installed, Claude can:
- Remember which files you've hashed
- Track your provenance history
- Alert you if a file you've registered is disputed
- Keep a running log of your hash certificates

Mempalace is recommended but not required to use Haawke Hash.

---

## Important Notes

- **Privacy:** Your files never leave your browser. Only the hash (a fingerprint) is sent to the registry.
- **Permanence:** Once registered, a hash cannot be removed from the registry.
- **Bitcoin timing:** OTS confirmation takes 1-2 Bitcoin blocks (~10-20 minutes). The .ots file is your proof.
- **Free tier:** 50 hashes/month. Upgrade at hash.haawke.com for unlimited hashing and additional features.

---

## About Haawke Hash

Built by Craig Ellenwood × Claude (Anthropic) · Haawke Neural Technology
U.S. Copyright Registration: 1-15179233921
Academic paper: doi.org/10.5281/zenodo.20574737
hash.haawke.com · verify.haawke.com · craig@haawke.com

*Free Tier Skills File · June 2026*
