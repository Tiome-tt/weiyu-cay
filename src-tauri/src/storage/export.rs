use crate::{
    domain::{FolderId, NoteId, NoteKind},
    error::CommandError,
    platform::{SafeDirectory, SafeEntryKind},
    storage::{
        atomic_file::PublishState,
        paths::StoragePaths,
        repository::{parse_document, serialize_document},
    },
};
use pulldown_cmark::{Event, Parser, Tag};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const MAX_NOTE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PORTABLE_COMPONENT_BYTES: usize = 120;
const MAX_PORTABLE_COMPONENT_UTF16: usize = 120;
const EXPORT_MANIFEST: &str = "export-manifest.json";
const EXPORT_ROOT_NAME: &str = "Simple Notes Export";
const STAGING_PREFIX: &str = ".simple-notes-export-";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamedExportPath {
    pub source: String,
    pub destination: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFailure {
    pub note_id: NoteId,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub completed: bool,
    pub output_root: Option<String>,
    pub incomplete_root: Option<String>,
    pub global_failure: Option<String>,
    pub notes_exported: usize,
    pub assets_exported: usize,
    pub renamed_paths: Vec<RenamedExportPath>,
    pub failed: Vec<ExportFailure>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFolder {
    id: FolderId,
    parent_id: Option<FolderId>,
    name: String,
    sort_order: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PortableManifest<'a> {
    app_version: &'a str,
    notes: &'a BTreeMap<String, String>,
}

struct FolderPaths {
    original: Vec<String>,
    portable: Vec<String>,
}

struct AssetPlan {
    source: Vec<String>,
    destination: Vec<String>,
}

struct PreparedAsset {
    destination: Vec<String>,
    bytes: Vec<u8>,
    renamed_path: Option<RenamedExportPath>,
}

struct PreparedNote {
    relative_path: String,
    folder: Vec<String>,
    markdown_name: String,
    assets_name: Option<String>,
    assets: Vec<PreparedAsset>,
    markdown: Vec<u8>,
    renamed_paths: Vec<RenamedExportPath>,
}

type ExportFileWriter<'a> = dyn FnMut(&SafeDirectory, &str, &[u8]) -> Result<(), CommandError> + 'a;

pub fn export_library(
    paths: &StoragePaths,
    destination: &Path,
    app_version: &str,
) -> Result<ExportReport, CommandError> {
    export_library_using(paths, destination, app_version, &mut write_owned_file)
}

fn export_library_using(
    paths: &StoragePaths,
    destination: &Path,
    app_version: &str,
    write_file: &mut ExportFileWriter<'_>,
) -> Result<ExportReport, CommandError> {
    let destination = validate_destination(paths.root(), destination)?;
    let destination_parent = SafeDirectory::open(&destination, &[], false)?;
    let source_root = SafeDirectory::open(paths.root(), &[], false)?;
    let folder_paths = load_folder_paths(&source_root)?;
    let notes_root = source_root.open_child("notes", false)?;
    let mut note_ids = notes_root
        .entry_names()?
        .into_iter()
        .filter_map(|name| NoteId::parse_str(&name).ok())
        .collect::<Vec<_>>();
    note_ids.sort_by_key(ToString::to_string);

    let staging_name = format!("{STAGING_PREFIX}{}.partial", Uuid::now_v7());
    let output = match destination_parent.create_child_no_replace(&staging_name) {
        Ok(output) => output,
        Err(error) => {
            let retained = destination_parent
                .entry_names()
                .ok()
                .is_some_and(|names| names.iter().any(|name| name == &staging_name));
            if retained {
                return Ok(incomplete_report(
                    empty_report(),
                    &destination.join(&staging_name),
                    "The export staging folder could not be created durably.",
                ));
            }
            return Err(error);
        }
    };

    let mut report = ExportReport {
        completed: false,
        output_root: None,
        incomplete_root: None,
        global_failure: None,
        notes_exported: 0,
        assets_exported: 0,
        renamed_paths: Vec::new(),
        failed: Vec::new(),
    };
    let mut manifest_notes = BTreeMap::new();
    let mut allocated_notes: HashMap<Vec<String>, HashSet<String>> = HashMap::new();

    for note_id in note_ids {
        let result = prepare_note(&notes_root, note_id, &folder_paths, &mut allocated_notes);
        match result {
            Ok(prepared) => {
                if write_prepared_note(&output, &prepared, write_file).is_err() {
                    return Ok(incomplete_report(
                        report,
                        &destination.join(&staging_name),
                        "The export contents could not be written.",
                    ));
                }
                report.notes_exported += 1;
                report.assets_exported += prepared.assets.len();
                report.renamed_paths.extend(prepared.renamed_paths);
                manifest_notes.insert(note_id.to_string(), prepared.relative_path);
            }
            Err(error) => report.failed.push(ExportFailure {
                note_id,
                message: error.message().to_owned(),
            }),
        }
    }

    let manifest = match serde_json::to_vec_pretty(&PortableManifest {
        app_version,
        notes: &manifest_notes,
    })
    .map_err(|source| CommandError::io(format!("could not serialize export manifest: {source}")))
    {
        Ok(manifest) => manifest,
        Err(_) => {
            return Ok(incomplete_report(
                report,
                &destination.join(&staging_name),
                "The export manifest could not be created.",
            ))
        }
    };
    if write_file(&output, EXPORT_MANIFEST, &manifest)
        .and_then(|()| output.sync())
        .is_err()
    {
        return Ok(incomplete_report(
            report,
            &destination.join(&staging_name),
            "The export manifest could not be written.",
        ));
    }
    report.renamed_paths.sort_by(|left, right| {
        left.source
            .cmp(&right.source)
            .then_with(|| left.destination.cmp(&right.destination))
    });
    report
        .failed
        .sort_by_key(|failure| failure.note_id.to_string());
    let mut used = destination_parent
        .entry_names()?
        .into_iter()
        .map(|name| portable_key(&name))
        .collect::<HashSet<_>>();
    let final_name = allocate_unique(EXPORT_ROOT_NAME, &mut used);
    match output.move_self_no_replace(&destination_parent, &final_name) {
        Ok(PublishState::Published) => {
            report.completed = true;
            report.output_root = Some(destination.join(final_name).display().to_string());
            Ok(report)
        }
        Ok(state) => Ok(incomplete_report(
            report,
            &published_or_staging_path(&destination, &staging_name, &final_name, state),
            "The export directory could not be published durably.",
        )),
        Err(failure) => {
            let retained = published_or_staging_path(
                &destination,
                &staging_name,
                &final_name,
                failure.state(),
            );
            Ok(incomplete_report(
                report,
                &retained,
                "The export directory could not be published safely.",
            ))
        }
    }
}

fn empty_report() -> ExportReport {
    ExportReport {
        completed: false,
        output_root: None,
        incomplete_root: None,
        global_failure: None,
        notes_exported: 0,
        assets_exported: 0,
        renamed_paths: Vec::new(),
        failed: Vec::new(),
    }
}

fn incomplete_report(
    mut report: ExportReport,
    retained_root: &Path,
    global_failure: &str,
) -> ExportReport {
    report.completed = false;
    report.output_root = None;
    report.incomplete_root = Some(retained_root.display().to_string());
    report.global_failure = Some(global_failure.to_owned());
    report.notes_exported = 0;
    report.assets_exported = 0;
    report.renamed_paths.clear();
    report
}

fn published_or_staging_path(
    parent: &Path,
    staging_name: &str,
    final_name: &str,
    state: PublishState,
) -> PathBuf {
    match state {
        PublishState::Published
        | PublishState::PublishedButSyncFailed
        | PublishState::RecoveryRequired => parent.join(final_name),
        PublishState::NotPublished => parent.join(staging_name),
    }
}

fn prepare_note(
    notes_root: &SafeDirectory,
    note_id: NoteId,
    folder_paths: &HashMap<FolderId, FolderPaths>,
    allocated_notes: &mut HashMap<Vec<String>, HashSet<String>>,
) -> Result<PreparedNote, CommandError> {
    let note_id_string = note_id.to_string();
    let source_note = notes_root.open_child(&note_id_string, false)?;
    let bytes = source_note.read("note.md", MAX_NOTE_BYTES)?;
    let source = std::str::from_utf8(&bytes).map_err(|source| {
        CommandError::validation(format!("note Markdown is not UTF-8: {source}"))
    })?;
    let mut document = parse_document(source)?;
    if document.kind != NoteKind::Formal || document.id != note_id {
        return Err(CommandError::validation(
            "export source is not a matching formal note",
        ));
    }
    let folder = match document.folder_id {
        Some(folder_id) => folder_paths.get(&folder_id).ok_or_else(|| {
            CommandError::validation("formal note references a missing logical folder")
        })?,
        None => &FolderPaths {
            original: Vec::new(),
            portable: Vec::new(),
        },
    };
    let stem = sanitize_component(&document.title);
    let used = allocated_notes.entry(folder.portable.clone()).or_default();
    let portable_stem = allocate_unique(&stem, used);
    let markdown_name = format!("{portable_stem}.md");
    let original_relative = join_relative(
        &folder
            .original
            .iter()
            .cloned()
            .chain(std::iter::once(format!("{}.md", document.title)))
            .collect::<Vec<_>>(),
    );
    let portable_relative = join_relative(
        &folder
            .portable
            .iter()
            .cloned()
            .chain(std::iter::once(markdown_name.clone()))
            .collect::<Vec<_>>(),
    );
    let note_rename = (original_relative != portable_relative).then(|| RenamedExportPath {
        source: original_relative,
        destination: portable_relative.clone(),
    });

    let asset_plans = plan_assets(&source_note)?;
    let asset_references = asset_plans
        .iter()
        .map(|plan| {
            (
                format!("assets/{}", join_relative(&plan.source)),
                format!(
                    "{portable_stem}-assets/{}",
                    join_relative(&plan.destination)
                ),
            )
        })
        .collect::<HashMap<_, _>>();
    let assets_name = (!asset_plans.is_empty()).then(|| format!("{portable_stem}-assets"));
    let mut prepared_assets = Vec::new();
    if let Some(assets_name) = &assets_name {
        let source_assets = source_note.open_child("assets", false)?;
        for plan in asset_plans {
            let source_parent =
                open_existing(&source_assets, &plan.source[..plan.source.len() - 1])?;
            let source_name = plan.source.last().expect("asset source has a file name");
            let bytes = source_parent.read(source_name, MAX_ASSET_BYTES)?;
            let source_relative = join_relative(
                &folder
                    .original
                    .iter()
                    .cloned()
                    .chain(std::iter::once(format!("{}-assets", document.title)))
                    .chain(plan.source.iter().cloned())
                    .collect::<Vec<_>>(),
            );
            let destination_relative = join_relative(
                &folder
                    .portable
                    .iter()
                    .cloned()
                    .chain(std::iter::once(assets_name.clone()))
                    .chain(plan.destination.iter().cloned())
                    .collect::<Vec<_>>(),
            );
            let renamed_path =
                (source_relative != destination_relative).then_some(RenamedExportPath {
                    source: source_relative,
                    destination: destination_relative,
                });
            prepared_assets.push(PreparedAsset {
                destination: plan.destination,
                bytes,
                renamed_path,
            });
        }
    }
    document.markdown = rewrite_asset_references(&document.markdown, &asset_references);
    let serialized = serialize_document(&document)?;
    let mut renamed_paths = prepared_assets
        .iter()
        .filter_map(|asset| asset.renamed_path.clone())
        .collect::<Vec<_>>();
    if let Some(rename) = note_rename {
        renamed_paths.push(rename);
    }
    Ok(PreparedNote {
        relative_path: portable_relative,
        folder: folder.portable.clone(),
        markdown_name,
        assets_name,
        assets: prepared_assets,
        markdown: serialized.into_bytes(),
        renamed_paths,
    })
}

fn write_prepared_note(
    output: &SafeDirectory,
    note: &PreparedNote,
    write_file: &mut ExportFileWriter<'_>,
) -> Result<(), CommandError> {
    let output_folder = open_or_create(output, &note.folder)?;
    if let Some(assets_name) = &note.assets_name {
        let output_assets = output_folder.open_child(assets_name, true)?;
        for asset in &note.assets {
            let target_parent = open_or_create(
                &output_assets,
                &asset.destination[..asset.destination.len() - 1],
            )?;
            let target_name = asset
                .destination
                .last()
                .expect("prepared asset has a file name");
            write_file(&target_parent, target_name, &asset.bytes)?;
        }
    }
    write_file(&output_folder, &note.markdown_name, &note.markdown)
}

fn load_folder_paths(root: &SafeDirectory) -> Result<HashMap<FolderId, FolderPaths>, CommandError> {
    if !root.regular_file_exists("folders.json")? {
        return Ok(HashMap::new());
    }
    let bytes = root.read("folders.json", MAX_MANIFEST_BYTES)?;
    let folders: Vec<ManifestFolder> = serde_json::from_slice(&bytes).map_err(|source| {
        CommandError::validation(format!("folders manifest is invalid: {source}"))
    })?;
    let mut by_parent: HashMap<Option<FolderId>, Vec<ManifestFolder>> = HashMap::new();
    for folder in folders {
        by_parent.entry(folder.parent_id).or_default().push(folder);
    }
    for siblings in by_parent.values_mut() {
        siblings.sort_by(|left, right| {
            left.sort_order
                .cmp(&right.sort_order)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.id.to_string().cmp(&right.id.to_string()))
        });
    }
    let mut result = HashMap::new();
    let mut visiting = HashSet::new();
    materialize_folders(None, &[], &[], &by_parent, &mut visiting, &mut result)?;
    let expected = by_parent.values().map(Vec::len).sum::<usize>();
    if result.len() != expected {
        return Err(CommandError::validation(
            "folders manifest contains a missing parent or cycle",
        ));
    }
    Ok(result)
}

fn materialize_folders(
    parent: Option<FolderId>,
    original_parent: &[String],
    portable_parent: &[String],
    children: &HashMap<Option<FolderId>, Vec<ManifestFolder>>,
    visiting: &mut HashSet<FolderId>,
    result: &mut HashMap<FolderId, FolderPaths>,
) -> Result<(), CommandError> {
    let Some(siblings) = children.get(&parent) else {
        return Ok(());
    };
    let mut used = HashSet::new();
    for folder in siblings {
        if !visiting.insert(folder.id) || result.contains_key(&folder.id) {
            return Err(CommandError::validation(
                "folders manifest contains a cycle",
            ));
        }
        let portable_name = allocate_unique(&sanitize_component(&folder.name), &mut used);
        let mut original = original_parent.to_vec();
        original.push(folder.name.clone());
        let mut portable = portable_parent.to_vec();
        portable.push(portable_name);
        result.insert(
            folder.id,
            FolderPaths {
                original: original.clone(),
                portable: portable.clone(),
            },
        );
        materialize_folders(
            Some(folder.id),
            &original,
            &portable,
            children,
            visiting,
            result,
        )?;
        visiting.remove(&folder.id);
    }
    Ok(())
}

fn plan_assets(note: &SafeDirectory) -> Result<Vec<AssetPlan>, CommandError> {
    if !note.entry_names()?.iter().any(|name| name == "assets") {
        return Ok(Vec::new());
    }
    if note.entry_kind("assets")? != SafeEntryKind::Directory {
        return Err(CommandError::validation(
            "note assets entry is not a directory",
        ));
    }
    let assets = note.open_child("assets", false)?;
    let mut plans = Vec::new();
    collect_asset_plans(&assets, &[], &[], &mut plans)?;
    Ok(plans)
}

fn collect_asset_plans(
    directory: &SafeDirectory,
    source_parent: &[String],
    destination_parent: &[String],
    plans: &mut Vec<AssetPlan>,
) -> Result<(), CommandError> {
    let mut used = HashSet::new();
    for name in directory.entry_names()? {
        let portable = allocate_unique(&sanitize_component(&name), &mut used);
        let mut source = source_parent.to_vec();
        source.push(name.clone());
        let mut destination = destination_parent.to_vec();
        destination.push(portable);
        match directory.entry_kind(&name)? {
            SafeEntryKind::Directory => {
                let child = directory.open_child(&name, false)?;
                collect_asset_plans(&child, &source, &destination, plans)?;
            }
            SafeEntryKind::RegularFile => plans.push(AssetPlan {
                source,
                destination,
            }),
        }
    }
    Ok(())
}

fn rewrite_asset_references(markdown: &str, replacements: &HashMap<String, String>) -> String {
    let mut edits = Vec::new();
    for (event, range) in Parser::new(markdown).into_offset_iter() {
        let destination = match event {
            Event::Start(Tag::Image { dest_url, .. })
            | Event::Start(Tag::Link { dest_url, .. }) => dest_url,
            _ => continue,
        };
        let Some(replacement) = replacements.get(destination.as_ref()) else {
            continue;
        };
        let fragment = &markdown[range.clone()];
        if let Some(offset) = inline_destination_offset(fragment, destination.as_ref()) {
            edits.push((
                range.start + offset,
                range.start + offset + destination.len(),
                replacement.clone(),
            ));
        }
    }
    let mut rewritten = markdown.to_owned();
    edits.sort_by_key(|edit| edit.0);
    for (start, end, replacement) in edits.into_iter().rev() {
        rewritten.replace_range(start..end, &replacement);
    }
    rewrite_reference_definitions(&rewritten, replacements)
}

fn inline_destination_offset(fragment: &str, destination: &str) -> Option<usize> {
    if let Some(after_delimiter) = inline_destination_start(fragment) {
        let whitespace = fragment[after_delimiter..]
            .chars()
            .take_while(|character| character.is_whitespace())
            .map(char::len_utf8)
            .sum::<usize>();
        let mut start = after_delimiter + whitespace;
        if fragment[start..].starts_with('<') {
            start += 1;
        }
        return fragment[start..].starts_with(destination).then_some(start);
    }
    fragment
        .strip_prefix('<')
        .and_then(|inner| inner.starts_with(destination).then_some(1))
}

fn inline_destination_start(fragment: &str) -> Option<usize> {
    let label_start = usize::from(fragment.starts_with('!'));
    if fragment.as_bytes().get(label_start) != Some(&b'[') {
        return None;
    }
    let mut depth = 0_u32;
    let mut escaped = false;
    for (offset, character) in fragment[label_start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        match character {
            '[' => depth = depth.saturating_add(1),
            ']' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    let after_label = label_start + offset + character.len_utf8();
                    return fragment[after_label..]
                        .starts_with('(')
                        .then_some(after_label + 1);
                }
            }
            _ => {}
        }
    }
    None
}

