# Contribution candidates

No upstream bug is confirmed yet. Keep ordinary deployment preferences local.
The disposable compatibility harness reproduced an OSS CLI 2026.9.0 login/key
failure with Vaultwarden 1.37.3 while CLI 2026.8.0 passed the same flow. This
merits a minimized upstream reproducer and source investigation before assigning
blame; the release currently pins the working CLI. No report has been posted.
The generic API scorecard's preference for cacheable/list/batch APIs is a candidate
for an explicit capability/profile exemption if other security-focused APIs hit
the same limitation; no upstream issue or patch has been submitted.

Any contribution to a repository we do not own follows the owner's
oss-contributions skill and requires explicit approval before posting or pushing.
