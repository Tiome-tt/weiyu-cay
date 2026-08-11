mod support;

use image::{DynamicImage, ImageFormat};
use simple_notes_lib::{
    commands::assets::{
        read_image_asset_from, save_image_to, save_image_to_with, save_image_to_with_publish_hook,
        validate_image,
    },
    commands::external::validate_external_url,
    domain::{NoteDocument, NoteId, NoteKind, SaveImageInput},
    error::CommandErrorCode,
    storage::{database::Database, repository::NoteRepository},
};
use std::{
    io::{Cursor, Write},
    sync::{mpsc, Arc, Condvar, Mutex},
    time::Duration,
};
use support::TestStore;

const FORMAL_ID: &str = "019c0000-0000-7000-8000-000000000071";
const TEMPORARY_ID: &str = "019c0000-0000-7000-8000-000000000072";
const UNKNOWN_ID: &str = "019c0000-0000-7000-8000-000000000079";

#[test]
fn rejects_oversized_note_command_payload_before_creating_durable_content() {
    let store = TestStore::new();
    let id = id("019c0000-0000-7000-8000-000000000078");
    let result = NoteRepository::new(store.paths.clone()).create(NoteDocument {
        id,
        kind: NoteKind::Formal,
        title: "Oversized".to_owned(),
        folder_id: None,
        tags: Vec::new(),
        markdown: "x".repeat(64 * 1024 * 1024 + 1),
        revision: 0,
        created_at: "2026-07-30T00:00:00Z".to_owned(),
        updated_at: "2026-07-30T00:00:00Z".to_owned(),
    });
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("oversized note must be rejected"),
    };

    assert_eq!(error.code(), CommandErrorCode::Validation);
    assert!(!store.paths.notes().join(id.to_string()).exists());
}

#[test]
fn rejects_aggregate_documents_that_would_exceed_the_durable_read_budget() {
    for (id_value, kind) in [
        ("019c0000-0000-7000-8000-000000000076", NoteKind::Formal),
        ("019c0000-0000-7000-8000-000000000077", NoteKind::Temporary),
    ] {
        let store = TestStore::new();
        let id = id(id_value);
        let result = NoteRepository::new(store.paths.clone()).create(NoteDocument {
            id,
            kind,
            title: "t".repeat(2 * 1024 * 1024),
            folder_id: None,
            tags: Vec::new(),
            markdown: "m".repeat(63 * 1024 * 1024),
            revision: 0,
            created_at: "2026-07-30T00:00:00Z".to_owned(),
            updated_at: "2026-07-30T00:00:00Z".to_owned(),
        });

        assert_eq!(result.unwrap_err().code(), CommandErrorCode::Validation);
        let collection = match kind {
            NoteKind::Formal => store.paths.notes(),
            NoteKind::Temporary => store.paths.temporary(),
        };
        assert!(!collection.join(id.to_string()).exists());
    }
}

