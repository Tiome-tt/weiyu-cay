use weiyu_cay_lib::commands::notes::CreateNoteInput;
use weiyu_cay_lib::domain::{
    BatchConversionFailure, BatchConversionResult, ConvertedTemporaryNote, FolderId, NoteDocument,
    NoteId, NoteKind,
};
use weiyu_cay_lib::error::{CommandError, CommandErrorCode};

#[test]
fn create_note_command_accepts_the_renderer_title_and_folder_contract() {
    let folder = "019c0000-0000-7000-8000-000000000001";
    let input: CreateNoteInput =
        serde_json::from_value(serde_json::json!({ "folderId": folder, "title": "发布检查" }))
            .unwrap();

    assert_eq!(input.folder_id, Some(FolderId::parse_str(folder).unwrap()));
    assert_eq!(input.title, "发布检查");
    assert!(
        serde_json::from_value::<CreateNoteInput>(serde_json::json!({ "folderId": folder }))
            .is_err()
    );
}

#[test]
fn domain_note_document_round_trips_with_camel_case_fields() {
    let note = NoteDocument {
        id: NoteId::parse_str("019c0000-0000-7000-8000-000000000002").unwrap(),
        kind: NoteKind::Formal,
        title: "登录流程".to_owned(),
        folder_id: Some(FolderId::parse_str("019c0000-0000-7000-8000-000000000001").unwrap()),
        tags: vec!["项目 B".to_owned()],
        markdown: "# 登录流程".to_owned(),
        revision: 1,
        created_at: "2026-07-30T15:30:00+08:00".to_owned(),
        updated_at: "2026-07-30T15:30:00+08:00".to_owned(),
    };

    let json = serde_json::to_value(&note).unwrap();
    assert_eq!(json["folderId"], "019c0000-0000-7000-8000-000000000001");
    assert_eq!(json["createdAt"], "2026-07-30T15:30:00+08:00");
    assert!(json.get("folder_id").is_none());
    assert_eq!(serde_json::from_value::<NoteDocument>(json).unwrap(), note);
}

#[test]
fn domain_batch_conversion_round_trips_with_matching_typescript_fields() {
    let temporary_id = NoteId::parse_str("019c0000-0000-7000-8000-000000000010").unwrap();
    let note_id = NoteId::parse_str("019c0000-0000-7000-8000-000000000012").unwrap();
    let result = BatchConversionResult {
        converted: vec![ConvertedTemporaryNote {
            temporary_id,
            note_id,
        }],
        failed: vec![BatchConversionFailure {
            temporary_id: NoteId::parse_str("019c0000-0000-7000-8000-000000000011").unwrap(),
            message: "接口异常处理".to_owned(),
        }],
    };

    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(
        json["converted"][0]["temporaryId"],
        temporary_id.to_string()
    );
    assert_eq!(json["converted"][0]["noteId"], note_id.to_string());
    assert_eq!(
        serde_json::from_value::<BatchConversionResult>(json).unwrap(),
        result
    );
}

#[test]
fn domain_command_errors_serialize_only_the_stable_safe_contract() {
    let error = CommandError::database("C:\\Users\\person\\notes\\index.sqlite is corrupt");
    let json = serde_json::to_value(&error).unwrap();

    assert_eq!(json["code"], "database");
    assert_eq!(json["message"], "The local note index is unavailable.");
    assert_eq!(json.as_object().unwrap().len(), 2);
    assert!(!json.to_string().contains("person"));
    assert_eq!(serde_json::from_value::<CommandError>(json).unwrap(), error);
    assert_eq!(error.code(), CommandErrorCode::Database);
}

#[test]
fn domain_note_ids_reject_non_v7_non_rfc_and_noncanonical_values() {
    let valid_folder_id = "019c0000-0000-7000-8000-000000000001";
    for invalid_id in [
        "019c0000-0000-4000-8000-000000000002",
        "019c0000-0000-1000-8000-000000000002",
        "019c0000-0000-7000-7000-000000000002",
        "019C0000-0000-7000-8000-000000000002",
    ] {
        let value = serde_json::json!({
            "id": invalid_id,
            "kind": "formal",
            "title": "登录流程",
            "folderId": valid_folder_id,
            "tags": [],
            "markdown": "# 登录流程",
            "revision": 1,
            "createdAt": "2026-07-30T15:30:00+08:00",
            "updatedAt": "2026-07-30T15:30:00+08:00"
        });

        assert!(serde_json::from_value::<NoteDocument>(value).is_err());
    }
}

#[test]
fn domain_folder_ids_reject_non_v7_values() {
    let value = serde_json::json!({
        "id": "019c0000-0000-7000-8000-000000000002",
        "kind": "formal",
        "title": "登录流程",
        "folderId": "019c0000-0000-4000-8000-000000000001",
        "tags": [],
        "markdown": "# 登录流程",
        "revision": 1,
        "createdAt": "2026-07-30T15:30:00+08:00",
        "updatedAt": "2026-07-30T15:30:00+08:00"
    });

    assert!(serde_json::from_value::<NoteDocument>(value).is_err());
}
