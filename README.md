# OpenClaw Connections

A standalone native OpenClaw plugin with a Connections page and three agent tools:
`connections_search`, `connections_describe` and `connections_call`.

The existing OpenClaw Codex harness can expose these tools through its dynamic-tool
bridge when native tool policy allows them; no separate MCP adapter is required.

Use your own Composio project. No ClawScarf Cloud account, WorkOS login, separate web
server or PostgreSQL database is required. OpenClaw owns authentication, administrator
roles, agents and tool policy. Composio hosts provider authentication and execution.

The page preserves the ClawScarf Connections layout: searchable service picker,
category filters, account status, connect/reconnect, names, agent grants and disconnect.
Usage shows local call activity; billing and quotas belong to your Composio project.
The bundled catalog contains 44 services. Tool definitions are fetched from Composio
when needed; execution uses the exact described version and account generation.

## Install and configure

Requires Node `24.16+` within Node 24, or `26.1+`, and OpenClaw `2026.10.2`, the pinned SDK
target. The host must provide runtime-bound `openKeyedStore` with
`retention: "retained"`, `registerIfAbsent`, `observe`/`compareAndApply`,
`entriesInKeyRange` and action-bound `withCurrent`. Missing capabilities, denied state
access and failed reads stop startup or the operation; there is no custom-file or
bounded-cache fallback. Other OpenClaw versions need compatibility verification before use.
The package name is `@raw-labs/openclaw-connections`, prepared for private distribution through
GitHub Packages.
See [releases and private package access](RELEASING.md).

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm build
pnpm test:native
pnpm artifact
openclaw plugins install npm-pack:/absolute/path/to/package.tgz --force --accept-capabilities
```

Review the package before accepting its native plugin capabilities. Configure
`plugins.entries.openclaw-connections` through native Settings or your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "openclaw-connections": {
        "enabled": true,
        "config": {
          "apiKey": {
            "source": "env",
            "provider": "default",
            "id": "COMPOSIO_API_KEY"
          }
        }
      }
    }
  }
}
```

Supply `COMPOSIO_API_KEY` to the Gateway's environment, then restart it. A terminal
export does not affect an already-running service. Native file/exec SecretRefs are
also supported. Declare their providers in OpenClaw's secrets configuration.
The key is never delivered to the Connections page or agent tool arguments.

With no key configured, Connections stays available and shows configuration guidance.
When OpenClaw isolates an unavailable authored SecretRef, the page and management RPC
remain registered and report its native capability-secret diagnostic. Provider tools stay inactive;
no Connections database is opened and no provider requests are made. Fix the native
secret binding and restart the Gateway. A resolved key enables the capability but does
not prove provider acceptance or account consent; those failures remain visible during use.
Native startup rejection for secret-provider policy or contract violations still applies.

Enable custom native Control UI plugins using the pinned OpenClaw build's
`gateway.controlUi.experimental.customPlugins` setting, and accept its native UI consent
when requested. Keep your existing Gateway authentication and tool policy. Installing
this plugin does not enable its tools for restricted agents or widen their policy.

Use a dedicated Composio project with permissions to manage auth configs/accounts and
execute tools. **Its callback identity verifier must be unset** for this standalone
linking flow. The plugin does not host a public verifier callback. Projects requiring
one are unsupported and cannot activate an account through this page.

`userId` is optional: a stable installation identity is created and retained locally.
To use a preselected Composio identity, set it before first activation. Changing it on
retained state fails visibly. This plugin's user ID is an account namespace, not a team
login or proof of a person. Existing project accounts are not imported automatically.

Services with custom auth require an existing configured auth config in Composio:

```json
{
  "authConfigIds": {
    "your-service-id": "ac_your_existing_configuration"
  }
}
```

Merge this map into the plugin config. Managed-auth services resolve or create their
auth config automatically. Provider-specific auth settings remain in Composio.

## Link and use accounts

An OpenClaw administrator opens **Connections**, chooses **Add connection**, selects a
service and opens **Open sign-in**. Approve access in the separate Composio tab, return
to the original OpenClaw browser and choose **Finish connecting**. Only this explicit
confirmation activates the plugin's local grant. Completion checks the exact provider
account, user, toolkit and auth config, plus its originating administrator/browser ticket.
Closing the dialog leaves **Continue** available. Losing the browser ticket requires
cancelling the setup and starting again.

Edit a connection to rename it or restrict it to selected native agents. Reconnecting
disables the old generation before contacting Composio and retires the previous account.
Disconnect blocks execution locally before requesting provider cleanup. A cleanup error
remains visible; access stays disabled. Refresh and retry Disconnect explicitly.
Remove deletes an inactive local entry after confirmed cleanup.