#[test]
fn capability_documents_semantically_keep_sticky_renderers_out_of_privileged_commands() {
    let main: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    let sticky: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/temporary.json")).unwrap();
    let strings = |document: &serde_json::Value| {
        document["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<std::collections::HashSet<_>>()
    };
    let main_permissions = strings(&main);
    let sticky_permissions = strings(&sticky);

    assert_eq!(sticky["windows"], serde_json::json!(["temporary-*"]));
    for required in [
        "allow-load-temporary",
        "allow-save-temporary",
        "allow-hide-temporary-window",
        "allow-set-temporary-always-on-top",
    ] {
        assert!(sticky_permissions.contains(required));
    }
    for forbidden in [
        "allow-create-note",
        "allow-list-notes",
        "allow-rename-note",
        "allow-list-link-targets",
        "allow-read-image-asset",
        "allow-open-external-link",
        "allow-complete-main-window-close",
        "allow-delete-temporary",
        "allow-convert-temporary",
        "allow-export-library",
        "allow-move-storage-root",
    ] {
        assert!(!sticky_permissions.contains(forbidden));
        assert!(main_permissions.contains(forbidden));
    }
    assert!(!sticky_permissions.contains("opener:default"));
    assert!(!main_permissions.contains("opener:default"));
}

#[test]
fn updater_commands_are_main_only_and_plugin_ipc_is_not_granted_to_any_renderer() {
    let main: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    let desktop: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/desktop.json")).unwrap();
    let sticky: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/temporary.json")).unwrap();
    let permissions = |document: &serde_json::Value| {
        document["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<std::collections::HashSet<_>>()
    };
    let main_permissions = permissions(&main);
    let desktop_permissions = permissions(&desktop);
    let sticky_permissions = permissions(&sticky);

    for command in [
        "allow-check-for-update",
        "allow-install-pending-update",
        "allow-restart-after-update",
    ] {
        assert!(main_permissions.contains(command));
        assert!(!desktop_permissions.contains(command));
        assert!(!sticky_permissions.contains(command));
    }
    for plugin_permission in [
        "updater:default",
        "updater:allow-check",
        "updater:allow-download",
        "updater:allow-install",
        "updater:allow-download-and-install",
    ] {
        assert!(!main_permissions.contains(plugin_permission));
        assert!(!desktop_permissions.contains(plugin_permission));
        assert!(!sticky_permissions.contains(plugin_permission));
    }

    let manifest = include_str!("../build.rs");
    for command in [
        "check_for_update",
        "install_pending_update",
        "restart_after_update",
    ] {
        assert!(manifest.contains(&format!("\"{command}\",")));
    }
}

#[test]
fn update_command_authorization_accepts_only_the_main_window_label() {
    assert!(simple_notes_lib::commands::updates::authorize_main_window_label("main").is_ok());
    for unprivileged_label in ["temporary-ipc-test", "desktop", "main-clone"] {
        assert_eq!(
            simple_notes_lib::commands::updates::authorize_main_window_label(unprivileged_label)
                .unwrap_err()
                .code(),
            CommandErrorCode::Validation,
        );
    }
}

#[test]
fn validates_png_jpeg_gif_and_webp_with_canonical_extensions_and_dimensions() {
    for (media_type, format, extension) in [
        ("image/png", ImageFormat::Png, "png"),
        ("image/jpeg", ImageFormat::Jpeg, "jpg"),
        ("image/gif", ImageFormat::Gif, "gif"),
        ("image/webp", ImageFormat::WebP, "webp"),
    ] {
        let validated = validate_image(media_type, &encoded(format, 2, 3)).unwrap();
        assert_eq!(validated.extension(), extension);
        assert_eq!(validated.dimensions(), (2, 3));
    }
}

#[test]
fn rejects_spoofed_malformed_unsupported_empty_and_oversized_payloads() {
    let png = encoded(ImageFormat::Png, 2, 3);
    for error in [
        validate_image("image/jpeg", &png).unwrap_err(),
        validate_image("image/png", &png[..12]).unwrap_err(),
        validate_image("image/bmp", &png).unwrap_err(),
        validate_image("image/png", &[]).unwrap_err(),
        validate_image("image/png", &vec![0; 20 * 1024 * 1024 + 1]).unwrap_err(),
    ] {
        assert_eq!(error.code(), CommandErrorCode::Validation);
        assert!(!error.message().contains(':'));
    }
}

#[test]
fn rejects_zero_and_oversized_dimensions_before_decoding_pixels() {
    assert_eq!(
        validate_image("image/png", &png_header(0, 2))
            .unwrap_err()
            .code(),
        CommandErrorCode::Validation
    );
    assert_eq!(
        validate_image("image/png", &png_header(16_385, 2))
            .unwrap_err()
            .code(),
        CommandErrorCode::Validation
    );
}

#[test]
fn persists_assets_for_formal_and_temporary_notes_without_overwrite_or_absolute_paths() {
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    create_note(&store, TEMPORARY_ID, NoteKind::Temporary);
    let png = encoded(ImageFormat::Png, 2, 3);

    let formal = save_image_to(&store.paths, input(FORMAL_ID, "image/png", png.clone())).unwrap();
    let second = save_image_to(&store.paths, input(FORMAL_ID, "image/png", png.clone())).unwrap();
    let temporary = save_image_to(&store.paths, input(TEMPORARY_ID, "image/png", png)).unwrap();

    assert_ne!(formal.relative_path, second.relative_path);
    assert!(formal.relative_path.starts_with("assets/screenshot-"));
    assert!(formal.relative_path.ends_with(".png"));
    assert!(!formal.relative_path.contains('\\'));
    assert!(!formal.relative_path.contains(FORMAL_ID));
    assert_eq!((formal.width, formal.height), (2, 3));
    assert!(store
        .paths
        .note_dir(id(FORMAL_ID), NoteKind::Formal)
        .unwrap()
        .join(&formal.relative_path)
        .exists());
    assert!(store
        .paths
        .note_dir(id(TEMPORARY_ID), NoteKind::Temporary)
        .unwrap()
        .join(&temporary.relative_path)
        .exists());
}

#[test]
fn reads_only_validated_owned_image_asset_labels() {
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let png = encoded(ImageFormat::Png, 2, 3);
    let saved = save_image_to(&store.paths, input(FORMAL_ID, "image/png", png.clone())).unwrap();

    let loaded = read_image_asset_from(&store.paths, id(FORMAL_ID), &saved.relative_path).unwrap();
    assert_eq!(loaded.media_type, "image/png");
    assert_eq!(loaded.bytes, png);
    for invalid in [
        "../outside.png",
        "assets/../outside.png",
        "assets/nested/image.png",
        "assets/not-an-owned-name.png",
        "https://example.invalid/image.png",
    ] {
        assert_eq!(
            read_image_asset_from(&store.paths, id(FORMAL_ID), invalid)
                .unwrap_err()
                .code(),
            CommandErrorCode::Validation,
            "unexpected result for {invalid}"
        );
    }
}

#[test]
fn external_urls_are_an_explicit_protocol_allowlist() {
    for valid in [
        "https://example.com/path",
        "http://localhost:8080/a",
        "mailto:person@example.com",
    ] {
        assert!(validate_external_url(valid).is_ok(), "rejected {valid}");
    }
    for invalid in [
        "javascript:alert(1)",
        "file:///private/note",
        "../relative",
        "https://",
        "https://example.com/line\nbreak",
    ] {
        assert_eq!(
            validate_external_url(invalid).unwrap_err().code(),
            CommandErrorCode::Validation
        );
    }
}

#[test]
fn desktop_csp_blocks_network_images_and_keeps_only_required_local_sources() {
    let config_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(config_path).unwrap()).unwrap();
    let csp = config["app"]["security"]["csp"].as_str().unwrap();

    assert!(!csp.trim().is_empty());
    assert!(csp.contains("default-src 'self'"));
    assert!(csp.contains("img-src 'self' blob:"));
    assert!(csp.contains("script-src 'self'"));
    let image_directive = csp
        .split(';')
        .find(|part| part.trim_start().starts_with("img-src "))
        .unwrap();
    assert!(!image_directive.contains("http:"));
    assert!(!image_directive.contains("https:"));
    assert!(!image_directive.contains("data:"));
}

#[cfg(unix)]
#[test]
fn image_read_rejects_an_asset_file_symlink_escape() {
    use std::os::unix::fs::symlink;

    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let saved = save_image_to(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
    )
    .unwrap();
    let asset = store
        .paths
        .note_dir(id(FORMAL_ID), NoteKind::Formal)
        .unwrap()
        .join(&saved.relative_path);
    std::fs::remove_file(&asset).unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    symlink(outside.path(), &asset).unwrap();

    assert!(read_image_asset_from(&store.paths, id(FORMAL_ID), &saved.relative_path).is_err());
}

#[cfg(windows)]
#[test]
#[ignore = "creating a file symlink requires Windows Developer Mode or elevation"]
fn image_read_rejects_an_asset_file_reparse_escape() {
    use std::os::windows::fs::symlink_file;

    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let saved = save_image_to(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
    )
    .unwrap();
    let asset = store
        .paths
        .note_dir(id(FORMAL_ID), NoteKind::Formal)
        .unwrap()
        .join(&saved.relative_path);
    std::fs::remove_file(&asset).unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    symlink_file(outside.path(), &asset).unwrap();

    assert!(read_image_asset_from(&store.paths, id(FORMAL_ID), &saved.relative_path).is_err());
}

#[test]
fn image_save_holds_the_mutation_lock_through_asset_publication() {
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let paths = store.paths.clone();
    let (entered_tx, entered_rx) = mpsc::channel();
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let release_for_save = release.clone();
    let save = std::thread::spawn(move || {
        let mut next_uuid = uuid::Uuid::now_v7;
        let mut write = |file: &mut std::fs::File, bytes: &[u8]| {
            file.write_all(bytes)
                .and_then(|()| file.sync_all())
                .map_err(|source| {
                    simple_notes_lib::error::CommandError::io(format!(
                        "could not persist image asset: {source}"
                    ))
                })
        };
        let mut before_publish = |_directory: &simple_notes_lib::platform::SafeDirectory,
                                  _staging: &str,
                                  _filename: &str| {
            entered_tx.send(()).unwrap();
            let (released, wake) = &*release_for_save;
            let mut released = released.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
        };
        let mut sync =
            |directory: &simple_notes_lib::platform::SafeDirectory, _name: &str| directory.sync();
        save_image_to_with_publish_hook(
            &paths,
            input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
            &mut next_uuid,
            &mut write,
            &mut before_publish,
            &mut sync,
        )
    });
    entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();

    assert!(
        simple_notes_lib::platform::IndexMutationLock::acquire_with_timeout(
            store.paths.root(),
            Duration::from_millis(25),
        )
        .is_err(),
        "an image save must keep relocation from beginning after its note lookup"
    );
    let (released, wake) = &*release;
    *released.lock().unwrap() = true;
    wake.notify_one();
    save.join().unwrap().unwrap();
}

#[test]
fn rejects_unknown_note_ids_without_leaking_the_storage_root() {
    let store = TestStore::new();
    let error = save_image_to(
        &store.paths,
        input(UNKNOWN_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
    )
    .unwrap_err();

    assert_eq!(error.code(), CommandErrorCode::NotFound);
    assert!(!error
        .message()
        .contains(&store.root.path().display().to_string()));
    assert!(error.diagnostic().is_some());
}

#[test]
fn write_failure_leaves_only_a_private_staging_orphan() {
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let asset_dir = store
        .paths
        .assets_dir(id(FORMAL_ID), NoteKind::Formal)
        .unwrap();
    let write_uuid = uuid("019c0000-0000-7000-8000-000000000081");
    let mut names = || write_uuid;
    let mut fail_write = |file: &mut std::fs::File, _bytes: &[u8]| {
        file.write_all(b"partial").unwrap();
        Err(simple_notes_lib::error::CommandError::io(
            "injected write failure",
        ))
    };
    let mut sync =
        |directory: &simple_notes_lib::platform::SafeDirectory, _name: &str| directory.sync();

    save_image_to_with(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
        &mut names,
        &mut fail_write,
        &mut sync,
    )
    .unwrap_err();
    let entries = std::fs::read_dir(&asset_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        entries,
        vec![format!(".screenshot-{write_uuid}.png.partial")]
    );
    assert_eq!(
        std::fs::read(asset_dir.join(&entries[0])).unwrap(),
        b"partial"
    );
}

#[test]
fn directory_sync_failure_keeps_the_published_asset_as_a_recoverable_orphan() {
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let asset_dir = store
        .paths
        .assets_dir(id(FORMAL_ID), NoteKind::Formal)
        .unwrap();
    let sync_uuid = uuid("019c0000-0000-7000-8000-000000000082");
    let mut names = || sync_uuid;
    let expected = encoded(ImageFormat::Png, 2, 3);
    let mut write = |file: &mut std::fs::File, bytes: &[u8]| {
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|source| simple_notes_lib::error::CommandError::io(source.to_string()))
    };
    let mut fail_sync = |_directory: &simple_notes_lib::platform::SafeDirectory, _name: &str| {
        Err(simple_notes_lib::error::CommandError::io(
            "injected sync failure",
        ))
    };
    save_image_to_with(
        &store.paths,
        input(FORMAL_ID, "image/png", expected.clone()),
        &mut names,
        &mut write,
        &mut fail_sync,
    )
    .unwrap_err();
    assert_eq!(
        std::fs::read(asset_dir.join(format!("screenshot-{sync_uuid}.png"))).unwrap(),
        expected
    );
}

#[test]
fn cleanup_never_deletes_a_replacement_that_arrives_before_sync_failure() {
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let uuid = uuid("019c0000-0000-7000-8000-000000000083");
    let filename = format!("screenshot-{uuid}.png");
    let mut names = || uuid;
    let mut write = |file: &mut std::fs::File, bytes: &[u8]| {
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|source| simple_notes_lib::error::CommandError::io(source.to_string()))
    };
    let mut replace_then_fail = |directory: &simple_notes_lib::platform::SafeDirectory,
                                 name: &str| {
        assert_eq!(name, filename);
        directory.remove_checked(name).unwrap();
        let mut replacement = directory.create_new(name).unwrap();
        replacement
            .write_all(b"replacement-owned-elsewhere")
            .unwrap();
        replacement.sync_all().unwrap();
        Err(simple_notes_lib::error::CommandError::io(
            "injected sync failure",
        ))
    };

    save_image_to_with(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
        &mut names,
        &mut write,
        &mut replace_then_fail,
    )
    .unwrap_err();

    let asset = store
        .paths
        .assets_dir(id(FORMAL_ID), NoteKind::Formal)
        .unwrap()
        .join(filename);
    assert_eq!(
        std::fs::read(asset).unwrap(),
        b"replacement-owned-elsewhere"
    );
}

