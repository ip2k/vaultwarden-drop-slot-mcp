# Connect an MCP client

Complete [setup](SETUP.md) and verify a synthetic CLI deposit first. The inbox
must be reachable from the machine launching the adapter. MCP connection alone
does not enroll a vault, start an importer, or grant collection access.

## Choose a transport

| Client environment | Use | Connect to |
| --- | --- | --- |
| Claude Code, Codex, a desktop client with local processes | Local stdio adapter | `node /absolute/path/dist/cli.js stdio /private/path/client.json` |
| A local client using Docker instead of a host Node runtime | Docker stdio adapter | A runtime container with producer files only |
| A hosted assistant or client that requires a URL | Optional OAuth HTTP adapter | `https://mcp.example.com/mcp` |

**The inbox URL is not an MCP endpoint.** It exposes the deposit API. Local stdio
adapters call it on your behalf. Remote MCP requires a separately configured
`mcp-http` process and an existing OAuth authorization server.

## Prepare the producer config

The setup walkthrough creates `producer/client.json`. It contains the inbox URL,
writer ID, public age recipient and verified fingerprint, plus absolute local
paths for the 0600 token file, public CA and writable ciphertext spool. It never
contains a vault login or age private key. Do not paste its token into chat.

Find your Node executable with `command -v node` (24.2+). Use its absolute path
in desktop configurations if Node is installed with a shell version manager.
All examples below use fictional paths; replace them with the actual paths on
**the machine that runs the MCP process**, not paths on the Docker server.

## Claude Code

Register a stdio server at user scope:

```sh
claude mcp add --transport stdio --scope user vaultwarden-drop-slot -- \
  /absolute/path/to/node /absolute/path/to/vaultwarden-drop-slot-mcp/dist/cli.js \
  stdio /private/path/to/producer/client.json
claude mcp get vaultwarden-drop-slot
```

Open a new Claude Code session and use `/mcp` to inspect connection status and
tools. Keep credentials in the private producer files; the registration stores
only executable/config paths. User scope makes this registration available
across your projects, so use a narrower scope if that is not your intent.
See [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).

## Codex

Register the same local process:

```sh
codex mcp add vaultwarden-drop-slot -- \
  /absolute/path/to/node /absolute/path/to/vaultwarden-drop-slot-mcp/dist/cli.js \
  stdio /private/path/to/producer/client.json
codex mcp list
```

Alternatively, merge this entry into your Codex `config.toml`:

```toml
[mcp_servers.vaultwarden-drop-slot]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/vaultwarden-drop-slot-mcp/dist/cli.js", "stdio", "/private/path/to/producer/client.json"]
```

Restart/reload the client or open a new task so it discovers the server. The
command syntax was checked against `codex mcp add --help`; use your installed
client's help for version-specific configuration and approval controls.

## Claude Desktop and other JSON-configured clients

In Claude Desktop, open **Settings → Developer → Edit Config**, merge the server
entry below into `mcpServers`, then fully quit and reopen the app. Preserve any
other servers already configured. Other clients with an `mcpServers` JSON format
can use the same entry in their own MCP settings.

```json
{
  "mcpServers": {
    "vaultwarden-drop-slot": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/vaultwarden-drop-slot-mcp/dist/cli.js",
        "stdio",
        "/private/path/to/producer/client.json"
      ]
    }
  }
}
```

