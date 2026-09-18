# Security policy

This is pre-release software. The recorded tests and threat model describe what
has been checked; they are not an independent security audit.

Report vulnerabilities privately through the repository's Security advisories
when enabled. Do not put credentials, plaintext deposits, real tokens, private
keys, or vault exports in issues. Until a private reporting channel is enabled,
ask the maintainer to establish one without posting exploit details.

The current 0.1 branch receives fixes. Run a dedicated importer identity and
account, restrict the private worker port, pin dependencies, and keep queue and
importer-ledger backups consistent. Read docs/THREAT-MODEL.md before deployment.

If a deposit token leaks, revoke its writer in auth.json and issue a new token.
If an importer/host is compromised, assume all items accessible to its vault
account are exposed. Rotate that account's credentials, deposited secrets and
recipient identities through an owner-controlled process. Do not just rotate
the deposit token.