#[test]
fn replacement_during_directory_sync_is_not_returned_as_a_saved_asset() {
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let image_uuid = uuid("019c0000-0000-7000-8000-000000000089");
    let mut names = || image_uuid;
    let mut write = |file: &mut std::fs::File, bytes: &[u8]| {
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|source| simple_notes_lib::error::CommandError::io(source.to_string()))
    };
    let mut replace_then_sync = |directory: &simple_notes_lib::platform::SafeDirectory,
                                 name: &str| {
        directory.remove_checked(name).unwrap();
        let mut replacement = directory.create_new(name).unwrap();
        replacement.write_all(b"replacement-during-sync").unwrap();
        replacement.sync_all().unwrap();
        directory.sync()
    };

    let error = save_image_to_with(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
        &mut names,
        &mut write,
        &mut replace_then_sync,
    )
    .unwrap_err();
    assert_eq!(error.code(), CommandErrorCode::Validation);
}

#[test]
fn deterministic_name_collision_preserves_existing_bytes_and_retries_a_new_name() {
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let first = uuid("019c0000-0000-7000-8000-000000000084");
    let second = uuid("019c0000-0000-7000-8000-000000000085");
    let existing_name = format!("screenshot-{first}.png");
    let directory = simple_notes_lib::platform::SafeDirectory::open(
        store.paths.root(),
        &["notes", FORMAL_ID, "assets"],
        true,
    )
    .unwrap();
    let mut existing = directory.create_new(&existing_name).unwrap();
    existing.write_all(b"existing").unwrap();
    existing.sync_all().unwrap();
    drop(existing);
    let mut candidates = [first, second].into_iter();
    let mut names = || candidates.next().unwrap();
    let mut write = |file: &mut std::fs::File, bytes: &[u8]| {
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|source| simple_notes_lib::error::CommandError::io(source.to_string()))
    };
    let mut sync =
        |directory: &simple_notes_lib::platform::SafeDirectory, _name: &str| directory.sync();

    let saved = save_image_to_with(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
        &mut names,
        &mut write,
        &mut sync,
    )
    .unwrap();

    assert_eq!(directory.read(&existing_name, 100).unwrap(), b"existing");
    assert_eq!(
        saved.relative_path,
        format!("assets/screenshot-{second}.png")
    );
}

