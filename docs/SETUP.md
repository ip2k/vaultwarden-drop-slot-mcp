# Setup walkthrough

This walkthrough installs one inbox and one private importer on a Linux Docker
host, then enrolls a local producer. You need Docker with Compose v2, Node.js
24.2+, Git, OpenSSL, and an existing Vaultwarden instance reachable over HTTPS.
Run these commands in an owner-controlled terminal. The host must resolve and
reach your Vaultwarden URL from Docker containers.

Keep your normal vault account in the stock web client. The importer uses a
separate account, organization and CLI state. No API modification or Vaultwarden
admin token is needed. The example binds intake to `127.0.0.1:8443`; choose a free
port if your vault already uses it. The internal worker port is never published.

## 1. Build the package and images

```sh
git clone https://github.com/ip2k/vaultwarden-drop-slot-mcp.git
cd vaultwarden-drop-slot-mcp
npm ci --ignore-scripts
npm test
npm run build
export DROP_SLOT_SOURCE_DIR="$(pwd)"
docker build --target runtime -t vaultwarden-drop-slot-mcp:0.1.0 .
docker build --target importer -t vaultwarden-drop-slot-importer:0.1.0 .
```

The importer image downloads a checksum-pinned upstream OSS Bitwarden CLI.
The ordinary image and npm package do not include it. Build locally; public
redistribution of an importer image has additional [GPL source obligations](DEPENDENCIES.md).
If your host applies a batch cgroup or other resource policy, use it for builds
and disposable checks. The example services already have memory/CPU limits.

## 2. Create private deployment files

Keep these files outside the repository. Keep the exported variables in this
terminal; in a new terminal, set them again before following later steps.

```sh
umask 077
export DROP_SLOT_HOME="$HOME/.local/share/vaultwarden-drop-slot"
mkdir -p "$DROP_SLOT_HOME"
cd "$DROP_SLOT_HOME"
cp "$DROP_SLOT_SOURCE_DIR/examples/compose.yaml" compose.yaml
mkdir -p config/inbox config/importer secrets/inbox-tls secrets/importer secrets/importer-ca producer
node "$DROP_SLOT_SOURCE_DIR/dist/cli.js" init "$DROP_SLOT_HOME/enrollment"
cp enrollment/auth.json config/inbox/auth.json
cp enrollment/identity.txt enrollment/importer-token.txt secrets/importer/
cp enrollment/writer-token.txt producer/token.txt
cp "$DROP_SLOT_SOURCE_DIR/examples/inbox.json" config/inbox/inbox.json
cp "$DROP_SLOT_SOURCE_DIR/examples/importer.json" config/importer/importer.json
```

`init` requires a new directory and never prints private keys or tokens. Do not
rerun it to repair an existing installation: that would generate a different
identity. Its `enrollment` directory is owner-only staging, **never a service or
agent mount**. Keep an encrypted offline backup of the age identity.

Populate the inbox recipient and local producer paths without copying secrets
into command arguments:

```sh
node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{mode:0o600});
const {recipient,key_id}=read('enrollment/recipient.json');
const inbox=read('config/inbox/inbox.json');
inbox.recipients=[{recipient,key_id}];
save('config/inbox/inbox.json',inbox);
save('producer/client.json',{
  inbox_url:'https://localhost:8443',writer_id:'default',recipient,key_id,
  token_file:resolve('producer/token.txt'),spool_dir:resolve('producer/spool'),
  ca_file:resolve('producer/ca.crt')
});
JS
```