The three tools perform search, schema description and exact-account execution. Call
lookup and paged results use the same `connections_call` tool. See the bundled
[Connections skill](skills/connections/SKILL.md).

## State and trust

Connections uses OpenClaw's public plugin-scoped retained state SDK. The host owns
`<resolved OpenClaw state directory>/state/openclaw.sqlite` and its SQLite lifecycle.
Persist and back up the canonical OpenClaw state directory using the host's supported
backup procedure; no separate Connections directory or mount is required. State is
scoped by the runtime-bound plugin ID, with versioned identity, registry and receipt
and result namespaces. Each Gateway state directory retains one Composio user identity; selected
agent grants and exact agent/session/call receipt bindings enforce application access.
Do not run multiple Connections service instances or Gateways against the same state:
startup recovery treats unfinished dispatch and setup as interrupted work.

Records include account references, names, grants, pending setup links/ticket hashes
and call receipts/results; they never contain the Composio project key or service
OAuth tokens. Treat backups as sensitive: results can contain connected-service data.
All authoritative namespaces use retained storage without SDK TTL or eviction.
Connection revisions and the 1,000-connection limit share one atomic CAS registry;
the SDK's 1 MiB JSON value limit bounds that registry and each receipt. Result payloads
(up to 8 MiB of serialized JSON) use immutable retained chunks; one receipt CAS
publishes the chunk count, byte length and digest only after every chunk is saved.
A payload write failure records the known outcome without its result and surfaces
the storage error. Pruning removes payload references before deleting expired chunks,
and also removes orphan chunks from interrupted writes. A large
registry can reach the byte limit before 1,000 entries; failed writes are surfaced.
Receipt identities remain indefinitely after payload pruning, so disk use grows with
call history. Receipt scans use bounded SDK pages, but recovery/pruning and result-ID
lookup still scan retained history.

This storage cutover starts fresh: there is no import of an old custom SQLite file,
migration or dual write. Existing custom files are neither read nor deleted.

The published OpenClaw `2026.10.2` host supports plugin-scoped state for all
loaded plugins, including private packages and local installs. OpenClaw `2026.9.8`
is not supported by this release: its published host denied this plugin's state access.
The plugin requires the public retained/CAS and action-authority contracts, without
trust bypasses or internal database facades. Never downgrade a host against expanded
retained state without restoring a compatible backup.

Management uses authenticated native Gateway RPC requiring `operator.admin`. There is
no browser-facing provider credential or separate HTTP management API. The Gateway
runtime is trusted with the Composio credential. Native roles and agent grants are
application controls; they do not isolate secrets from administrators or trusted code
running with Gateway authority. Composio's project credential permissions still apply.

A receipt is persisted before tool execution. Calls are serialized with grant/account
changes; duplicate native call identities return the recorded result rather than execute
again. Timeouts, lost responses and interrupted dispatches remain explicitly unknown.
A receipt does not prove an external result that Composio never returned.

Receipt details/results are retained for seven days and pruned on startup, call and
usage reads. Minimal call-identity records remain to block replay after expiry.
Saved results require the original agent session and current grant. Provider
responses are bounded; large results are paged without truncating their stored JSON.
There is no billing system, trigger/webhook service, code sandbox or automatic retry
of uncertain mutations in this plugin.

## Development

`pnpm check` checks formatting, strict TypeScript and regressions. `pnpm build` bundles
runtime dependencies, their licenses and the native Control UI using OpenClaw's plugin
builder. `pnpm artifact` produces the installable tarball under ignored `.local/`.
`pnpm test:native` installs the already-built package in temporary vanilla OpenClaw
state, exercising omitted/resolved credentials, isolated env/file/exec secret failures,
native secret-provider policy rejection, provider denial, account consent, administrator
RPC, the official Codex dynamic-tool
bridge with the packed plugin's actual tool factories and schemas, native agent/session
binding, duplicate-call recovery, restart and disablement. The bridge test uses an
isolated public-SDK host fixture; Gateway installation and RPC are exercised separately.
Chromium loads the packed
UI asset served by the Gateway through a small public-SDK host fixture with real
native RPC; this checks rendering on desktop and mobile, without automating the full
OpenClaw shell or its plugin consent flow. The plugin has no
runtime dependency on either donor repository. See
[AGENTS.md](AGENTS.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

`pnpm inspect:package` validates version alignment and the contents of the installable
tarball. GitHub Actions runs these checks with Node 24.19.0 and the locked dependencies
on PRs, main and explicit dispatches. See [the release guide](RELEASING.md) for versions,
publishing and private consumers.

Automated tests use controlled Composio responses and temporary OpenClaw state. They
do not establish real external OAuth consent, provider execution or a live Codex
app-server conversation. Those checks remain for the internal pilot. Live verification
needs a dedicated Composio project and explicitly authorized test accounts/actions.
