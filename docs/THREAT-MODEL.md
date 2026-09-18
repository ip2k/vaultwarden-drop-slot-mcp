# Security design

Status: initial implementation and acceptance review completed. This document is a
threat model, not a third-party audit or certification.

## Boundaries

1. Producer / local MCP adapter: sees a new secret; holds a pinned age X25519
   recipient and a writer token, never a vault session or age identity.
2. HTTPS deposit flow: ciphertext plus random IDs. TLS validates the service;
   the separately enrolled recipient pin authenticates the encryption key.
3. Inbox / SQLite queue: authenticates writers; stores ciphertext, token hashes,
   writer IDs, timestamps and receipts. No plaintext, age identity or vault login.
4. Private importer: pulls with a different credential; decrypts, validates,
   routes by its own administrator-owned writer map, and runs the OSS CLI.
5. Vaultwarden: owns ordinary encrypted vault records. The importer can read all
   items its account can access. Use a dedicated account and organization.
6. Optional HTTP MCP adapter: verifies OAuth access tokens through an existing
   issuer; plaintext tool input crosses this service and the AI provider. This
   is not client-device encryption. It forwards using a separately configured
   writer token, never a user's OAuth token.

The machine administrator and importer are trusted. Container separation is
not a defense against host root or someone with Docker/cluster-admin access.
Remote MCP is opt-in; local stdio plus encrypted HTTPS deposits is the default.

## STRIDE review and ownership

Owner for every implementation mitigation below: project maintainers, reviewed
through the approved Code Review skill. Operational controls belong to the
deploying administrator. Scores are qualitative DREAD averages, not probabilities.
Generated baseline tool reports are in `reviews/threats-*.json`; this table
specializes those generic findings to the actual design.

| Element / STRIDE | Threat | DREAD | Mitigation / verification |
| --- | --- | --- | --- |
| Producer / S,R | Stolen token impersonates a writer | 8 | 256-bit tokens; hashes only in inbox; expiry, revocation, bounded quota. The holder can still inject garbage. Auth tests. |
| Encryption flow / T,I | Inbox replaces public key or redirects transport | 9 | Locally pinned recipient/fingerprint; no automatic key adoption; verified HTTPS and redirects disabled. Pin/TLS tests. |
| Inbox / E,I | Raw API or MCP bypass reveals or changes items | 10 | Only deposit and own-status interfaces; worker identity isolated; no vault credentials. Negative API/MCP tests. |
| Queue / T,R | Replay, competing claims, rollback | 8 | Transactional queue and immutable envelope digest; writer/request namespace; fencing token. Independent importer ledger retains creation intent. Recovery tests. |
| Queue / D | Large bodies, receipt spam, indefinite backlog | 8 | Body, field, queue and per-writer limits; persistent daily counters; bounded retries and ciphertext retention. Limit tests. Frontend connection limits owned by operator. |
| Importer / E | Agent chooses a destination, file or command | 10 | Strict schema; administrator-only routing; fixed CLI executable/verbs; no shell. Injection tests. |
| Importer / I | Plaintext leaks through CLI, logs or crash | 10 | stdin for item; child env for session; ignore child stderr; generic errors; no plaintext temporary files; encrypted CLI cache and private state; disable core dumps. Log/argv tests. Memory is not guaranteed zeroized by JavaScript. |
| Importer / T,R | Create succeeded, ack lost, duplicate retry | 9 | Persist intent before create; encrypted marker; verify by sync/read; never automatically issue a second create for an intent. An unresolved outcome fails closed and needs operator review. |
| Vault / I,E | Importer compromise reads destination account | 10 | Dedicated automation account and separate organization; personal vault requires explicit opt-in. Operator enrollment and client verification. |
| HTTP MCP / S,E | Invalid issuer/audience/scope or cross-user confused deputy | 10 | JWT verification with explicit algorithm/issuer/audience/expiry; subject-to-writer allowlist; scoped access; auth on every request; no token passthrough. OAuth/MCP tests. |
| HTTP MCP / I,T | Proxy/provider logs plaintext or prompt injects a tool | 9 | Document plaintext boundary; no body/access logging; restricted tools and quotas. Prompt injection cannot gain read capability, but can submit garbage. Operator disables upstream tracing. |
| Private flow / S,I | Writer uses worker interface | 9 | Separate worker token hash and separate TLS listener; auth checked before body parsing. Cross-role tests. |

## Delivery guarantee and failure policy

Vaultwarden does not offer an atomic transaction shared with our queue. Do not
claim universal exactly-once delivery. A durable importer ledger permits at
most one create attempt per writer/request ID, followed by marker reconciliation.
If a process dies after intent persistence but before create, delivery requires
owner recovery. This sacrifices automatic liveness to avoid silent duplicates.
Never delete or restore the ledger independently of the vault and queue; a stale
backup or manual marker deletion can invalidate guarantees. Maintain one logical
importer and its durable ledger for each inbox installation.

## Explicit exclusions

No vault-reading tools, attachments, edits, deletes, arbitrary fetches, shell
commands, or agent-supplied source paths. URLs are inert stored strings. No public
unauthenticated MCP service. No self-built OAuth server. No claim to protect
plaintext from the originating agent, its provider, an HTTP MCP adapter, or root.
