# Private packages and releases

The source repository and package stay private. The npm name is
`@raw-labs/openclaw-connections`; the native plugin ID stays `openclaw-connections`.
`package.json` owns the version. The build regenerates the manifest from it, and
Release Please updates both files together. Artifacts contain bundled runtime code,
Control UI, catalog, skill and notices, without OpenClaw or development dependencies.

## Versioning

Use conventional commit subjects. Before 1.0, `fix:` and `feat:` advance the patch;
`feat!:` or a `BREAKING CHANGE:` footer advances the minor. Each minor may break
compatibility; consumers pin an exact version. The first release is `0.1.0`.

On main, Release Please opens or updates a release PR with the version and changelog.
Its workflow explicitly dispatches CI on that PR's branch: PRs created by
`GITHUB_TOKEN` otherwise do not trigger PR workflows. Review and merge the release PR
only after its `verify` check passes. If `verify` is missing or a bot-created run
reports `action_required`, dispatch CI on the release PR's exact head branch:

```sh
gh workflow run ci.yml --repo raw-labs/openclaw-connections --ref RELEASE_PR_HEAD
```

Replace `RELEASE_PR_HEAD` with the head branch shown on the release PR. Wait for
that commit's `verify` check before merging; do not weaken branch protection.
The release workflow then creates `vVERSION`
and the GitHub Release, checks the tagged source again, builds and inspects the tarball,
publishes that same tarball to GitHub Packages, verifies private visibility and its
repository link, compares a registry download with the tarball, and attaches it to the Release.
Publication uses the workflow's `GITHUB_TOKEN` with `packages: write`; no long-lived
publishing credential belongs in the repository.

A failed publication leaves the tag/Release intact. Dispatch the Release workflow
with its existing `tag` to finish publication using the current workflow and the
tagged source. An existing registry version must match the verified tarball byte for
byte before publication is skipped; a mismatch fails. Only structured npm `E404`
(missing package) or `ETARGET` (missing version) permits first publication; authentication
and transport failures stop the workflow. Leave `tag` empty for normal
Release Please runs. An existing Release archive is also compared and kept; mismatches
fail rather than replacing it. Never delete or reuse an already-published version. Fix a
published defect with a new version. GitHub Actions run artifacts also
contain the verified tarball, but are not versioned releases.

## Consuming the private package

After the first publication, keep package visibility **Private**, link it to this
repository and inherit repository permissions. In the package's **Manage Actions
access**, grant **Read** to `raw-labs/claw.raw-labs.com`. Repository read access alone
does not automatically give another repository's `GITHUB_TOKEN` package access.
This package setting is separate from deployment changes.

A consumer workflow can authenticate without a personal token:

```yaml
permissions:
  contents: read
  packages: read
steps:
  - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
    with:
      node-version: 24.19.0
      registry-url: https://npm.pkg.github.com
      scope: "@raw-labs"
  - run: npm pack @raw-labs/openclaw-connections@VERSION
    env:
      NODE_AUTH_TOKEN: ${{ github.token }}
```

Replace `VERSION` with the selected exact release, then install the downloaded tarball
using the [native installation instructions](README.md#install-and-configure).
GitHub Packages is the registry, not public npm. Local registry downloads require a
classic PAT with `read:packages` and repository access, including organization SSO
when required. Keep registry authentication in the user's private npm configuration
or the workflow's generated configuration, never in this repository.
Alternatively, an authenticated repository reader can download the attached tarball:

```sh
gh release download vVERSION --repo raw-labs/openclaw-connections --pattern '*.tgz'
```

A consuming deployment can bake the pinned tarball into its Gateway image and configure
this native plugin. Image changes, secret bindings, persistent-volume configuration
and replacement testing belong to the deployment repository. A plugin picker is not
required. [State and trust](README.md#state-and-trust) describes the current storage
contract: Connections 0.2 uses canonical retained plugin state, with no special
Connections mount. Its primary SDK/host is the source build recorded in `openclaw-host.json`: OpenClaw
`2026.9.8` at `90d30a1178a79dddd92e6190b66b95d89dfb3ca8`. The npm SDK and Codex
harness dependency labels are pinned to `2026.9.8`; preparation builds and selects
the exact source SDK before qualification. Stock published `2026.9.8` is unsupported.
The already qualified published `2026.10.2` host remains admitted by the explicit
compatibility range. Keep source pin/checksum, SDK dependency labels, peer/API ranges,
minimum version, build declarations, notices and lockfile aligned when upgrading.

Every CI and publication job runs `pnpm prepare:host` and asserts the built revision.
A version-only test is insufficient for this source target. Connections 0.2.1 is the
patch correcting the 0.2.0 gate; publication still uses only workflow tokens.

The 0.2 release is a breaking storage cutover. Existing custom SQLite state is neither
imported nor deleted; the plugin starts with new native state. Use this release for
fresh/test installations. Existing installations that need their records preserved
must stay on 0.1 until a separately planned transition is available. Consumer image,
secret configuration, persistent disk replacement and real-provider acceptance are
separate deployment qualification; a plugin release does not deploy those consumers.

References: [GitHub npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry),
[Release Please action](https://github.com/googleapis/release-please-action).