#[test]
fn staging_replacement_between_write_and_publish_is_never_returned_as_an_asset() {
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let replacement = b"replacement-is-not-a-validated-image";
    let image_uuid = uuid("019c0000-0000-7000-8000-000000000086");
    let filename = format!("screenshot-{image_uuid}.png");
    let mut names = || image_uuid;
    let mut write = |file: &mut std::fs::File, bytes: &[u8]| {
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|source| simple_notes_lib::error::CommandError::io(source.to_string()))
    };
    let mut replace_staging = |directory: &simple_notes_lib::platform::SafeDirectory,
                               staging: &str,
                               destination: &str| {
        assert_eq!(destination, filename);
        directory.remove_checked(staging).unwrap();
        let mut file = directory.create_new(staging).unwrap();
        file.write_all(replacement).unwrap();
        file.sync_all().unwrap();
    };
    let mut sync =
        |directory: &simple_notes_lib::platform::SafeDirectory, _name: &str| directory.sync();

    let error = save_image_to_with_publish_hook(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
        &mut names,
        &mut write,
        &mut replace_staging,
        &mut sync,
    )
    .unwrap_err();

    assert_eq!(error.code(), CommandErrorCode::Validation);
    let published = store
        .paths
        .assets_dir(id(FORMAL_ID), NoteKind::Formal)
        .unwrap()
        .join(filename);
    assert_eq!(std::fs::read(published).unwrap(), replacement);
}

