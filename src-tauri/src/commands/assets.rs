use crate::{
    commands::storage::{StorageCommandState, StorageConsumer},
    domain::{NoteKind, SaveImageInput, SavedImage},
    error::CommandError,
    platform::{IndexMutationLock, NewFilePublishState, SafeDirectory},
    storage::{paths::StoragePaths, repository::NoteRepository},
    windows::sticky::authorize_asset_caller,
};
use image::{GenericImageView, ImageFormat, ImageReader, Limits};
use std::{
    fs::File,
    io::{Cursor, Write},
};
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
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    input: SaveImageInput,
) -> Result<SavedImage, CommandError> {
    authorize_asset_caller(window.label(), input.note_id)?;
    save_image_to(state.paths_for(StorageConsumer::Assets), input)
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
    let mut next_uuid = Uuid::now_v7;
    let mut write = |file: &mut File, bytes: &[u8]| {
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|source| CommandError::io(format!("could not persist image asset: {source}")))
    };
    let mut sync = |directory: &SafeDirectory, _filename: &str| directory.sync();
    save_image_to_with(paths, input, &mut next_uuid, &mut write, &mut sync)
}

#[doc(hidden)]
pub fn save_image_to_with<N, W, S>(
    paths: &StoragePaths,
    input: SaveImageInput,
    next_uuid: &mut N,
    write: &mut W,
    sync: &mut S,
) -> Result<SavedImage, CommandError>
where
    N: FnMut() -> Uuid,
    W: FnMut(&mut File, &[u8]) -> Result<(), CommandError>,
    S: FnMut(&SafeDirectory, &str) -> Result<(), CommandError>,
{
    let mut before_publish = |_directory: &SafeDirectory, _staging: &str, _filename: &str| {};
    let guard = IndexMutationLock::acquire(paths.root())?;
    save_image_to_with_publish_hook_locked(
        paths,
        input,
        next_uuid,
        write,
        &mut before_publish,
        sync,
        &guard,
    )
}

#[doc(hidden)]
pub fn save_image_to_with_publish_hook<N, W, B, S>(
    paths: &StoragePaths,
    input: SaveImageInput,
    next_uuid: &mut N,
    write: &mut W,
    before_publish: &mut B,
    sync: &mut S,
) -> Result<SavedImage, CommandError>
where
    N: FnMut() -> Uuid,
    W: FnMut(&mut File, &[u8]) -> Result<(), CommandError>,
    B: FnMut(&SafeDirectory, &str, &str),
    S: FnMut(&SafeDirectory, &str) -> Result<(), CommandError>,
{
    let guard = IndexMutationLock::acquire(paths.root())?;
    save_image_to_with_publish_hook_locked(
        paths,
        input,
        next_uuid,
        write,
        before_publish,
        sync,
        &guard,
    )
}

fn save_image_to_with_publish_hook_locked<N, W, B, S>(
    paths: &StoragePaths,
    input: SaveImageInput,
    next_uuid: &mut N,
    write: &mut W,
    before_publish: &mut B,
    sync: &mut S,
    guard: &IndexMutationLock,
) -> Result<SavedImage, CommandError>
where
    N: FnMut() -> Uuid,
    W: FnMut(&mut File, &[u8]) -> Result<(), CommandError>,
    B: FnMut(&SafeDirectory, &str, &str),
    S: FnMut(&SafeDirectory, &str) -> Result<(), CommandError>,
{
    let validated = validate_image(&input.media_type, &input.bytes)?;
    let owner = NoteRepository::new(paths.clone()).load_locked(input.note_id, guard)?;
    let collection = match owner.kind {
        NoteKind::Formal => "notes",
        NoteKind::Temporary => "temporary",
    };
    let note_id = input.note_id.to_string();
    let directory = SafeDirectory::open(paths.root(), &[collection, &note_id, "assets"], true)?;

    for _ in 0..32 {
        let filename = format!(
            "screenshot-{}.{}",
            next_uuid().hyphenated(),
            validated.extension()
        );
        let staging = format!(".{filename}.partial");
        let mut file = match directory.create_new_publishable(&staging) {
            Ok(file) => file,
            Err(error) => match directory.regular_file_exists(&staging) {
                Ok(true) => continue,
                Ok(false) => return Err(error),
                Err(inspect_error) => return Err(inspect_error),
            },
        };
        write(&mut file, &input.bytes)?;
        before_publish(&directory, &staging, &filename);
        match directory.publish_new(&staging, &filename, &file)? {
            NewFilePublishState::Published => {}
            NewFilePublishState::DestinationExists => continue,
        }
        sync(&directory, &filename)?;
        directory.verify_published(&filename, &file)?;
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