See the [MCP local-server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
for the desktop configuration location and connection troubleshooting. These are
setup instructions, not a claim that every desktop client/version was tested.
The server's stdio transport is tested against the official MCP SDK.

## Docker stdio on the same host as the example inbox

This option assumes the MCP client can use that host's Docker daemon. Build the
runtime image first, and use the existing `vault-drop-slot_ingress` network so
`inbox` resolves. Do **not** use `-t`: a pseudo-terminal corrupts the stdio protocol.
Keep `-i` so the client can send MCP messages.

From the private deployment directory, prepare container-specific paths:

```sh
mkdir -p producer/spool
chmod 700 producer/spool
node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const c=JSON.parse(readFileSync('producer/client.json','utf8'));
Object.assign(c,{inbox_url:'https://inbox:8443',token_file:'/client/token.txt',
  ca_file:'/client/ca.crt',spool_dir:'/state'});
writeFileSync('producer/client.docker.json',JSON.stringify(c,null,2)+'\n',{mode:0o600});
JS
```

Use a UID/GID matching the owner of `producer/` and `producer/spool` (`id -u`
and `id -g`); replace `1000:1000` below if different. For another Docker host or
network, use a reachable inbox URL and a matching certificate instead of `inbox`.

```json
{
  "mcpServers": {
    "vaultwarden-drop-slot": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i", "--network", "vault-drop-slot_ingress",
        "--user", "1000:1000", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--memory=256m", "--cpus=1",
        "--pids-limit=64", "--ulimit=core=0", "--log-driver=none",
        "-v", "/absolute/private/producer:/client:ro",
        "-v", "/absolute/private/producer/spool:/state",
        "vaultwarden-drop-slot-mcp:0.1.0", "stdio", "/client/client.docker.json"
      ]
    }
  }
}
```

Only producer material is mounted. The adapter does not need the enrollment
staging directory, importer identity/session, vault state or Docker socket.

## Remote Streamable HTTP (optional)

Follow [remote MCP setup](REMOTE-MCP.md) to configure native HTTPS, your OAuth
issuer/JWKS, exact resource audience, required scopes and a subject/client binding
to an enrolled writer. Then start the adapter on your server:

```sh
node /absolute/path/dist/cli.js mcp-http /private/path/remote.json
```

Connect clients to the adapter's `/mcp` URL, for example:

```sh
claude mcp add --transport http vaultwarden-drop-slot https://mcp.example.com/mcp
codex mcp add vaultwarden-drop-slot --url https://mcp.example.com/mcp
```

Complete the client's OAuth sign-in against your configured provider. A writer
bearer token is **not** an OAuth access token. Do not place it into remote-client
Authorization settings. The adapter maps approved identities to private writer
configs and requires both `deposits:write` and `deposits:status` scopes.

Hosted clients need a reachable, trusted HTTPS endpoint and compatible OAuth
registration/discovery. Hosted Claude/ChatGPT enrollment has not been demonstrated;
do not assume a localhost/LAN-only URL works from a cloud service. The remote
adapter and the AI provider can see plaintext tool arguments. If that is outside
your intended trust boundary, generate and deposit through a local script instead.

## Verify the connection with synthetic data

The client should discover exactly **two** tools:

| Tool | Input | Output |
| --- | --- | --- |
| `deposit_secret` | Fresh request UUID and a login/secure-note payload | Opaque receipt and state |
| `deposit_status` | That writer's receipt UUID | `queued`, `importing`, `imported`, or `failed` |

Ask the assistant to create a fresh UUID and call `deposit_secret` with this
synthetic payload (the `payload` object is nested inside the tool arguments):

```json
{
  "request_id": "REPLACE_WITH_A_FRESH_UUID",
  "payload": {
    "type": "login",
    "name": "Drop Slot MCP connection test",
    "username": "test@example.invalid",
    "password": "synthetic-test-value-not-a-real-secret",
    "urls": ["https://example.invalid"],
    "notes": "Synthetic MCP verification only."
  }
}
```

Then call `deposit_status` with the returned receipt until `imported`, sync your
normal Bitwarden client, and open the item in the configured collection. Test
secure notes with `type: "secure_note"`, `name` and `notes`; omit login-only fields.
A connected server with two listed tools is only a transport check, not proof of
delivery. No tool should return the item name, password or a vault identifier.

Retry a timed-out deposit with the **same UUID**. The retained spool sends the
original ciphertext, even if changed arguments accompany that UUID. A new item
requires a new UUID. Never ask an agent to prove write-only behavior by handing
it a master password or by adding a general-purpose Bitwarden CLI tool.

## Troubleshooting

- **Server missing:** verify executable/config absolute paths, rebuild `dist/`,
  check the Node version, then restart the MCP client. A manually launched stdio
  server waiting silently for input is normal.
- **Tools listed but calls fail:** check inbox reachability, token validity,
  0600 ownership, CA trust, the pinned recipient, and writer quotas.
- **Docker cannot reach localhost:** localhost is the container itself. Use the
  Compose network and `https://inbox:8443`, or a reachable host name covered by TLS.
- **Remote 401/403:** check OAuth audience, issuer, expiry, both scopes, binding,
  Host and allowed Origin. Do not work around it by disabling authentication.
- **Queued/importing/failed receipts:** follow [setup troubleshooting](SETUP.md#troubleshooting-and-routine-operation)
  and [recovery](OPERATIONS.md#ambiguous-delivery).

Keep MCP client logs and model transcripts in your privacy assessment: this
server avoids logging payloads, but cannot control a host client's tracing.