The `default` writer starts with a 90-day token, 100 new deposits per day and
100 pending deposits. Use a separate writer for each independent agent; see
[additional writers](ENROLLMENT.md#more-writers). The destination is chosen by the
operator, never by a tool argument.

## 3. Install TLS certificates

The inbox needs `server.crt`, `server.key` and a public CA bundle in
`secrets/inbox-tls`. The leaf certificate must cover **localhost** (health check),
**inbox** (private worker connection), and every name/address producers use.
Use your existing internal CA if you have one. Keep its signing key outside all
container mounts. The example below creates a private CA for a first local
installation; its certificates are not publicly trusted.

```sh
mkdir -p ca
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
  -keyout ca/root.key -out ca/root.crt -subj '/CN=Drop Slot local CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey rsa:3072 -nodes \
  -keyout secrets/inbox-tls/server.key -out ca/inbox.csr -subj '/CN=localhost'
cat > ca/inbox.ext <<'EXT'
subjectAltName=DNS:localhost,DNS:inbox,IP:127.0.0.1
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EXT
openssl x509 -req -in ca/inbox.csr -CA ca/root.crt -CAkey ca/root.key \
  -CAcreateserial -days 90 -sha256 -extfile ca/inbox.ext \
  -out secrets/inbox-tls/server.crt
cp ca/root.crt secrets/inbox-tls/ca.crt
cp ca/root.crt secrets/importer-ca/ca.crt
cp ca/root.crt producer/ca.crt
```

If Vaultwarden uses another private CA, append that **public** CA certificate to
`secrets/importer-ca/ca.crt`. For a vault with a publicly trusted certificate,
Node's built-in roots remain available alongside this extra CA bundle.
Never use `NODE_TLS_REJECT_UNAUTHORIZED=0` or disable certificate validation.
Renew the 90-day leaf before expiry and restart the inbox after replacement;
this example does not include an automatic renewal service.

For remote producers, choose your reachable inbox DNS name/IP, add it to the leaf
SANs **before issuing the certificate**, change the Compose published bind address
and producer `inbox_url`, and distribute the public CA through a trusted channel.
Keep the inbox and Vaultwarden URLs distinct. Use a VPN/private network or your
own authenticated deployment policy; do not publish the private worker port.

## 4. Set ownership and start only the inbox

The supplied images run as UID/GID 1000. The service config and secrets must be
readable only by that UID, and the named volumes must be writable. These commands
assume the standard example UID; if you choose dedicated service UIDs, set each
service's Compose `user` and corresponding ownership consistently instead.

```sh
sudo chown -R 1000:1000 config secrets
sudo find config secrets -type d -exec chmod 700 {} +
sudo find config secrets -type f -exec chmod 600 {} +
docker compose run --rm --no-deps --user 0:0 --entrypoint sh inbox \
  -c 'chown 1000:1000 /state'
docker compose --profile importer run --rm --no-deps --user 0:0 --entrypoint sh importer \
  -c 'chown 1000:1000 /state /bw'
docker compose up -d --no-build --wait inbox
curl --cacert producer/ca.crt https://localhost:8443/healthz
curl --cacert producer/ca.crt -o /dev/null -w '%{http_code}\n' \
  https://localhost:8443/v1/recipient
```

Expect a health response naming `vaultwarden-drop-slot-mcp`, followed by **401**
for the unauthenticated recipient request. A healthy inbox alone does not mean
a vault is enrolled. Keep each container's mounts limited to its own files;
never mount the whole deployment directory into a producer or the inbox.

## 5. Create the destination and dedicated account

In the stock Vaultwarden web vault, using your normal owner account:

1. Create an organization, for example **Automation**, and a collection, for
   example **Agent Deposits**. An existing dedicated organization is also fine.
2. Invite a separate email/alias you control as a **User**. Give it access only
   to the destination collection, with edit permission and password visibility.
3. In a private browser window, register/sign in as that dedicated user and
   accept the invitation. Store its unique master password in your owner vault.
4. Back as the owner, **confirm the member**. Then explicitly check the
   collection's Access settings. Organization membership alone does not grant
   access to a collection.
5. Verify the importer account can see Agent Deposits. Keep unrelated personal
   credentials out of this account and organization.

If public registration is disabled, an invited email can still register. If
email delivery is unavailable, the signup route is `https://YOUR-VAULT/#/signup`.
See [Vaultwarden registration guidance](https://github.com/dani-garcia/vaultwarden/wiki/Disable-registration-of-new-users)
and [Bitwarden's organization guide](https://bitwarden.com/help/getting-started-organizations/).
The importer needs private read access to reconcile and verify its own creates;
it is not a cryptographically write-only Vaultwarden account.

## 6. Enroll the CLI privately

Set your actual vault URL; this is **Vaultwarden**, not the new inbox:

```sh
export VAULT_URL='https://vault.example.com'
docker compose --profile importer run --rm --no-deps \
  --volume "$DROP_SLOT_HOME/secrets/importer:/run/secrets" \
  --volume "$DROP_SLOT_SOURCE_DIR/examples/enroll.sh:/enroll.sh:ro" \
  --env VAULT_URL --entrypoint /bin/bash importer /enroll.sh
```

Run this interactively in your own terminal, never through an agent transcript.
The script asks for the dedicated email and a hidden master password, captures
the raw session into a temporary 0600 file, verifies sync, and atomically installs
`secrets/importer/session.txt`. It unsets the password and removes temporary
session output on failure. It refuses to replace an existing session. The
writable secret-directory override is for this one enrollment container only;
the running importer mounts secrets read-only.

**Two-factor/device verification:** the helper uses noninteractive CLI login,
so it stops if the server requires an extra challenge. Do not disable account
protections to get past it. One supported stock-CLI alternative is to authenticate
with the dedicated account's personal API key in your private terminal, then run
the helper to unlock with its master password:

```sh
docker compose --profile importer run --rm --no-deps \
  --env HOME=/bw --env BITWARDENCLI_APPDATA_DIR=/bw \
  --env NODE_EXTRA_CA_CERTS=/tls/ca.crt --entrypoint bw importer login --apikey
# Then repeat the enrollment helper above; it detects the logged-in, locked state.
```

The earlier helper invocation configures the vault URL before attempting login.
API credentials authenticate; they do not unlock the encryption key. Enter them
only at stock CLI prompts. Consult the [Bitwarden CLI guide](https://bitwarden.com/help/cli/)
for your account's challenge method and API-key prerequisites. A retained unlocked
session authorizes unattended importing until invalidated; treat it as a secret.

## 7. Set organization and collection UUIDs

Read only routing metadata from the dedicated CLI. This does not list vault items
or print the session; output is limited to organization/collection names and IDs:

```sh
docker compose --profile importer run --rm --no-deps -T \
  --entrypoint node importer --input-type=module - <<'JS'
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/bw',BITWARDENCLI_APPDATA_DIR:'/bw',
  NODE_EXTRA_CA_CERTS:'/tls/ca.crt',BW_SESSION:readFileSync('/run/secrets/session.txt','utf8').trim()};
function run(args){const r=spawnSync('bw',[...args,'--nointeraction'],{env,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});if(r.status!==0)throw Error('Private CLI check failed');return r.stdout;}
run(['sync']);
for(const kind of ['organizations','collections']){
  console.log(kind,JSON.parse(run(['list',kind])).map(({id,name,organizationId})=>({id,name,organizationId})));
}
JS
docker compose --profile importer run --rm --no-deps --entrypoint cat importer /app/bw.sha256
```

Edit `config/importer/importer.json` as its owner (use `sudoedit` if necessary):

- `vault_url`: the same HTTPS vault URL used during login.
- `bw_sha256`: the **first field** of the hash command's output (64 hex characters).
- `destinations.default.organization_id`: your dedicated organization UUID.
- `destinations.default.collection_ids`: an array containing your collection UUID.

Keep all other example paths and the pinned `bw_version` unchanged. The private
worker URL is `https://inbox:8444`, reachable only inside the Compose network.
Do not use `bw list org-collections` for this check: ordinary Users should use
`bw list collections` to see their assigned collections. An empty result means
access is not ready; revisit step 5 before enabling delivery.

## 8. Enable delivery and test it

```sh
docker compose --profile importer up -d --no-build --wait
node --input-type=module <<'JS' | node "$DROP_SLOT_SOURCE_DIR/dist/cli.js" deposit "$DROP_SLOT_HOME/producer/client.json"
import {randomUUID} from 'node:crypto';
console.log(JSON.stringify({request_id:randomUUID(),payload:{
  type:'secure_note',name:'Drop Slot setup test',notes:'Synthetic setup test; no real secret.'
}}));
JS
node "$DROP_SLOT_SOURCE_DIR/dist/cli.js" status "$DROP_SLOT_HOME/producer/client.json" RECEIPT_UUID
```

Replace `RECEIPT_UUID` with the opaque receipt returned by the deposit command.
Check until the state becomes `imported`, then sync your normal Bitwarden client
and open **Drop Slot setup test** in the chosen collection. A queued receipt
is not success. Test a synthetic login as well before using real credentials.
Each new UUID creates a new test item; do not loop the deposit command while
waiting for status. Retrying one operation must reuse its original UUID/spool.

## 9. Connect an MCP client

Follow [MCP connections](MCP-CONNECTIONS.md). Give the producer only its writer
token, pinned public recipient/fingerprint, public CA and private spool directory.
If the producer runs on another machine, transfer only `producer/` through your
trusted administrative channel; edit its absolute paths and inbox URL for that
machine and independently verify the recipient fingerprint. Never transfer
`enrollment/`, importer secrets, the CLI session, or CA signing keys to an agent.

## Troubleshooting and routine operation

| Symptom | Check |
| --- | --- |
| `invalid_configuration` | Replace all importer placeholders; recipients must be populated; paths must be container paths in service configs and local absolute paths in producer configs. |
| `secret_unavailable` | Secret file exists, is 0600, belongs to the right UID, and its containing directory is mounted. |
| TLS failure | Correct CA bundle and SANs for localhost, inbox and the actual producer hostname; vault root included for private vault certificates. |
| CLI sees no collections | Invitation accepted, member confirmed, collection explicitly assigned with edit access. |
| Receipts stay queued | Importer profile enabled, account unlocked, intended writer route present, HTTPS vault reachable from the container. |
| Receipt importing after restart | Claims have a five-minute lease. Allow it to expire and reconciliation to complete. |
| Receipt failed / ambiguous intent | Follow [operator recovery](OPERATIONS.md#ambiguous-delivery); do not erase the ledger or blindly resubmit with new IDs. |

Back up the recipient identity, private CLI state/session, queue and ledger under
an encrypted, coordinated backup policy. Renew TLS and writer tokens before they
expire. Use one logical importer/ledger per installation. Stop it with
`docker compose stop importer`; the inbox can continue queuing within quotas and
retention. See [operations](OPERATIONS.md) for rotation and recovery.
