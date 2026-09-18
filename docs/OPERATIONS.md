# Operations and recovery

Use one inbox and one logical importer per installation. SQLite must be on local
durable storage, not a network filesystem. Keep the private importer on an
owner-controlled host; container separation does not protect against root,
Docker access or cluster-admin. Disable core dumps and unencrypted swap for
processes holding plaintext where your host policy permits it.

## Rotation and revocation

- **Writer token:** set `revoked:true` or expire its auth record. Rotate the hash
  and deliver the replacement token through the owner's credential channel. Keep
  the writer ID stable so its prior receipts and quota history remain attached.
- **Importer token:** replace the inbox hash and the importer file together.
  Writers cannot use this token on public routes, and writer tokens cannot claim
  or acknowledge jobs.
- **Recipient:** generate a new identity on the importer host, add its public
  recipient to the inbox, and put it first for new enrollment. Enroll producers
  with an independently verified new fingerprint. Keep old public recipients
  accepted for retried envelopes, and old private identities available until
  the corresponding queue/spools are drained. Never silently fetch-and-trust.
- **TLS:** renew certificates before expiry. Restart the native HTTPS service to
  load new files. Private CA changes require new trusted enrollment. A CA bundle
  can contain both inbox and vault roots.

The runtime accepts optional `client_ca_file` to require client certificates on
its HTTPS listeners. Stdio/Node clients and the importer can supply
`client_cert_file` and `client_key_file` together for mTLS. OAuth or bearer
authorization remains required. The client private-key file must be 0600.

## Backups and retention

Use SQLite's online backup API, or stop the owning process and copy the database
with its WAL state consistently. Do not copy an active main SQLite file alone.
Queue backups contain ciphertext and non-secret operational metadata; importer
ledger backups contain markers, envelope digests and intent/verification state.
The Bitwarden CLI stores encrypted vault cache on disk; private keys and session
material require encrypted backups and separate access control.

Coordinate vault, queue and ledger restoration. Restoring the ledger to a point
before an acknowledged creation while also deleting the vault marker can defeat
duplicate prevention. Never prune ledger entries independently or share two
uncoordinated ledgers with the same inbox.

Delivered ciphertext is nulled immediately after acknowledgment. Failed/pending
ciphertext expires after the configured retention; cleanup runs on intake,
claiming and a one-minute timer. Old WAL files and backups may retain ciphertext,
so deletion is not a promise of cryptographic erasure. Receipt tombstones remain
to prevent request-ID reuse. At the configured record cap new deposits fail
closed; archive the installation under owner control instead of deleting
tombstones while producers might retry them.

The producer spool contains ciphertext only, is bounded at 10,000 entries and
retains envelopes for retries. Remove entries only when the application no longer
needs to retry them. Re-encrypting the same request UUID after deleting its spool
entry produces a 409 rather than silently replacing a prior item.

## Ambiguous delivery

`imported` means private verification found the submission marker in the configured
destination. `failed` carries no item data or private diagnostic to the writer.
An operator can inspect the private ledger/queue locally for intent and state;
never publish a vault lookup or its results as an MCP tool.

An `intent` with no matching item is ambiguous: the create may not have reached
the server, may still be processing, or may have been rejected. The worker retries
only the private reconciliation lookup. After five attempts it fails closed.
Do not delete the intent and automatically retry. Stop the importer, wait for all
in-flight requests to finish, inspect the actual destination and its trash/history
using the owner's stock client, and establish whether creation occurred. If it
definitely did not, the owner may deliberately submit a new request UUID. This
is an operator decision, not an automated exactly-once guarantee.

Changing a writer's destination while requests are pending can cause routing
ambiguity; use a new writer ID for a new destination. The ledger rejects a
changed envelope digest or destination for an already-known intent.

## Error codes

Public responses are generic: `invalid_input`, `unknown_key`, `unauthorized`,
`not_found`, `request_conflict`, `quota_exceeded`, `item_too_large`, and
`internal_error`. Client transport failures do not include response bodies,
URLs, certificate dumps or tokens. MCP tool errors never echo validation input.
Do not add debug logging of request/response bodies or child-process output.
