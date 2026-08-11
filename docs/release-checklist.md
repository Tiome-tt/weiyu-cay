# Release checklist

Complete this checklist for every signed prerelease and stable version tag. Record the tag, commit SHA, installer filenames, SHA256 values, OS versions, and every failure in the GitHub release notes. Do not publish a release while any required checkbox is incomplete.

## Release-owner preflight

- [ ] The tag is an annotated, GitHub-verified signature and exactly matches `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (for example, `v0.1.0`).
- [ ] Repository secrets contain the release-owner updater public key, matching Tauri updater private key and password, Windows PFX and password, plus Apple certificate, identity, Apple ID, app-specific password, and team ID. The workflow derives the Windows thumbprint from the imported PFX and cryptographically verifies a newly signed updater probe with the public key.
- [ ] Configure the non-secret `RELEASE_STAGING_ENDPOINT` repository variable as the owner-controlled, HTTPS RC channel root (for example, `https://updates.example/rc`) and the `RELEASE_STAGING_UPLOAD_TOKEN` secret for its authenticated PUT upload API. The host must make `/assets/<encoded-name>` immutable/reachable at that same HTTPS origin and replace `latest.json` atomically only after all assets upload. It must serve only signed staged files and no credentials; updater signatures, private keys, and release credentials never go there.
- [ ] The release workflow created signed installers, updater signatures, `latest.json`, and `SHA256SUMS`; verify the checksums and record all filenames and SHA256 values in the release notes.
- [ ] Confirm `latest.json` has matching URL and signature entries for `windows-x86_64`, `darwin-aarch64`, and `darwin-x86_64`. Each updater URL must name an uploaded asset and its metadata signature must equal that asset's `.sig` file.
- [ ] Never add a placeholder updater key or endpoint to `src-tauri/tauri.conf.json`. The checked-in config is intentionally fail-closed; only the signed release workflow materializes the release-owner public key into a temporary config.

## Draft staging, smoke, and publication

- [ ] The workflow leaves both stable and RC releases as GitHub drafts. It never automatically publishes an un-smoked candidate. GitHub draft assets are not a client updater channel. Complete direct-installer launch and all non-updater smoke checks against the exact verified draft assets before any publication step.
- [ ] RC builds are dedicated channel builds: every RC binary checks the stable, version-independent `<RELEASE_STAGING_ENDPOINT>/latest.json`. Before using this workflow, install a lower signed channel-configured RC baseline (for example `0.1.2-rc.1`). If no prior RC uses this channel, the owner must first create and manually publish that baseline with the same channel endpoint and record its checksum.
- [ ] After automated gates, the `stage-rc` job downloads the exact signed draft assets, requires the existing lower-version RC manifest, mirrors bytes to `<RELEASE_STAGING_ENDPOINT>/assets/`, and atomically PUTs the candidate manifest to `<RELEASE_STAGING_ENDPOINT>/latest.json`. The candidate must be greater than the staged baseline; same-version candidates fail. The staged manifest replaces only asset URLs and retains the draft version and signatures.
- [ ] For an RC, install the recorded lower RC baseline, check for updates, explicitly install the higher staged candidate, and record both versions plus all checksums. Do not put tokens, draft GitHub URLs, or signing material in the staged manifest.
- [ ] For a stable candidate, download the `stable-promotion-plan-<run>-<attempt>` artifact. It proves that the candidate is a draft, is a stable SemVer greater than the currently published stable updater manifest, and records the exact prior tag. If no lower signed stable baseline exists, publish and record such a baseline before attempting this candidate; do not bypass the updater smoke.
- [ ] Stable promotion is a deliberate two-phase operation. First install the exact verified draft installers and complete all non-updater checks on both platforms. Then run the plan's `publishCommand` (`gh release edit <candidate> --repo <owner/repository> --draft=false --latest`). Confirm `releases/latest/download/latest.json` reports the candidate version, install the recorded prior stable on both platforms, explicitly check/download/install/restart through the application, and record both successful transitions.
- [ ] If either stable updater smoke fails, stop distribution immediately and run both plan `rollbackCommands`: return the candidate to draft, then mark the recorded prior tag Latest. Confirm `releases/latest/download/latest.json` again reports the prior version and record the failure. Only after both updater smokes pass may the stable publication be treated as complete. RC remains available through its owner-controlled channel; stable binaries never use staging and check GitHub `releases/latest/download/latest.json` only.

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