fn rewrite_reference_definitions(markdown: &str, replacements: &HashMap<String, String>) -> String {
    let mut rewritten = markdown.to_owned();
    let mut edits = Vec::new();
    let mut line_start = 0;
    for line in markdown.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        let leading = content.len() - content.trim_start().len();
        let definition = &content[leading..];
        let Some(separator) = definition.find("]:") else {
            line_start += line.len();
            continue;
        };
        if !definition.starts_with('[') {
            line_start += line.len();
            continue;
        }
        let after_separator = leading + separator + 2;
        let destination_start = after_separator
            + content[after_separator..]
                .chars()
                .take_while(|character| character.is_whitespace())
                .map(char::len_utf8)
                .sum::<usize>();
        let remainder = &content[destination_start..];
        let (destination, wrapper) = if let Some(inner) = remainder.strip_prefix('<') {
            match inner.find('>') {
                Some(end) => (&inner[..end], 1),
                None => {
                    line_start += line.len();
                    continue;
                }
            }
        } else {
            (remainder.split_whitespace().next().unwrap_or(""), 0)
        };
        if let Some(replacement) = replacements.get(destination) {
            let start = line_start + destination_start + wrapper;
            edits.push((start, start + destination.len(), replacement));
        }
        line_start += line.len();
    }
    for (start, end, replacement) in edits.into_iter().rev() {
        rewritten.replace_range(start..end, replacement);
    }
    rewritten
}