#[cfg(unix)]
#[test]
fn staging_symlink_replacement_is_never_returned_as_an_asset() {
    use std::os::unix::fs::symlink;
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(outside.path(), b"outside").unwrap();
    let image_uuid = uuid("019c0000-0000-7000-8000-000000000087");
    let mut names = || image_uuid;
    let mut write = |file: &mut std::fs::File, bytes: &[u8]| {
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|source| simple_notes_lib::error::CommandError::io(source.to_string()))
    };
    let mut replace_staging = |directory: &simple_notes_lib::platform::SafeDirectory,
                               staging: &str,
                               _destination: &str| {
        directory.remove_checked(staging).unwrap();
        symlink(outside.path(), directory.child_path(staging).unwrap()).unwrap();
    };
    let mut sync =
        |directory: &simple_notes_lib::platform::SafeDirectory, _name: &str| directory.sync();

    let error = save_image_to_with_publish_hook(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
        &mut names,
        &mut write,
        &mut replace_staging,
        &mut sync,
    )
    .unwrap_err();
    assert!(matches!(
        error.code(),
        CommandErrorCode::Validation | CommandErrorCode::Io
    ));
    assert_eq!(std::fs::read(outside.path()).unwrap(), b"outside");
}

#[cfg(windows)]
#[test]
#[ignore = "creating a file symlink requires Windows Developer Mode or elevation"]
fn staging_reparse_replacement_is_never_returned_as_an_asset() {
    use std::os::windows::fs::symlink_file;
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let outside = tempfile::NamedTempFile::new().unwrap();
    let image_uuid = uuid("019c0000-0000-7000-8000-000000000088");
    let mut names = || image_uuid;
    let mut write = |file: &mut std::fs::File, bytes: &[u8]| {
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|source| simple_notes_lib::error::CommandError::io(source.to_string()))
    };
    let mut replace_staging = |directory: &simple_notes_lib::platform::SafeDirectory,
                               staging: &str,
                               _destination: &str| {
        directory.remove_checked(staging).unwrap();
        symlink_file(outside.path(), directory.child_path(staging).unwrap()).unwrap();
    };
    let mut sync =
        |directory: &simple_notes_lib::platform::SafeDirectory, _name: &str| directory.sync();
    let error = save_image_to_with_publish_hook(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
        &mut names,
        &mut write,
        &mut replace_staging,
        &mut sync,
    )
    .unwrap_err();
    assert!(matches!(
        error.code(),
        CommandErrorCode::Validation | CommandErrorCode::Io
    ));
}

