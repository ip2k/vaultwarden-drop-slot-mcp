# Verification record

Verification on 2026-09-17 and 2026-09-18. These are measured checks, not a claim of
independent audit or universal Vaultwarden/client compatibility.

| Check | Result |
| --- | --- |
| TypeScript build and 12 automated tests | Pass on Node 26.8.1/macOS and pinned Node 24.21.0/Linux amd64 |
| Official SDK stdio MCP and authenticated Streamable HTTP | Pass; exactly two tools, generic errors, direct-call authorization and revocation |
| Writer/worker separation and own-receipt authorization | Pass; no list/read/edit/delete surface; wrong-role and cross-writer requests rejected |
| Encryption and validation | Pass; planted secret absent from queue/spool/replies; wrong key, tampering, binding and bounded header/body/schema checks |
| TLS and mTLS | Pass; untrusted server and missing/wrong client certificates fail closed |
| Durable delivery model | Pass; restart, stale lease, concurrency, locked vault and ambiguous success tests; no second automatic creation attempt |
| CLI invocation | Pass; item on stdin, session only in isolated child environment, fixed arguments, binary/version pin |
| Disposable stock Vaultwarden 1.37.3 + OSS CLI 2026.8.0 | Personal destination: login/note imported, read back, and retries produced exactly two items |
| Organization destination and stock web-client readback | Pass; stock web vault created the organization, both imports had the configured organization/collection, and the web client opened the login and note |
| npm install from packed tarball | Pass; CLI executable and Node exports load; no test fixtures, node_modules, state or private keys packaged |
| Production npm dependency audit | Zero known vulnerabilities reported; see reviews/npm-audit.json |
| Contract and implementation reviews | See reviews/REVIEW.md; retained tool findings include documented false positives and capability-specific exceptions |

The isolated acceptance harness creates a fresh account with in-memory random
test credentials, uses the upstream web vault and checksum-pinned OSS CLI,
and destroys the test containers and volatile vault database afterward. Its
browser accepts only the fixture's self-signed certificate for UI testing;
the actual importer uses the supplied CA and certificate verification. No
production transport has an insecure TLS flag.

CLI 2026.9.0 failed login after successful authentication in the same disposable
setup, before project imports. The working 2026.8.0 release is explicitly pinned;
see DECISIONS.md for the compatibility decision.

## Deployment and release boundaries

The first private installation is enrolled and delivering to a dedicated
organization and collection. On 2026-09-18, a synthetic login and secure note
both returned imported receipts, matched exact content on private CLI read-back,
and remained single items after retries. A prior smoke deposit also reconciled
after restart. The owner confirmed the items looked correct in their normal
client. Private addresses, account names, IDs and configuration remain in the
separate infrastructure repository. A queued receipt alone is not proof of
vault delivery.

Hosted Claude/ChatGPT OAuth enrollment has not been demonstrated. The remote
adapter's JWT, discovery, principal binding, origin and direct-call behavior were
tested locally; deployments still need a compatible issuer, client registration
and reachable HTTPS endpoint. Arm64 image execution and specific mobile/desktop Bitwarden
app-version checks have not been run. Do not extend the tested compatibility claim to them.

Source is published on GitHub. npm registry publication and public importer-image
redistribution are separate release steps, not performed by building this package. The optional GPL CLI binary is absent from the npm
package and default image; public importer distribution needs a complete-source
compliance procedure described in DEPENDENCIES.md.

## Reproduce

```sh
npm ci --ignore-scripts
npm test
node scripts/contracts.mjs
npm audit --omit=dev
npm pack --dry-run
docker compose -f test/compose.acceptance.yaml build acceptance
docker compose -f test/compose.acceptance.yaml up --abort-on-container-exit --exit-code-from acceptance
docker compose -f test/compose.acceptance.yaml down --volumes
```

The compatibility harness needs an amd64/arm64 Docker host with approximately
2 GB available for its browser/CLI runner. Always run the final cleanup command,
including after a failed test. CI uses an unconditional cleanup step.
