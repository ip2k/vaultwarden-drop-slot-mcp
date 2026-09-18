# Dependencies and ownership

Personal open-source project. No business account or commercial asset is assumed.
The intended GitHub owner is the maintainer's `ip2k` account. npm ownership and
public publication are pending. No runtime service depends on that maintainer's
LAN, GitHub account, hosted model provider, or personal credentials.

| Component | Pin | License | Use |
| --- | --- | --- | --- |
| Original project | 0.1.0 | Apache-2.0 | MCP adapter, inbox, importer, docs |
| age-encryption / typage | 0.3.1 | BSD-3-Clause | age encryption maintained by the age author |
| Official MCP TypeScript SDK | 1.30.0 | MIT | Protocol and transports |
| Express | 5.2.1 | MIT | Bounded HTTP routing |
| jose | 6.2.12 | MIT | JWT signature/claim verification and JWKS |
| Zod | 4.6.5 | MIT | Strict schemas and JSON Schema contracts |
| Node.js | 24 image pinned by digest in Dockerfile | MIT and bundled notices | Runtime and SQLite |
| Bitwarden CLI OSS | 2026.8.0 | GPL-3.0 | Separate executable in optional importer image |
| Playwright | 1.63.0 | Apache-2.0 | Disposable compatibility tests only |
| Vaultwarden server | 1.37.3 image pinned by digest | AGPL-3.0 | Disposable test target; not bundled in npm |

All resolved npm runtime dependency licenses in the lockfile are MIT,
BSD-3-Clause, BSD-2-Clause or ISC. The machine-readable
[inventory](dependency-inventory.json) records their versions, SPDX fields and
integrity hashes. The lockfile is authoritative for resolution. Dev/test-only
dependencies are excluded from the production image and runtime inventory.
`npm ci --ignore-scripts` prevents dependency lifecycle scripts at build/install.

The optional importer image downloads the named **OSS** Bitwarden release assets
and verifies the archive SHA-256 before extraction. The runtime verifies the
configured executable SHA-256 and version. The ordinary npm Bitwarden package
is intentionally not a dependency: Bitwarden documents its default distributed
build as including non-OSS features.

No public importer-image distribution is configured. Before distributing it,
include the CLI's GPL license and provide its complete corresponding source in
accordance with GPL-3.0. An unmodified source checkout at the same release tag is
the starting point; a link alone is not treated here as an audited redistribution
compliance procedure. The default image and npm package contain no CLI binary.

Sources: [age TypeScript implementation](https://github.com/FiloSottile/typage),
[MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk),
[Bitwarden CLI distribution documentation](https://bitwarden.com/help/cli/),
[OSS CLI release](https://github.com/bitwarden/clients/releases/tag/cli-v2026.8.0),
[Bitwarden source license](https://github.com/bitwarden/clients/blob/cli-v2026.8.0/LICENSE.txt).

## Operator-owned assets

Each installation owns its TLS certificate/CA, age identities, writer tokens,
importer token, dedicated vault account/organization, encrypted CLI cache,
SQLite state, backups and any OAuth provider/client registrations. None are
embedded in the package. Document their owners and rotation dates locally;
never put the values in this repository.
