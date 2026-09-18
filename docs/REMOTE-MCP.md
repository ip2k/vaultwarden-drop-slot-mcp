# OAuth-protected remote MCP

Use an existing OAuth provider such as a self-hosted identity service. This
package is a resource server, not an authorization server. Use authorization
code with PKCE and resource indicators in your provider/client integration.
Do not forward access tokens to the inbox or another service.

Configure `examples/remote.json` with a fixed HTTPS `/mcp` resource URL, trusted
issuer and JWKS URL, and one accepted asymmetric JWT algorithm. The access token
must include that exact resource URL as audience, valid `exp` and `iat`, a `sub`,
a `client_id`, and a space-delimited scope with both `deposits:write` and
`deposits:status`. ID tokens and tokens for other resources must not be used.

The bindings file is an array of:

```json
[
  {
    "subject": "SUBJECT_FROM_YOUR_PROVIDER",
    "client_id": "APPROVED_OAUTH_CLIENT",
    "client": {
      "inbox_url": "https://drop-slot.example.com",
      "writer_id": "assistant-a",
      "token_file": "/run/secrets/assistant-a-token.txt",
      "recipient": "ENROLLED_AGE_RECIPIENT",
      "key_id": "VERIFIED_SHA256_FINGERPRINT",
      "spool_dir": "/state/assistant-a"
    }
  }
]
```

Bindings reload for every request. Removing a binding blocks the next request;
revoking the underlying writer token also stops the adapter from depositing or
reading status. Self-contained JWTs are otherwise valid until expiry; configure
short lifetimes and your provider's own revocation controls. Never map multiple
unrelated principals to a shared writer if their receipts must be isolated.

Missing/invalid authorization returns 401 with a `WWW-Authenticate` challenge
pointing to `/.well-known/oauth-protected-resource/mcp`. The resource metadata
declares the configured issuer. The MCP SDK implements stateless Streamable HTTP;
GET/DELETE on `/mcp` return 405. The adapter verifies Host, validates any Origin
against an explicit allowlist, and permits 60 requests per mapped principal per
minute. It is a single-instance MVP; use one adapter per spool and enforce outer
connection limits at your own HTTPS ingress when exposing it publicly.

Serve native HTTPS or an authenticated, correctly configured passthrough route.
No forwarded-header trust or insecure HTTP mode is implemented. Disable request
body capture, APM payload tracing, proxy body logging and core dumps. Tools see
plaintext: the adapter and the hosted AI provider are inside that trust boundary.

Hosted Claude/ChatGPT compatibility depends on provider discovery, OAuth client
registration and the client's token conventions. A passing local OAuth/HTTP MCP
test is not a claim that a particular hosted provider is enrolled and working.

Reference: [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
