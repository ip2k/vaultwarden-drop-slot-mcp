# Enrollment

For a first installation, follow the [step-by-step setup walkthrough](SETUP.md).
This page explains enrollment material, trust boundaries and additional writers.

Generate material on an owner-controlled machine with the installed executable:

```sh
node dist/cli.js init /private/new-enrollment-directory
```

The directory must not exist. It is created with mode 0700, and files with mode
0600. No private key or token is printed. The command generates a dedicated age
identity, recipient, initial `default` writer token, separate importer token,
hashed auth database, and starter configurations. It does not unlock a vault.
The initial writer expires in 90 days; renew or rotate deliberately.

The generated directory is **enrollment staging**, not a container mount. Split
its contents according to the trust boundaries before starting services:

| Location | Files |
| --- | --- |
| Each producer | Its own token, pinned recipient/key_id in client.json, private ciphertext spool |
| Inbox | auth.json containing token hashes, public recipient configuration, server TLS leaf certificate/key, queue directory |
| Private importer | age identity, importer token, private CLI session file, CLI encrypted state, delivery ledger, routing config |

Keep an encrypted offline backup of recipient identities. Never mount the entire
enrollment directory or importer state into the inbox or an agent's container.
Do not put private material in shared/NFS datasets, repositories or logs.

## Transport and recipient pin

Install a verified server TLS certificate and its private key. For a private CA,
distribute the CA certificate through a trusted administrative channel and set
`ca_file` in clients/importer. Include all actual client DNS names/IPs in the
server certificate. The Compose example requires `localhost` for health checks
and `inbox` for private worker traffic. Never disable certificate verification.

Verify the recipient fingerprint independently during enrollment. `key_id` is
the lowercase SHA-256 of the exact ASCII age recipient. The key in local config
is authoritative; `GET /v1/recipient` is an authenticated enrollment helper and
does not authorize silently adopting a new key.

TLS credentials authenticate transport. The recipient encrypts an item. The
deposit token authorizes creation. Rotate them independently.

## Compose directories and permissions

Copy and edit the examples outside the checkout. Use separate directories for
inbox configuration/TLS, importer secrets and producer credentials. Containers
run as UID 1000 by default; either set `user` to your dedicated service UID or
make only the corresponding files/directories accessible to UID 1000. Secret
files must be 0600. Queue, ledger and CLI-state directories must be writable by
their service user. Never solve a permission failure with mode 0777.

Use **directory mounts containing only that service's files** for credentials
which rotate. Replacing an individually bind-mounted file atomically can leave
the container reading its old inode. The inbox reloads auth.json on every request,
but the mount must actually present the new file.

Initialize named volumes with the matching service ownership before starting
Compose; or replace them with pre-created private bind directories. Start only
the inbox first, then verify TLS and a missing-token 401 response. The worker
listener is not published to the host.

## Dedicated vault account

Use the stock Bitwarden web/desktop clients to create a dedicated automation
account and a separate organization. Share that organization with your normal
account; give the importer only the destination access it needs. Store the
automation credentials in your owner vault. Enrollment/organization invitations
are owner actions; the service cannot manufacture access to an encrypted vault.

On the **private importer host**, with its own CLI state directory, configure
the pinned OSS executable against your Vaultwarden HTTPS URL and log in using
the stock interactive CLI. The owner types the password; never paste it into
an agent transcript. `bw login --apikey` can authenticate with API credentials
but still needs an unlocked vault for item operations.

Capture `bw unlock --raw` directly into the service's mode-0600 session file
without displaying stdout (use a private terminal and restrictive umask). The
CLI state directory and session file must belong to the importer identity, not
to an agent. A retained session enables unattended delivery until it is revoked
or invalidated. Removing the session file implements owner-unlocked mode:
deposits queue until a valid session is supplied again. Session replacement
must use a containing-directory mount so it becomes visible to the importer.

Configure importer.json with the organization UUID and allowed collection UUIDs.
These come from the owner, never from a submitted payload. Obtain the executable
hash from `/app/bw.sha256` inside the locally built importer image; it is a public
integrity value. The archive and executable version are pinned to OSS 2026.8.0.

Start the importer profile only after checking all mounts and routing. Submit a
synthetic login and note, wait for imported receipts, and open them in your normal
Bitwarden clients. Until then, real-vault enrollment is pending.

For deliberate personal-vault access, a route is
`{"mode":"personal","allow_personal_vault":true}`. This grants the importer
access to the account's personal vault and should not be the default.

## More writers

Generate a new random 32-byte base64url token separately for each agent. Store
only its SHA-256 hash in the inbox's auth.json, along with a unique immutable
writer ID, UTC expiration and quotas. Add that ID to the private importer's
administrator-owned destination map. Give the agent only its own token and
client config. Never repurpose an existing writer ID for another principal or
change a pending writer's destination in place.

The simplest operational tool is a short owner-run script using Node's
`crypto.randomBytes(32)` and `crypto.createHash('sha256')`, writing the token to
a new 0600 file and the hash into the auth database. Avoid printing either
configuration through an agent or logging shell tracing.
