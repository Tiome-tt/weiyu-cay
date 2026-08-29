use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use uuid::{Uuid, Variant, Version};

macro_rules! uuid_v7_id {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub struct $name(Uuid);

        impl $name {
            pub fn now_v7() -> Self {
                Self(Uuid::now_v7())
            }

            pub fn parse_str(value: &str) -> Result<Self, InvalidUuidV7> {
                let uuid = Uuid::parse_str(value).map_err(|_| InvalidUuidV7)?;
                if uuid.get_version() != Some(Version::SortRand)
                    || uuid.get_variant() != Variant::RFC4122
                    || uuid.hyphenated().to_string() != value
                {
                    return Err(InvalidUuidV7);
                }
                Ok(Self(uuid))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.hyphenated().fmt(formatter)
            }
        }

        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_str(&self.to_string())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::parse_str(&value).map_err(de::Error::custom)
            }
        }
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidUuidV7;

impl fmt::Display for InvalidUuidV7 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("expected a canonical lowercase UUIDv7")
    }
}

impl std::error::Error for InvalidUuidV7 {}

uuid_v7_id!(NoteId);
uuid_v7_id!(FolderId);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteKind {
    Formal,
    Temporary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorMode {
    Source,
    Split,
    Preview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDocument {
    pub id: NoteId,
    pub kind: NoteKind,
    pub title: String,
    pub folder_id: Option<FolderId>,
    pub tags: Vec<String>,
    pub markdown: String,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: NoteId,
    pub kind: NoteKind,
    pub title: String,
    pub folder_id: Option<FolderId>,
    pub tags: Vec<String>,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRepairResult {
    pub updated: usize,
    pub failed_source_ids: Vec<NoteId>,
    pub failure: Option<LinkRepairFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRepairFailure {
    pub code: crate::error::CommandErrorCode,
    pub message: String,
}

impl From<crate::error::CommandError> for LinkRepairFailure {
    fn from(error: crate::error::CommandError) -> Self {
        Self {
            code: error.code(),
            message: error.message().to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameNoteResult {
    pub document: NoteDocument,
    pub link_repair: LinkRepairResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: FolderId,
    pub parent_id: Option<FolderId>,
    pub name: String,
    pub sort_order: i64,
    pub starred: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupGuideTarget {
    pub folder_id: FolderId,
    pub note_id: NoteId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderInput {
    pub parent_id: Option<FolderId>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveImageInput {
    pub note_id: NoteId,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    pub relative_path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadImageAssetInput {
    pub note_id: NoteId,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadImageAsset {
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPreferenceInput {
    pub key: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertTemporaryInput {
    pub ids: Vec<NoteId>,
    pub folder_id: FolderId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertedTemporaryNote {
    pub temporary_id: NoteId,
    pub note_id: NoteId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchConversionFailure {
    pub temporary_id: NoteId,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchConversionResult {
    pub converted: Vec<ConvertedTemporaryNote>,
    pub failed: Vec<BatchConversionFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub note_id: NoteId,
    pub kind: NoteKind,
    pub title: String,
    pub previous_folder_id: Option<FolderId>,
    pub previous_folder_name: Option<String>,
    pub previous_relative_path: String,
    pub deleted_at: String,
    pub assets: Vec<String>,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashFolderEntry {
    pub folder_id: FolderId,
    pub title: String,
    pub deleted_at: String,
    pub operation_id: String,
    pub folder_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashFailure {
    pub note_id: NoteId,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashBatchResult {
    pub operation_id: String,
    pub trashed: Vec<NoteId>,
    pub failed: Vec<TrashFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreTrashResult {
    pub restored: Vec<NoteDocument>,
    pub failed: Vec<TrashFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeTrashResult {
    pub purged: Vec<NoteId>,
    pub failed: Vec<TrashFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryOperationFailure {
    pub temporary_id: NoteId,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTemporaryResult {
    pub operation_id: String,
    pub deleted: Vec<NoteId>,
    pub failed: Vec<TemporaryOperationFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoTemporaryDeleteResult {
    pub operation_id: String,
    pub restored: Vec<NoteId>,
    pub failed: Vec<TemporaryOperationFailure>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub note_id: NoteId,
    pub title: String,
    pub folder_breadcrumb: Vec<String>,
    pub tags: Vec<String>,
    pub excerpt: String,
    pub score: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryWindowState {
    pub note_id: NoteId,
    pub visible: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub always_on_top: bool,
}
