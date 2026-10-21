# Security policy

This plugin is experimental. Security fixes target the latest release; upgrade to
the latest patch and use a host qualified in the README.

Report suspected vulnerabilities using
[GitHub private vulnerability reporting](https://github.com/raw-labs/openclaw-connections/security/advisories/new).
Include the plugin and OpenClaw versions, reproduction steps, expected behavior and
the impact. Use synthetic credentials and data in reproductions. Do not put real
API keys, OAuth tokens, connected-service data or sensitive Gateway logs in a report.

Keep vulnerability details private while maintainers investigate. Use public issues
for ordinary bugs that do not expose credentials, account data or an access-control
bypass.

The Gateway is a trusted execution domain. Native administrator roles and agent
grants are application permissions; they do not isolate secrets from Gateway
administrators or other trusted Gateway code. The README describes storage,
unknown external outcomes and the current testing limits.
