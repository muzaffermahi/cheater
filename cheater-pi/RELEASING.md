# Releasing Kitten

Kitten is an alpha technical preview. Releases are signed, tagged, and provenance-attested.
Never commit an npm token; never rebuild the artifact between testing and publishing.

## Pre-release gates

All of these must pass on a clean checkout before cutting a release tag:

```sh
cd cheater-pi
npm install
npm run zero-dep-gate  # published package has no production/peer dependencies
npm run cleanroom-smoke # exact tarball, --omit=dev install, no legacy runtime
npm run typecheck      # tsc --noEmit — strict, zero errors
npm run build          # tsc → dist/
node --test dist/test/*.test.js   # all 900+ tests green (currently 909)
npm run smoke          # pack → clean install → exercise bins + web
```

No gate is allowed to fail. If smoke fails, the release must not proceed.

## Versioning

- The canonical version lives in `cheater-pi/package.json` (`version` field) and
  `pyproject.toml` (if the Python launcher is still shipped).
- Bump the version **before** tagging. The tag must match `v<version>` exactly (e.g. `v0.8.0`).
- Update `CHANGELOG.md` with the new version heading, date, and a summary of changes.

## Tagging

All releases are signed with a detached GPG signature:

```sh
git tag -s v0.8.0 -m "Kitten v0.8.0"
git push origin v0.8.0
```

Verify the tag before publishing:

```sh
git tag -v v0.8.0
```

## npm publication

### First publication (bootstrap)

The initial npm publication requires a maintainer with npm publish rights to
the `@cheater/cheater-pi` package:

```sh
cd cheater-pi
npm publish
```

### Trusted publishing (recommended for subsequent releases)

Configure npm registry trusted publishing in the GitHub repository settings:

1. Go to the npm package settings → "Access" → "Require two-factor authentication
   or automation for all new organizations and packages" enabled.
2. In the GitHub repo → Settings → Environments → create `npm-publish`.
3. Add the trusted-publishing workflow (see `.github/workflows/ci.yml` for the CI
   template; extend with a `publish` job gated on all tests passing).
4. Push a signed tag; the workflow builds, tests, smokes, and publishes with
   provenance.

The published artifact must carry an npm provenance attestation. The npm package contains only the
standalone Kitten engine and shared reliability primitives; legacy Pi source/runtime files and their
dependencies are dev-only and excluded by the `files` allow-list. Confirm provenance with:

```sh
npm view @cheater/cheater-pi --json | grep -A5 provenance
```

Tagging `v<package-version>` runs `.github/workflows/release.yml`. It validates the tag/version
match, runs the complete engine gates, packs and attests the exact npm tarball, builds and attests the
native desktop ZIP, generates `SHA256SUMS.txt`, and creates the GitHub Release from those exact bytes.
The release job requires repository secrets `KITTEN_SIGNING_CERTIFICATE_BASE64` and
`KITTEN_SIGNING_CERTIFICATE_PASSWORD`; the packaging manifest records `authenticode-verified` only
after `signtool` signs and verifies the desktop app, installer, and bundled runtime. Local development
bundles are explicitly marked `unsigned-development`.

## GitHub Release

After the npm publish succeeds:

1. Create a GitHub Release from the signed tag.
2. Attach the npm tarball as a release asset (`npm pack` in a clean checkout).
3. Add a link to the npm package page.
4. Paste the relevant `CHANGELOG.md` section as the release notes.

### Native desktop release

The Windows desktop artifact is assembled from the exact published Avalonia output, the compiled
engine tree, and a private Node runtime. From a clean checkout:

```powershell
dotnet publish desktop/Kitten.Desktop.csproj -c Release -r win-x64 --self-contained true -o ..\artifacts\kitten-desktop
dotnet publish desktop/Installer/Kitten.Setup.csproj -c Release -r win-x64 --self-contained true -o ..\artifacts\kitten-setup
Copy-Item (Get-Command node).Source ..\artifacts\node.exe
.\scripts\package-desktop-release.ps1 -Publish ..\artifacts\kitten-desktop -Out ..\artifacts\kitten-desktop-bundle -NodeExe ..\artifacts\node.exe -SetupExe ..\artifacts\kitten-setup\Kitten.Setup.exe
```

The script refuses an incomplete payload, writes a native-only `release.json`, creates the portable
ZIP, and emits `<bundle>.zip.sha256`. The bundle also includes `Kitten.Setup.exe`, a native GUI installer
that copies the verified payload to `%LOCALAPPDATA%\\Kitten` and creates a Start Menu shortcut. The app
itself never asks the end user to install Node, open a browser, or use a terminal.

## Post-release verification

On a clean machine (or a VM), WITHOUT the repo present:

```sh
npm install -g @cheater/cheater-pi
kitten doctor
kitten conversations
```

Optionally, on a throwaway directory:

```sh
kitten run "write a hello.py that prints hello" --json
kitten undo
```

Verify that `kitten` is on PATH, help works, and the store is writable.

## Rollback

If the release is flawed, deprecate it rather than unpublishing (unpublishing
breaks existing installs):

```sh
npm deprecate @cheater/cheater-pi@"<bad-version>" "Broken: use <fixed-version> instead"
```

Then cut and publish a fix release from HEAD.

## Checklist (copy into each release PR)

- [ ] Version bumped in `package.json` and `pyproject.toml`
- [ ] `CHANGELOG.md` updated with this release
- [ ] `npm run typecheck` green
- [ ] `npm run build` green
- [ ] `node --test dist/test/*.test.js` — all 900+ green
- [ ] `npm run smoke` green
- [ ] Signed tag pushed and verified (`git tag -v vX.Y.Z`)
- [ ] npm publish succeeded, provenance confirmed
- [ ] GitHub Release created with tarball asset and changelog
- [ ] Clean-machine `npm install -g` + `kitten doctor` tested
- [ ] No npm token committed to the repo
