use simple_notes_lib::domain::{
    BatchConversionFailure, BatchConversionResult, ConvertedTemporaryNote, NoteDocument, NoteKind,
};
use simple_notes_lib::error::{CommandError, CommandErrorCode};
use uuid::Uuid;

#[test]
fn domain_note_document_round_trips_with_camel_case_fields() {
    let note = NoteDocument {
        id: Uuid::parse_str("019c0000-0000-7000-8000-000000000002").unwrap(),
        kind: NoteKind::Formal,
        title: "登录流程".to_owned(),
        folder_id: Some(Uuid::parse_str("019c0000-0000-7000-8000-000000000001").unwrap()),
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
    let temporary_id = Uuid::parse_str("019c0000-0000-7000-8000-000000000010").unwrap();
    let note_id = Uuid::parse_str("019c0000-0000-7000-8000-000000000012").unwrap();
    let result = BatchConversionResult {
        converted: vec![ConvertedTemporaryNote {
            temporary_id,
            note_id,
        }],
        failed: vec![BatchConversionFailure {
            temporary_id: Uuid::parse_str("019c0000-0000-7000-8000-000000000011").unwrap(),
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