fn write_owned_file(
    directory: &SafeDirectory,
    name: &str,
    bytes: &[u8],
) -> Result<(), CommandError> {
    if directory.regular_file_exists(name)? {
        return Err(CommandError::conflict(
            "export destination file already exists",
        ));
    }
    let mut file = directory.create_new(name)?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|source| CommandError::io(format!("could not write export file: {source}")))?;
    directory.sync()?;
    directory.verify_published(name, &file)
}

fn open_or_create(
    root: &SafeDirectory,
    components: &[String],
) -> Result<SafeDirectory, CommandError> {
    let mut current = root.try_clone()?;
    for component in components {
        current = current.open_child(component, true)?;
    }
    Ok(current)
}

fn open_existing(
    root: &SafeDirectory,
    components: &[String],
) -> Result<SafeDirectory, CommandError> {
    let mut current = root.try_clone()?;
    for component in components {
        current = current.open_child(component, false)?;
    }
    Ok(current)
}

fn sanitize_component(value: &str) -> String {
    let mut sanitized = String::new();
    for character in value.nfc() {
        if character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        {
            sanitized.push('_');
        } else {
            sanitized.push(character);
        }
    }
    finalize_component(truncate_component(
        &sanitized,
        MAX_PORTABLE_COMPONENT_BYTES,
        MAX_PORTABLE_COMPONENT_UTF16,
    ))
}

