# Shared artifact API for Haawke MCP

Repository: `https://github.com/inoculate23/hash.haawke.com`.
Required branch: **`claude/clever-mayer-o2t21i`**.
Base: `e2fa5d272df35d709b1e694bbed672863e392891`.

Public Verify frontend: `https://github.com/inoculate23/verify.haawke.com`,
`main` at `efbfabdc13aa616f22d6eb3fa5e328c114914abd`.

## Changes

`POST /v1/artifacts/hash` uses the existing `sha256HexOfString` helper for read-only
exact-UTF-8 hashing. `POST /v1/artifacts/seal` uses that helper and existing
`handleRegister`, signing, sequencing and provenance KV. No new registry or OTS.

Both require the dedicated Worker secret `HAAWKE_ARTIFACT_SERVICE_TOKEN` and fail
closed when unconfigured or unauthorized. Strict size/type/field checks apply.
Raw text, private titles, request IDs and client identities are excluded from the
public payload; attribution identifies the artifact service only.

The existing worker entrypoint changes only to import and dispatch the adapter.
The Verify frontend is unchanged. Its `/verify/:hash` redirects to the worker's
record page; MCP preserves validated URLs returned by the registry.

## Validation

```sh
node --test test/artifacts.test.mjs
wrangler deploy --dry-run --outdir /private/tmp/haawke-core-worker-build
```

Three tests pass using the real worker hashing, registration and sequencer with
in-memory bindings and temporary test signing keys. They cover independent digest
comparison, private-field exclusion, repeated sealing preserving the first record,
and rejection of unauthorized/malformed inputs. Dry-run builds with the existing
PROVENANCE KV and SEQUENCER bindings. Deployed executable code matched a build of
the exact branch base, apart from a generated entrypoint name and comments.

## Deployment status

**Deployed with explicit user approval; live acceptance A–H passed.**

- Worker: `haawke-verify`
- Version: `c4f00c0b-b9cb-44dd-8d57-94effd24143f` (100% traffic)
- Deployment: `e6623036-59e1-496d-a0d9-cf688f24dc61`
- Deployed: `2026-09-27T02:26:02.824671Z`
- Source: reviewed working-tree changes on `claude/clever-mayer-o2t21i`, based on
  `e2fa5d272df35d709b1e694bbed672863e392891`. No rebase or Verify frontend change.
- Live code matched the reviewed build after deployment. Existing KV, sequencer,
  signing secret, variables and other bindings were checked and preserved.
- Dedicated artifact credential installed through Wrangler stdin; matching MCP
  value resides only in the ignored mode-0600 `.env`. No credential is included here.
- Local MCP restarted at `http://127.0.0.1:8787/mcp` and content verification passed.
  This does not deploy a public MCP endpoint or complete ChatGPT installation.

The required ancestry check, three Core tests and Wrangler dry-run were repeated
before deployment. Production code/deployment history were unchanged from preparation.
The initial Cloudflare authentication read failed before writes; normal Wrangler
session refresh restored access, and the guarded preflight was repeated successfully.

## Live acceptance evidence

Fixed non-private UTF-8 sample (JavaScript string notation, including exact escapes):

```js
'Haawke artifact API acceptance test — 2026-09-27.\r\nExact UTF-8: café / e\u0301 / 🌊.\nPublic test artifact; no personal data.\n'
```

SHA-256: `d8b8d6b9c4d103560fa16c299df7b32b070893c215bca73a3ba30650bb986cc1`

[Open the authoritative Verify record](https://haawke-verify.haawkeai.workers.dev/verify/d8b8d6b9c4d103560fa16c299df7b32b070893c215bca73a3ba30650bb986cc1)

- A: Core exact-UTF-8 hashing succeeded.
- B–C: Independent Node SHA-256 over identical UTF-8 bytes matched exactly.
- D: First seal returned `REGISTERED`.
- E: Returned URL opened the expected HTML record with the matching digest.
- F: Public JSON reported matching digest and a valid certificate; raw sample,
  private-title sentinel, client source and both request IDs were absent. Attribution
  was only `Haawke artifact service` / `Haawke`, with no asserted author identity/model.
- G–H: Identical repeat returned `EXISTS`. Original timestamp, certificate hash,
  signature, digest, attribution, filename, media type, provenance note, input hash,
  model and QR/sequence identity remained unchanged; no conflicting record was created.

First registration: `2026-09-27T02:27:47.417Z`. OpenTimestamps: `pending`,
which is separate from registry verification and is not a claim of Bitcoin anchoring.

Acceptance script: `haawke-mcp/scripts/live-acceptance.mjs`. It performs live writes
and must not be run as a routine unit test. It expects first-time registration, so
rerunning the already-registered fixed sample intentionally stops at D; use read-only
verification for subsequent monitoring rather than creating additional test records.

Production scope was limited to the approved credential and artifact routes. No
unrelated credentials, existing records, frontend code, DNS or infrastructure changed.

## Prepared v2 metadata extension (not deployed)

An optional `provenance` object on authenticated `/seal` accepts only `model`,
`provider`, and `session_type` (`human-initiated` or `autonomous`). Model/provider
are bounded public labels; private identifiers and arbitrary metadata are rejected.
Clients omitting the object retain their original registration payload.
The optional model/session fields enter the existing signed registration record.

Public `/verify/:hash` keeps all flat aliases and adds a selected nested v2 display
projection for v2 records only. Private session IDs, endpoints, machine/environment
fields and local timestamps are withheld. This is a display projection, not the
complete signed certificate. Legacy responses and stored records stay unchanged.
Duplicates preserve the first record, including an absent or different model.

Deploy only after the Verify v2 renderer safely escapes public record values; then
Core support must precede the new Phoenix caller. No historical metadata backfill,
new hashing algorithm, new storage binding or infrastructure change is needed.
