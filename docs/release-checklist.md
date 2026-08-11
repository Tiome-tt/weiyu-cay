# Release checklist

Complete this checklist for every signed prerelease and stable version tag. Record the tag, commit SHA, installer filenames, SHA256 values, OS versions, and every failure in the GitHub release notes. Do not publish a release while any required checkbox is incomplete.

## Release-owner preflight

- [ ] The tag is an annotated, GitHub-verified signature and exactly matches `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (for example, `v0.1.0`).
- [ ] Repository secrets contain the real updater public key, Tauri updater private key and password, Windows PFX, PFX password and thumbprint, plus Apple certificate, identity, Apple ID, app-specific password, and team ID.
- [ ] The release workflow created signed installers, updater signatures, `latest.json`, and `SHA256SUMS`; record their filenames and checksums in the release notes.
- [ ] The release remains a draft until all platform checks below are complete.

## Windows release candidate

- [ ] Install the signed Windows installer.
- [ ] Launch the installed application.
- [ ] Verify global shortcut conflict feedback.
- [ ] Create, move, resize, hide, and restore three sticky-note windows.
- [ ] Enable and disable autostart.
- [ ] Update from the prior signed release using updater metadata.
- [ ] Uninstall and confirm local application data remains intact.

## macOS release candidate

- [ ] Install the signed and notarized macOS application.
- [ ] Launch the installed application.
- [ ] Verify shortcut permission and conflict feedback.
- [ ] Create, move, resize, hide, and restore three sticky-note windows.
- [ ] Enable and disable autostart.
- [ ] Update from the prior signed release using updater metadata.
- [ ] Move the application to `/Applications` and relaunch it there.

## Both platforms

- [ ] Generate and use the deterministic 10,000-note fixture: `pnpm fixture:search --count 10000 --seed 20260730`.
- [ ] Verify title/body search and `#tag` search against the fixture.
- [ ] Verify backlinks and internal-link navigation.
- [ ] Verify interrupted-save recovery preserves the prior valid Markdown.
- [ ] Run and verify a full index rebuild.
- [ ] Delete and restore a note from application trash.
- [ ] Export a portable library and open the exported Markdown and assets outside the app.
- [ ] Complete keyboard-only navigation, visible-focus, and reduced-motion smoke tests.
