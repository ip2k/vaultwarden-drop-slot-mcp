# Decisions

## TypeScript package and explicit processes

The supplied brief suggested Go. The owner's request selected TypeScript, npm,
MCP and portable Docker deployment. `age-encryption` implements the established
age format in TypeScript, so this does not require custom cryptography or a Go
sidecar. One npm package provides three process roles; no all-in-one privileged
MCP server is exposed. The inbox and importer have different credentials and
mounts, and only the importer has the vault session.

## Deliberately narrow API

The public API is three versioned routes and the MCP interface is two tools.
The producer adapter encrypts the complete document before it reaches REST.
MCP's tool schema and the REST schema share the runtime Zod contracts, generated
by `scripts/contracts.mjs`; an unmodified OpenAPI-to-MCP wrapper would incorrectly
make an agent supply raw ciphertext and would not enforce the enrollment pin.

Protocol names use the brief's snake_case (`key_id`, `request_id`, `writer_id`).
They are intentionally consistent across the envelope and encrypted document.
There are no list/search routes, batch writes, pagination, upserts, attachments
or item mutation in v1. Responses use `Cache-Control: no-store`. A generic REST
scorecard's recommendation to add these capabilities is not applicable here.

## Delivery intent, not exactly-once marketing

An atomic transaction cannot span SQLite and Vaultwarden's create endpoint. The
private ledger persists intent before spawning `bw create item`. It never
automatically issues a second create after that intent, even when no item is
visible yet. Reconciliation uses a reserved hidden field inside the encrypted
vault item. Missing-marker cases stop after bounded retries and require owner
recovery. This preserves at-most-one automatic creation attempt at the cost of
automatic recovery after some crash timings.

## Remote MCP authorization

Use the official SDK's Streamable HTTP transport and jose to validate a provider's
JWT access tokens. Serve protected-resource metadata and a standard challenge;
reuse an external OAuth provider. Authorization runs for every POST, including
direct tools/call requests. A configured issuer, audience, client and subject map
to a configured writer. No OAuth token is forwarded to the inbox.

## Distribution

The module exports the producer client. The ordinary image can serve the inbox
or MCP adapter. The optional importer target includes a separately licensed,
unmodified OSS Bitwarden CLI executable; there is no CLI in the npm tarball.
Public npm/repository publication and importer image redistribution are separate
release steps. Runtime has no dependency on the developer's LAN.

`.github/workflows/release.yml` publishes a `vX.Y.Z` tag (or a manual run on
main) to npm with Trusted Publishing (GitHub OIDC, no token), then to the MCP
Registry as `io.github.ip2k/vaultwarden-drop-slot-mcp` from `server.json`, then
creates the GitHub release. It refuses to run unless package.json,
package-lock.json, server.json and the MCP server version in `src/mcp.ts` agree.
The first npm publish is done by the owner by hand, because a Trusted Publisher
can only be configured for a package that already exists.

## Tested CLI compatibility pin

OSS CLI 2026.9.0 failed password login against a fresh, stock Vaultwarden 1.37.3
account: authentication returned HTTP 200, followed by an internal key lookup
error. No project importer operation had run. The same disposable acceptance
flow with OSS CLI 2026.8.0 successfully imported and read back login and note
items. Pin 2026.8.0 and its published archive hashes; do not silently upgrade or
relax TLS to bypass a compatibility failure. Re-run the acceptance harness when
changing either upstream pin. This is an observed compatibility difference,
not a confirmed attribution of the upstream defect.