#[cfg(unix)]
#[test]
fn rejects_a_symlinked_assets_directory_escape() {
    use std::os::unix::fs::symlink;
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let note_dir = store
        .paths
        .note_dir(id(FORMAL_ID), NoteKind::Formal)
        .unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), note_dir.join("assets")).unwrap();

    let error = save_image_to(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
    )
    .unwrap_err();
    assert!(matches!(
        error.code(),
        CommandErrorCode::Io | CommandErrorCode::Validation
    ));
    assert_eq!(outside.path().read_dir().unwrap().count(), 0);
}

#[cfg(windows)]
#[test]
#[ignore = "creating a junction requires privileges unavailable in standard test sessions"]
fn rejects_a_junctioned_assets_directory_escape() {
    use std::os::windows::fs::symlink_dir;
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let note_dir = store
        .paths
        .note_dir(id(FORMAL_ID), NoteKind::Formal)
        .unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink_dir(outside.path(), note_dir.join("assets")).unwrap();

    let error = save_image_to(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
    )
    .unwrap_err();
    assert!(matches!(
        error.code(),
        CommandErrorCode::Io | CommandErrorCode::Validation
    ));
    assert_eq!(outside.path().read_dir().unwrap().count(), 0);
}

fn input(note_id: &str, media_type: &str, bytes: Vec<u8>) -> SaveImageInput {
    SaveImageInput {
        note_id: id(note_id),
        media_type: media_type.to_owned(),
        bytes,
    }
}

