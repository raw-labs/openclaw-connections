# Contributor guide

- This project is a standalone native OpenClaw plugin. OpenClaw owns login, roles,
  agents, tool policy and the UI host. Composio owns provider authentication and execution.
  No ClawScarf Cloud, WorkOS, billing backend or separate application server.
- Keep the Connections UI and three search/describe/call tools straightforward.
  Reuse the existing UI primitives and public OpenClaw SDK; pin and test SDK upgrades.
- Resolve the Composio key through native SecretRef configuration. Never send it to
  the browser, model, logs or committed files. The Gateway is a trusted execution domain;
  local grants are application permissions, not isolation from Gateway administrators.
- Require current native administrator authority for management. Bind setup completion
  to its originating browser ticket. Preserve exact account/user/toolkit bindings,
  agent grants, account generations and action versions on execution.
- Persist a dispatch receipt before external effects. Serialize conflicting operations;
  never automatically replay a mutation after a timeout or process interruption.
  Keep outcome-unknown explicit. Validate our envelopes; provider schemas are advisory.
- Keep provider I/O in its adapter, durable state in the local store and lifetimes in plugin wiring.
  Use strict TypeScript, runtime boundary validation and parameterized SQL. No `any`,
  unsafe casts, blanket suppressions or sibling-repository runtime imports.
- README.md owns installation, configuration and actual limits; RELEASING.md owns
  versioning, workflows and private package access. Keep it accurate in
  the same change. Preserve licenses and revisions in THIRD_PARTY_NOTICES.md.
- Review changed files. Run `pnpm check`, `pnpm build` and relevant native/browser
  verification before delivery. State what was not tested. Clean disposable fixtures.
- Keep SDK versions, lockfile and compatibility declarations aligned. Package versions
  come from package.json; inspect the packed artifact before release. The source
  repository is public; keep the GitHub Packages package private and use workflow
  tokens for publishing. Public release tarballs are the unauthenticated install path.
- Use RAW Labs' Depot Linux ARM runners for CI and publication, with sufficient
  memory for pinned SDK qualification.
- Work only on the requested slice. Preserve unrelated work; push only when authorized.
