---
name: connections
description: Discover and use accounts linked through the OpenClaw Connections plugin.
---

Use `connections_search` to discover operations on accounts available to this agent.
Use exact connection and action IDs from its results. Never select an account by guessing
its ID, user identity or service name.

Call `connections_describe` before executing. Pass the returned connection generation
and exact action version to `connections_call` with `mode: "execute"`. Provider schemas
are advisory; our identity and request envelopes are mandatory.

An execute call can change external systems. Follow the user's authorization for those
effects. If its outcome is unknown, never execute again to recover it. Use `mode: "lookup"`
with the prior native `toolCallId` in the same session. A saved unknown outcome means the
plugin cannot establish whether the operation happened; check the external service with
a read or ask the user before a new action.

For a large saved result, use `mode: "result"`, its invocation ID and the returned cursor.
Read pages until `nextCursor` is null. Receipts/results expire after seven days and require
the same agent session and current account grant. A missing result does not authorize replay.

If accounts are unavailable, an OpenClaw administrator can link or reconnect an account
and edit its agent grants on the native Connections page. Never request API keys in chat.
