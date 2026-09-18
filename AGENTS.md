# vaultwarden-drop-slot-mcp

Personal open-source project, initially used by lan-compute. Original code is
Apache-2.0. Keep private LAN configuration, credentials and deployment details
in lan-compute, outside this public package.

Approved skills: API Design Reviewer, Docker Development, engineering Code
Review, MCP Server Builder, Senior Security (STRIDE threat modeling and secret scanning), and
lan-compute for deployment. User approved security design advisor skills on
2026-09-17. Additional skills require the owner's approval.

TypeScript, ESM, Node 24. Use the official MCP SDK and age-encryption; do not
implement cryptography. The inbox has ciphertext and hashed writer/importer
tokens only. The private importer alone holds age identities and vault access.
No read/search/edit/delete tools, shell passthrough, source file paths, or
agent-selected destinations. Never emit secrets, CLI stderr, or raw validation
errors. All examples use fictional configuration.

Work on feature/YYYY-MM-DD@slug branches from main. Test before --no-ff merge.
Do not push public commits, publish npm, or open PRs without owner instruction.
Heavy/container work runs on the LAN through lan-compute Ansible.

Verification: npm ci --ignore-scripts; npm test; npm run build; npm pack --dry-run.
Security-sensitive changes need threat-model and acceptance-test updates.
Record real-vault enrollment and client checks as pending until demonstrated.

Repository hygiene: new project baseline 2026-09-17, 0 source lines, initial
commit (before implementation). Audit after roughly 10,000 added source lines.