fn create_note(store: &TestStore, note_id: &str, kind: NoteKind) {
    let db = Database::open(store.paths.database()).unwrap();
    db.migrate().unwrap();
    db.close().unwrap();
    NoteRepository::new(store.paths.clone())
        .create(NoteDocument {
            id: id(note_id),
            kind,
            title: "image owner".to_owned(),
            folder_id: None,
            tags: vec![],
            markdown: String::new(),
            revision: 0,
            created_at: "2026-07-30T15:30:00+08:00".to_owned(),
            updated_at: "2026-07-30T15:30:00+08:00".to_owned(),
        })
        .unwrap();
}

fn id(value: &str) -> NoteId {
    NoteId::parse_str(value).unwrap()
}

fn uuid(value: &str) -> uuid::Uuid {
    uuid::Uuid::parse_str(value).unwrap()
}

fn encoded(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::new_rgba8(width, height)
        .write_to(&mut bytes, format)
        .unwrap();
    bytes.into_inner()
}

fn png_header(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10];
    let mut ihdr = Vec::from(width.to_be_bytes());
    ihdr.extend(height.to_be_bytes());
    ihdr.extend([8, 6, 0, 0, 0]);
    append_png_chunk(&mut bytes, b"IHDR", &ihdr);
    append_png_chunk(&mut bytes, b"IEND", &[]);
    bytes
}

fn append_png_chunk(output: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    output.extend((data.len() as u32).to_be_bytes());
    output.extend(kind);
    output.extend(data);
    let mut crc_data = Vec::from(*kind);
    crc_data.extend(data);
    output.extend(crc32(&crc_data).to_be_bytes());
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}
