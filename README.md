# Haawke Hash
[![Netlify Status](https://api.netlify.com/api/v1/badges/99ed7570-9401-4a42-baa7-5efd07072e9a/deploy-status)](https://app.netlify.com/projects/sparkly-klepon-d68ebe/deploys)
**Cryptographic provenance tool for human-AI collaborative works.**

Live: [hash.haawke.com](https://hash.haawke.com)  
Registry API: [haawke-verify.haawkeai.workers.dev](https://haawke-verify.haawkeai.workers.dev)  
Verify Tool: [verify.haawke.com](https://verify.haawke.com)  
ORCID: [0009-0001-6475-5109](https://orcid.org/0009-0001-6475-5109)

---

## What It Does

A browser-based SHA-256 hashing and provenance registration tool. Drop any file, paste text, point at a URL, or record a structured session — Haawke Hash computes a cryptographic fingerprint, registers it to the public Haawke Provenance Registry, and anchors it to the Bitcoin blockchain via OpenTimestamps.

Runs entirely in your browser. No data is transmitted except when explicitly registering to the registry or timestamping to the blockchain.

---

## Features

- **Hash any input** — file (HTML, PDF, MP3, MP4, GLB, any format), pasted text, or a live URL
- **Author details** — attach author name, organisation, and ORCID to every hash; saved to `localStorage` so they pre-populate on return visits
- **Abbreviated hash display** — shows first 16 + last 8 characters in the UI; full 64-char hash always copied and stored
- **Export provenance records** in four formats: HTML footer embed, plain text/email, Zenodo citation, JSON
- **Embed provenance in image metadata** — writes XMP into JPEG or PNG and re-downloads the file; XMP sidecar (`.xmp`) download for PDF, video, audio, and other formats
- **Provenance certificate** — one-click A4 PDF certificate with author, org, ORCID, hash, timestamp, verify URL, and QR code; generated via browser print dialog
- **QR code** — generated for the verify URL at hash time; downloadable standalone and embedded in the certificate
- **Register to the public registry** — appends the hash to the Haawke Provenance Registry (Cloudflare KV, append-only, first-write-wins)
- **Blockchain timestamp** — submits the hash to Bitcoin via OpenTimestamps; downloads a `.ots` proof file
- **Local provenance log** — saved to `localStorage`; exportable as JSON
- **Memory Chain (Session tab)** — record structured session data (title, date, participants, summary, key decisions, artifacts, previous hash), hash it deterministically, and output a `.chain.json` entry for `claude-memory-chain.json` plus a plain-text Continuity Block for pasting into future Claude sessions
- **Haawke Provenance Badge** — self-certifying badge that verifies the page's own integrity on load

---

## How To Use

### Hash a file
1. Go to [hash.haawke.com](https://hash.haawke.com)
2. Drop any file onto the drop zone (or use the File tab)
3. Click **Generate Hash**
4. Copy the SHA-256 and any export format you need

### Add author details

- Expand the **Author Details** panel below the hash input
- Enter Author, Org, and ORCID — these are saved automatically and pre-populate on your next visit

### Embed provenance in an image

1. Hash a JPEG or PNG file
2. The **File Metadata** section appears below the result
3. Click **Embed Provenance in Image** — downloads a new copy of the file with XMP metadata written in
4. For non-image formats, click **Download XMP Sidecar (.xmp)** to get a companion metadata file

### Download a provenance certificate

1. Generate a hash
2. Click **Download Certificate PDF** — opens a print-ready A4 certificate in a new tab
3. Save as PDF from the browser print dialog

### Record a Memory Chain session

1. Select the **Session** tab
2. Fill in Title, Date, Participants, Summary, and optionally Key Decisions, Artifacts, and Previous Hash
3. Click **Generate Hash** — hashes the session data deterministically
4. Use **Download .chain Entry** to save the JSON entry, or **Copy Continuity Block** to copy the verified summary for pasting into a new Claude conversation
5. Click **Save Session to Registry & Chain** — registers to the public registry and saves to the local Memory Chain viewer

### Register to the public registry
1. Generate a hash
2. Click **Save to Provenance Log** — saves locally and registers to the public registry
3. The hash is permanently recorded with authorship, ORCID, and timestamp

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
| `.chain.json` | Memory Chain entry for `claude-memory-chain.json` |
| Continuity Block | Plain-text session summary for pasting into new Claude conversations |

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

U.S. Copyright Registration: 1-15179233921 (June 5, 2026)

---

*Craig Ellenwood × Claude (Anthropic) · Haawke Neural Technology · 2026*  
*ORCID: 0009-0001-6475-5109 · haawke.com*
