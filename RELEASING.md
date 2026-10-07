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
only after its `verify` check passes. The release workflow then creates `vVERSION`
and the GitHub Release, checks the tagged source again, builds and inspects the tarball,
publishes that same tarball to GitHub Packages, verifies private visibility and its
repository link, compares a registry download with the tarball, and attaches it to the Release.
Publication uses the workflow's `GITHUB_TOKEN` with `packages: write`; no long-lived
publishing credential belongs in the repository.

A failed publication leaves the tag/Release intact; check the workflow and registry
before rerunning the failed publish job. Never delete or reuse an already-published
version. Fix a published defect with a new version. GitHub Actions run artifacts also
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

An OCE deployment can bake the pinned tarball into its Gateway image and configure
this native plugin. Image changes, secret bindings, persistent-volume configuration
and replacement testing belong to the deployment repository. A plugin picker is not
required. [State and trust](README.md#state-and-trust) describes the current storage
contract, including the directory that deployments must persist.

References: [GitHub npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry),
[Release Please action](https://github.com/googleapis/release-please-action).