fn truncate_component(value: &str, byte_limit: usize, utf16_limit: usize) -> String {
    let mut bytes = 0;
    let mut utf16 = 0;
    value
        .chars()
        .take_while(|character| {
            bytes += character.len_utf8();
            utf16 += character.len_utf16();
            bytes <= byte_limit && utf16 <= utf16_limit
        })
        .collect()
}

fn finalize_component(mut value: String) -> String {
    while value.ends_with([' ', '.']) {
        value.pop();
    }
    if value.is_empty() || value == "." || value == ".." {
        value = "Untitled".to_owned();
    }
    if is_windows_reserved(&value) {
        value.push('_');
    }
    value
}

fn is_windows_reserved(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem.strip_prefix("COM").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        })
        || stem.strip_prefix("LPT").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        })
}

fn allocate_unique(base: &str, used: &mut HashSet<String>) -> String {
    let mut candidate = portable_with_suffix(base, "");
    let mut suffix = 2_u32;
    while !used.insert(portable_key(&candidate)) {
        candidate = portable_with_suffix(base, &format!(" ({suffix})"));
        suffix = suffix.saturating_add(1);
    }
    candidate
}

fn portable_with_suffix(base: &str, suffix: &str) -> String {
    let byte_budget = MAX_PORTABLE_COMPONENT_BYTES.saturating_sub(suffix.len());
    let utf16_budget = MAX_PORTABLE_COMPONENT_UTF16.saturating_sub(suffix.encode_utf16().count());
    let base = finalize_component(truncate_component(base, byte_budget, utf16_budget));
    finalize_component(format!("{base}{suffix}"))
}

