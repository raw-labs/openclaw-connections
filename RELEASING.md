# Packages and releases

The source repository and GitHub Release assets are public. The GitHub Packages
package remains private for existing consumers. The npm name is
`@raw-labs/openclaw-connections`; the native plugin ID stays `openclaw-connections`.
`package.json` owns the version. The build regenerates the manifest from it, and
Release Please updates both files together. Artifacts contain bundled runtime code,
Control UI, catalog, skill and notices, without OpenClaw or development dependencies.

## Versioning

Use conventional commit subjects. Before 1.0, `fix:` and `feat:` advance the patch;
`feat!:` or a `BREAKING CHANGE:` footer advances the minor. Each minor may break
compatibility; consumers pin an exact version. The first release is `0.1.0`.

On main, Release Please opens or updates a release PR with the version and changelog.
Its workflow explicitly dispatches CI on that PR's branch because bot-created PRs
may omit PR workflows or require maintainer approval. Review and merge the release PR
only after its required `verify` check passes. If the original PR run reports
`action_required`, review the release diff and use **Approve and run** on that run's
Actions page. A dispatched head-branch run does not resolve this pending approval;
confirm that `verify` appears on the PR itself before merging.

If no PR run is awaiting approval and `verify` is missing, dispatch CI on the
release PR's exact head branch:

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

## Public installation

Download the versioned `.tgz` asset from
[GitHub Releases](https://github.com/raw-labs/openclaw-connections/releases) and follow
the [native installation instructions](README.md#install-and-configure). Public release
downloads do not require registry credentials. Source builds are also supported.
The host compatibility and experimental limits in the README still apply.

Publishing source does not move the package to npmjs.org or change GitHub Packages
visibility. Previously published archives are immutable and retain the documentation
from their release; the default branch documents the current distribution policy.

## Consuming the private registry package

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
Authenticated CLI users can also download a public release tarball:

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
Preparation uses upstream's `build:ci-artifacts` profile, recorded as `ciArtifacts`
in the host pin. It builds the complete Gateway runtime, Control UI, metadata and
canonical public SDK declarations, including upstream's SDK export checks. It
does not generate unused declarations for the entire OpenClaw application.
Previous generated host output is cleared before preparation. CI verification and
publication use RAW Labs' Depot Linux ARM runner `depot-ubuntu-24.04-arm-8`
(8 CPUs, 32 GB RAM) with upstream's `OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4352`
compiler heap setting. Qualification measured a 9,055 MiB compiler process-tree
peak; the V8 setting alone does not bound the native TypeScript compiler. Runner
capacity also leaves room for Depot's disk accelerator. Release Please uses the
smaller `depot-ubuntu-24.04-arm` runner. The plugin package contains portable
JavaScript; native Gateway/Chromium acceptance runs before publication.
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

## Public repository operations

Keep secret scanning, push protection and private vulnerability reporting enabled.
Require maintainer approval for workflows from all outside collaborators. CI runs PR
code with `contents: read`; privileged release jobs run only on main or explicit
maintainer dispatch. Do not use `pull_request_target` to execute contributor code.

RAW Labs' Depot runner group must allow this public repository. Retain the existing
Linux ARM runner sizes and the required `verify` branch check. New contributors need
their own compatible OpenClaw host and Composio project; never share project keys in
issues, pull requests, screenshots or test logs. See
[the security policy](https://github.com/raw-labs/openclaw-connections/security/policy).
