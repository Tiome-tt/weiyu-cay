use crate::{
    commands::notes::NoteCommandState,
    domain::{NoteKind, SaveImageInput, SavedImage},
    error::CommandError,
    platform::SafeDirectory,
    storage::{database::Database, paths::StoragePaths, repository::NoteRepository},
};
use image::{GenericImageView, ImageFormat, ImageReader, Limits};
use std::io::{Cursor, Write};
use tauri::State;
use uuid::Uuid;

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 16_384;

#[derive(Debug, Clone, Copy)]
pub struct ValidatedImage {
    format: ImageFormat,
    width: u32,
    height: u32,
}

impl ValidatedImage {
    pub fn extension(self) -> &'static str {
        match self.format {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpg",
            ImageFormat::Gif => "gif",
            ImageFormat::WebP => "webp",
            _ => unreachable!("validated image format is restricted"),
        }
    }

    pub fn dimensions(self) -> (u32, u32) {
        (self.width, self.height)
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_image(
    state: State<'_, NoteCommandState>,
    input: SaveImageInput,
) -> Result<SavedImage, CommandError> {
    save_image_to(state.paths(), input)
}

pub fn validate_image(media_type: &str, bytes: &[u8]) -> Result<ValidatedImage, CommandError> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(CommandError::validation("image payload size is invalid"));
    }
    let declared = match media_type {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::WebP,
        _ => return Err(CommandError::validation("image media type is unsupported")),
    };
    let detected = image::guess_format(bytes).map_err(|source| {
        CommandError::validation(format!("image signature is invalid: {source}"))
    })?;
    if detected != declared {
        return Err(CommandError::validation(
            "declared image media type does not match its content",
        ));
    }

    let reader = ImageReader::with_format(Cursor::new(bytes), declared);
    let dimensions = reader.into_dimensions().map_err(|source| {
        CommandError::validation(format!("image dimensions are invalid: {source}"))
    })?;
    if dimensions.0 == 0
        || dimensions.1 == 0
        || dimensions.0 > MAX_IMAGE_DIMENSION
        || dimensions.1 > MAX_IMAGE_DIMENSION
    {
        return Err(CommandError::validation(
            "image dimensions exceed safe limits",
        ));
    }

    let mut decoder = ImageReader::with_format(Cursor::new(bytes), declared);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    decoder.limits(limits);
    let decoded = decoder
        .decode()
        .map_err(|source| CommandError::validation(format!("image cannot be decoded: {source}")))?;
    if decoded.dimensions() != dimensions {
        return Err(CommandError::validation(
            "decoded image dimensions are inconsistent",
        ));
    }
    Ok(ValidatedImage {
        format: declared,
        width: dimensions.0,
        height: dimensions.1,
    })
}

pub fn save_image_to(
    paths: &StoragePaths,
    input: SaveImageInput,
) -> Result<SavedImage, CommandError> {
    let validated = validate_image(&input.media_type, &input.bytes)?;
    let database = Database::open(paths.database())?;
    database.migrate()?;
    let owner = NoteRepository::new(paths.clone(), database).load(input.note_id)?;
    let collection = match owner.kind {
        NoteKind::Formal => "notes",
        NoteKind::Temporary => "temporary",
    };
    let note_id = input.note_id.to_string();
    let directory = SafeDirectory::open(paths.root(), &[collection, &note_id, "assets"], true)?;

    for _ in 0..32 {
        let filename = format!(
            "screenshot-{}.{}",
            Uuid::now_v7().hyphenated(),
            validated.extension()
        );
        let mut file = match directory.create_new(&filename) {
            Ok(file) => file,
            Err(_error) if directory.regular_file_exists(&filename).unwrap_or(false) => continue,
            Err(error) => return Err(error),
        };
        if let Err(source) = file.write_all(&input.bytes).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = directory.remove_checked(&filename);
            return Err(CommandError::io(format!(
                "could not persist image asset: {source}"
            )));
        }
        drop(file);
        if let Err(error) = directory.sync() {
            let _ = directory.remove_checked(&filename);
            return Err(error);
        }
        return Ok(SavedImage {
            relative_path: format!("assets/{filename}"),
            width: validated.width,
            height: validated.height,
        });
    }
    Err(CommandError::conflict(
        "could not allocate a collision-free image name",
    ))
}
