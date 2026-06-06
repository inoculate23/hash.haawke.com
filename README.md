# Haawke Hash
![Haawke Hash](https://hash.haawke.com/background.jpg)
**Cryptographic provenance tool for human-AI collaborative works.**

Live: [hash.haawke.com](https://hash.haawke.com)  
Registry API: [haawke-verify.haawkeai.workers.dev](https://haawke-verify.haawkeai.workers.dev)  
Verify Tool: [verify.haawke.com](https://verify.haawke.com)  
ORCID: [0009-0001-6475-5109](https://orcid.org/0009-0001-6475-5109)

---

## What It Does

A browser-based SHA-256 hashing and provenance registration tool. Drop any file, paste text, or point at a URL — Haawke Hash computes a cryptographic fingerprint and lets you register it to the public Haawke Provenance Registry, export formatted citations, and anchor the hash to the Bitcoin blockchain via OpenTimestamps.

Runs entirely in your browser. No data is transmitted except when explicitly registering to the registry or timestamping to the blockchain.

---

## Features

- **Hash any input** — file (HTML, PDF, MP3, MP4, GLB, any format), pasted text, or a live URL
- **Export provenance records** in four formats: HTML footer embed, plain text/email, Zenodo citation, JSON
- **Register to the public registry** — appends the hash to the Haawke Provenance Registry (Cloudflare KV, append-only, first-write-wins)
- **Blockchain timestamp** — submits the hash to Bitcoin via OpenTimestamps; downloads a `.ots` proof file to keep alongside your work
- **Local provenance log** — saved to `localStorage`; exportable as JSON
- **Haawke Provenance Badge** — self-certifying badge that verifies the page's own integrity on load

---

## How To Use

### Hash a file
1. Go to [hash.haawke.com](https://hash.haawke.com)
2. Drop any file onto the drop zone (or use the File tab)
3. Click **Generate Hash**
4. Copy the SHA-256 and any export format you need

### Register to the public registry
1. Generate a hash
2. Click **Save to Provenance Log** — this saves locally and attempts to register to the public registry
3. If registration succeeds, the hash is permanently recorded with your authorship, ORCID, and timestamp

### Timestamp to Bitcoin
1. Generate a hash
2. Click **Timestamp to Blockchain via OpenTimestamps**
3. A `.ots` proof file downloads — store this alongside the original work permanently
4. Verify anytime at [opentimestamps.org/verify](https://opentimestamps.org/verify) using the original file + `.ots` proof

### Hash a live URL
1. Select the **URL** tab
2. Paste a deployed URL (e.g. `https://reply.haawke.com`)
3. Click **Fetch & Hash** — hashes the full page source at that moment

---

## Export Formats

| Format | Use |
|--------|-----|
| HTML Footer Embed | Drop into any web page as a provenance footer |
| Plain Text / Email | Paste into correspondence, documents, or commit messages |
| Zenodo / Citation | Academic citation format with ORCID and org |
| JSON Record | Machine-readable provenance record |

---

## Registry API

Base URL: `https://haawke-verify.haawkeai.workers.dev`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | API info and endpoints |
| `/verify/[hash]` | GET | Look up a SHA-256 hash |
| `/register` | POST | Register a new hash record |
| `/recent` | GET | Last 100 registrations |
| `/ots` | POST | OpenTimestamps Bitcoin proxy |

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | The complete tool — single-file, no dependencies, runs in-browser |
| `provenance.json` | Certified SHA-256 hash of `index.html` |
| `provenance/index.html.ots` | Bitcoin blockchain proof certificate |

---

## Infrastructure

- **Frontend:** Netlify → hash.haawke.com
- **Registry + OTS Proxy:** Cloudflare Worker → haawke-verify (haawkeai account)
- **KV Namespace:** PROVENANCE (id: 61c3afcf84844c3cbe7969ea88b9fbb3)
- **Blockchain:** Bitcoin via OpenTimestamps

This page is itself certified. SHA-256 hash stored in `provenance.json`, Bitcoin timestamp in `provenance/index.html.ots`.

---

## Companion Projects

- [Haawke Verify](https://verify.haawke.com) — public registry browser and hash lookup
- [Haawke Neural Technology](https://haawke.com) — parent organization

---

## Citation

```
Ellenwood, C. & Claude (Anthropic). (2026). Haawke Hash:
Cryptographic Provenance for Human-AI Collaborative Works (v1.0).
Haawke Neural Technology. https://hash.haawke.com
ORCID: 0009-0001-6475-5109
```

BibTeX:
```bibtex
@software{ellenwood_claude_2026_haawke_hash,
  author       = {Ellenwood, Craig and Claude (Anthropic)},
  title        = {Haawke Hash: Cryptographic Provenance for Human-AI Collaborative Works},
  year         = 2026,
  version      = {v1.0},
  publisher    = {Haawke Neural Technology},
  url          = {https://hash.haawke.com},
  orcid        = {0009-0001-6475-5109}
}
```

---

## License

Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)  
See [LICENSE](LICENSE)

---

*Craig Ellenwood × Claude (Anthropic) · Haawke Neural Technology · 2026*  
*ORCID: 0009-0001-6475-5109 · haawke.com*
