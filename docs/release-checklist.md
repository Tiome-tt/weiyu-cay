# Release checklist

Complete this checklist for every signed prerelease and stable version tag. Record the tag, commit SHA, installer filenames, SHA256 values, OS versions, and every failure in the GitHub release notes. Do not publish a release while any required checkbox is incomplete.

## Release-owner preflight

- [ ] The tag is an annotated, GitHub-verified signature and exactly matches `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (for example, `v0.1.0`).
- [ ] Repository secrets contain the release-owner updater public key, matching Tauri updater private key and password, Windows PFX and password, plus Apple certificate, identity, Apple ID, app-specific password, and team ID. The workflow derives the Windows thumbprint from the imported PFX and cryptographically verifies a newly signed updater probe with the public key.
- [ ] The release workflow created signed installers, updater signatures, `latest.json`, and `SHA256SUMS`; verify the checksums and record all filenames and SHA256 values in the release notes.
- [ ] Confirm `latest.json` has matching URL and signature entries for `windows-x86_64`, `darwin-aarch64`, and `darwin-x86_64`. Each updater URL must name an uploaded asset and its metadata signature must equal that asset's `.sig` file.
- [ ] Never add a placeholder updater key or endpoint to `src-tauri/tauri.conf.json`. The checked-in config is intentionally fail-closed; only the signed release workflow materializes the release-owner public key into a temporary config.

## Release channels

- [ ] A stable tag (no prerelease suffix) builds with GitHub's stable endpoint, `releases/latest/download/latest.json`, and remains a draft until the owner completes the platform checks below and publishes it.
- [ ] An RC tag (for example `v0.1.1-rc.1`) builds with the tag-specific endpoint, `releases/download/v0.1.1-rc.1/latest.json`. After the workflow's full CI, signed-artifact, metadata, signature, and checksum gates pass, it is published as a GitHub prerelease so installed RC clients can test that endpoint without querying stable `latest`.
- [ ] Test an RC only against its tag-specific endpoint. Do not publish a stable release or point an RC build at `releases/latest` to make the test convenient.

## Windows release candidate

- [ ] Install the signed Windows installer.
- [ ] Launch the installed application.
- [ ] Verify global shortcut conflict feedback.
- [ ] Create, move, resize, hide, and restore three sticky-note windows.
- [ ] Toggle always-on-top for a sticky-note window and verify it survives hide and restore.
- [ ] Enable and disable autostart.
- [ ] Update from the prior signed release using updater metadata.
- [ ] Uninstall and confirm local application data remains intact.

## macOS release candidate

- [ ] Install the signed and notarized macOS application.
- [ ] Launch the installed application.
- [ ] Verify shortcut permission and conflict feedback.
- [ ] Create, move, resize, hide, and restore three sticky-note windows.
- [ ] Toggle always-on-top for a sticky-note window and verify it survives hide and restore.
- [ ] Enable and disable autostart.
- [ ] Update from the prior signed release using updater metadata.
- [ ] Move the application to `/Applications` and relaunch it there.

## Both platforms

- [ ] Generate and use the deterministic production-layout 10,000-note fixture in a new empty temporary directory: `pnpm fixture:search --count 10000 --seed 20260730 --output <empty-temp-directory>`. Confirm its `folders.json`, Markdown frontmatter, and assets were created before importing it.
- [ ] Verify title/body search and `#tag` search against the fixture.
- [ ] Verify backlinks and internal-link navigation.
- [ ] Verify interrupted-save recovery preserves the prior valid Markdown.
- [ ] Run and verify a full index rebuild.
- [ ] Delete and restore a note from application trash.
- [ ] Export a portable library and open the exported Markdown and assets outside the app.
- [ ] Complete keyboard-only navigation, visible-focus, and reduced-motion smoke tests.
