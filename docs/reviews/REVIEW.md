# Implementation review

Reviewed 2026-09-17 using the approved API Design Reviewer, MCP Server Builder,
Docker Development, Senior Security and Code Review workflows. This is an
implementation review, not an independent penetration test or certification.

## Security and correctness

No outstanding critical/high implementation finding from this review. The
threat model retains explicit risks for a compromised importer/host, malicious
deposit-token holders, producer/provider plaintext, denial of service, and
coordinated backup restoration. Those are trust/operational boundaries rather
than hidden guarantees.

Review fixes include atomic producer spool publication, durable creation intent
and lease fencing, per-request revocation, bounded single-X25519 age headers,
generic validation errors, separate worker identity, executable integrity and
version checks, fixed subprocess arguments, secret file permissions, native mTLS,
and directory mounts that expose atomically rotated credentials. Regression
tests exercise those boundaries, including malformed direct MCP requests.

The importer pins OSS CLI 2026.8.0 after a real compatibility test. CLI 2026.9.0
authenticated but failed internally before importing; see DECISIONS.md. Version
pins must be revisited with the same disposable stock-client harness, not relaxed.

## Tool findings and dispositions

| Tool | Result | Disposition |
| --- | --- | --- |
| API linter | 94.33; zero errors, five naming warnings, two informational statuses | Keep consistent protocol snake_case. 202 correctly means accepted/queued; 413 correctly enforces bounded requests. |
| API scorecard | 67.35, grade D | Preserve raw result. Generic list/search/pagination, cache and batch-update recommendations conflict with the deposit-only API. Endpoint descriptions, receipt example and auth/retry headers were improved. README/enrollment provide end-to-end examples. No prior API exists for a breaking-change comparison. |
| MCP manifest validator | Two tools; zero errors/warnings | Runtime schemas generate the manifest. Full protocol tests use the official SDK. |
| Secret scanner | Seven high-pattern matches; zero actionable secrets | Every match was verified as an npm SHA-512 integrity value in the lockfile/inventory. Raw matches and per-finding dispositions are retained. |
| Dockerfile analyzer | 88; no high/critical findings | Multiple CMDs belong to different stages; downloaded archive and apt lists are removed in their layer. Runtime roles differ, so Compose supplies the inbox TLS health check. The analyzer mistakes the final named stage for an unpinned base. |
| Compose validator | 93; no high/critical findings | Explicit ingress/internal/vault networks exist despite the parser's warning. Importer has process supervision and bounded delivery failures; it has no separate readiness endpoint. Monitor own receipts and queued age operationally. |

No read/search/edit/delete capability was added to increase a generic score.

## Remaining release checks

See ../VERIFICATION.md for actual test results and outstanding deployment/client
enrollment. Arm64 archive hashes are pinned, but this review executed containers
on amd64 only. Hosted OAuth enrollment and independent security review remain
outside the demonstrated test results.