fn portable_key(value: &str) -> String {
    value.nfkc().flat_map(char::to_lowercase).collect()
}

fn join_relative(components: &[String]) -> String {
    components.join("/")
}

fn validate_destination(data_root: &Path, destination: &Path) -> Result<PathBuf, CommandError> {
    if !destination.is_absolute()
        || destination
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(CommandError::validation(
            "export destination must be an absolute path without traversal",
        ));
    }
    reject_link_components(destination)?;
    let canonical = destination.canonicalize().map_err(|source| {
        CommandError::io(format!("could not resolve export destination: {source}"))
    })?;
    if !canonical.is_dir() {
        return Err(CommandError::validation(
            "export destination is not a directory",
        ));
    }
    let data_root = data_root.canonicalize().map_err(|source| {
        CommandError::io(format!("could not resolve application data root: {source}"))
    })?;
    if path_is_within(&canonical, &data_root) || path_is_within(&data_root, &canonical) {
        return Err(CommandError::validation(
            "export destination cannot overlap application data",
        ));
    }
    Ok(canonical)
}

fn reject_link_components(path: &Path) -> Result<(), CommandError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        let metadata = fs::symlink_metadata(&current).map_err(|source| {
            CommandError::io(format!("could not inspect export destination: {source}"))
        })?;
        #[cfg(unix)]
        let linked = metadata.file_type().is_symlink();
        #[cfg(windows)]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x0000_0400 != 0
        };
        if linked {
            return Err(CommandError::validation(
                "export destination cannot contain links or reparse points",
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn path_is_within(path: &Path, root: &Path) -> bool {
    let path = path.to_string_lossy().to_lowercase();
    let root = root.to_string_lossy().to_lowercase();
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with(['\\', '/']))
}

#[cfg(not(windows))]
fn path_is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain::{NoteDocument, NoteKind},
        storage::repository::NoteRepository,
    };

    #[test]
    fn manifest_write_failure_returns_an_incomplete_report_without_publishing_or_temp_files() {
        let sandbox = tempfile::tempdir().unwrap();
        let paths = StoragePaths::open(sandbox.path().join("data")).unwrap();
        let destination = sandbox.path().join("exports");
        fs::create_dir(&destination).unwrap();
        let note_id = NoteId::parse_str("019c0000-0000-7000-8000-000000000499").unwrap();
        NoteRepository::new(paths.clone())
            .create(NoteDocument {
                id: note_id,
                kind: NoteKind::Formal,
                title: "Good".to_owned(),
                folder_id: None,
                tags: Vec::new(),
                markdown: "body".to_owned(),
                revision: 0,
                created_at: "2026-07-30T08:00:00Z".to_owned(),
                updated_at: "2026-07-30T08:01:00Z".to_owned(),
            })
            .unwrap();

        let report = export_library_using(
            &paths,
            &destination,
            "0.1.0",
            &mut |directory, name, bytes| {
                if name == EXPORT_MANIFEST {
                    return Err(CommandError::io("injected manifest failure"));
                }
                write_owned_file(directory, name, bytes)
            },
        )
        .unwrap();

        assert!(!report.completed, "{report:?}");
        assert_eq!(report.notes_exported, 0);
        assert_eq!(report.assets_exported, 0);
        assert!(report.output_root.is_none());
        assert!(report
            .global_failure
            .as_deref()
            .is_some_and(|message| message.contains("manifest")));
        let incomplete = PathBuf::from(report.incomplete_root.expect("incomplete root"));
        assert!(incomplete.join("Good.md").exists());
        assert!(!incomplete.join(EXPORT_MANIFEST).exists());
        assert!(!destination.join("Simple Notes Export").exists());
        assert!(all_descendants(&destination).iter().all(|path| !path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".export-")
            && path.extension().is_none_or(|extension| extension != "tmp")));
    }

    #[test]
    fn recovery_required_reports_the_final_location_that_may_have_been_published() {
        let parent = Path::new("export-parent");

        assert_eq!(
            published_or_staging_path(
                parent,
                ".simple-notes-export-staging.partial",
                "Simple Notes Export",
                PublishState::RecoveryRequired,
            ),
            parent.join("Simple Notes Export")
        );
    }

    fn all_descendants(root: &Path) -> Vec<PathBuf> {
        let mut paths = Vec::new();
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                paths.extend(all_descendants(&path));
            }
            paths.push(path);
        }
        paths
    }
}
