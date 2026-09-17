use crate::{
    domain::{NoteContent, NoteDocument, NoteId, RichDocument, RichNode},
    error::CommandError,
};
use serde_json::{Map, Value};

fn invalid() -> CommandError {
    CommandError::validation("unsupported or invalid document structure")
}
fn attrs_allowed(attrs: &Option<Map<String, Value>>, names: &[&str]) -> Result<(), CommandError> {
    if attrs
        .as_ref()
        .is_some_and(|attrs| attrs.keys().any(|key| !names.contains(&key.as_str())))
    {
        return Err(invalid());
    }
    Ok(())
}
fn attr<'a>(node: &'a RichNode, name: &str) -> Option<&'a Value> {
    node.attrs.as_ref()?.get(name).filter(|v| !v.is_null())
}
fn integer(node: &RichNode, name: &str, default: u64, max: u64) -> Result<u64, CommandError> {
    match attr(node, name) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|v| *v > 0 && *v <= max)
            .ok_or_else(invalid),
    }
}
fn safe_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "https" | "http" | "mailto"))
}
fn safe_font_size(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    if matches!(value, "small" | "normal" | "large" | "xlarge") {
        return true;
    }
    value
        .parse::<u16>()
        .is_ok_and(|points| (8..=96).contains(&points))
}
fn safe_asset(value: &str) -> bool {
    value.strip_prefix("assets/").is_some_and(|v| {
        !v.is_empty()
            && !v.contains(['/', '\\', ':'])
            && v != "."
            && v != ".."
            && !v.chars().any(char::is_control)
    })
}
pub fn validate(document: &RichDocument) -> Result<(), CommandError> {
    if document.schema_version != 1 || document.root.node_type != "doc" {
        return Err(invalid());
    }
    let mut budget = 100_000;
    validate_node(&document.root, "", 0, false, &mut budget)
}
fn validate_node(
    node: &RichNode,
    parent: &str,
    depth: usize,
    in_table: bool,
    budget: &mut usize,
) -> Result<(), CommandError> {
    if depth > 64 || *budget == 0 {
        return Err(invalid());
    }
    *budget -= 1;
    let kind = node.node_type.as_str();
    let children = node.content.as_deref().unwrap_or_default();
    let allowed: &[&str] = match kind {
        "doc" if parent.is_empty() => &[],
        "paragraph" => &["textAlign"],
        "heading" => &["level", "textAlign"],
        "text" => &[],
        "blockquote" | "bulletList" | "listItem" | "taskList" | "horizontalRule" | "hardBreak"
        | "table" | "tableRow" => &[],
        "orderedList" => &["start"],
        "taskItem" => &["checked"],
        "codeBlock" => &["language"],
        "image" => &["src", "alt", "title", "width"],
        "tableCell" | "tableHeader" => &[
            "colspan",
            "rowspan",
            "colwidth",
            "backgroundColor",
            "textAlign",
        ],
        "internalLink" => &["noteId", "label"],
        "attachment" => &["entryId", "label", "fileName", "mediaType"],
        "rawMarkdown" => &["source"],
        "math" | "mathBlock" => &["latex"],
        _ => return Err(invalid()),
    };
    attrs_allowed(&node.attrs, allowed)?;
    let inline = matches!(kind, "text" | "hardBreak" | "internalLink" | "math");
    let valid_parent = match parent {
        "" => kind == "doc",
        "paragraph" | "heading" => inline,
        "codeBlock" => kind == "text",
        "table" => kind == "tableRow",
        "tableRow" => matches!(kind, "tableCell" | "tableHeader"),
        "bulletList" | "orderedList" => kind == "listItem",
        "taskList" => kind == "taskItem",
        "doc" | "blockquote" | "listItem" | "taskItem" | "tableCell" | "tableHeader" => {
            !inline
                && !matches!(
                    kind,
                    "doc" | "tableRow" | "tableCell" | "tableHeader" | "listItem" | "taskItem"
                )
        }
        _ => false,
    };
    if !valid_parent {
        return Err(invalid());
    }
    if kind == "text" {
        if node.text.as_ref().is_none_or(|t| t.is_empty()) || !children.is_empty() {
            return Err(invalid());
        }
    } else if node.text.is_some() {
        return Err(invalid());
    }
    if matches!(
        kind,
        "horizontalRule"
            | "hardBreak"
            | "image"
            | "internalLink"
            | "attachment"
            | "rawMarkdown"
            | "math"
            | "mathBlock"
    ) && !children.is_empty()
    {
        return Err(invalid());
    }
    if matches!(
        kind,
        "doc"
            | "blockquote"
            | "listItem"
            | "taskItem"
            | "tableCell"
            | "tableHeader"
            | "table"
            | "bulletList"
            | "orderedList"
            | "taskList"
    ) && children.is_empty()
    {
        return Err(invalid());
    }
    if kind == "heading" {
        integer(node, "level", 1, 6)?;
    }
    if kind == "orderedList" {
        integer(node, "start", 1, 1_000_000)?;
    }
    if attr(node, "textAlign")
        .is_some_and(|v| !matches!(v.as_str(), Some("left" | "center" | "right" | "justify")))
    {
        return Err(invalid());
    }
    if attr(node, "backgroundColor").is_some_and(|v| {
        !matches!(
            v.as_str(),
            Some("default" | "green" | "yellow" | "blue" | "pink" | "purple" | "gray")
        )
    }) {
        return Err(invalid());
    }
    if kind == "taskItem" && attr(node, "checked").is_some_and(|v| !v.is_boolean()) {
        return Err(invalid());
    }
    if kind == "image" {
        if let Some(width) = attr(node, "width") {
            if !width
                .as_u64()
                .is_some_and(|value| (120..=4096).contains(&value))
            {
                return Err(invalid());
            }
        }
    }
    if kind == "image"
        && !attr(node, "src")
            .and_then(Value::as_str)
            .is_some_and(safe_asset)
    {
        return Err(invalid());
    }
    if matches!(kind, "internalLink" | "attachment") {
        let key = if kind == "internalLink" {
            "noteId"
        } else {
            "entryId"
        };
        if !attr(node, key)
            .and_then(Value::as_str)
            .is_some_and(|s| NoteId::parse_str(s).is_ok())
            || attr(node, "label").and_then(Value::as_str).is_none()
        {
            return Err(invalid());
        }
    }
    if kind == "rawMarkdown" && attr(node, "source").and_then(Value::as_str).is_none() {
        return Err(invalid());
    }
    if matches!(kind, "math" | "mathBlock")
        && !attr(node, "latex")
            .and_then(Value::as_str)
            .is_some_and(|latex| !latex.trim().is_empty() && latex.len() <= 16_384)
    {
        return Err(invalid());
    }
    if let Some(attrs) = &node.attrs {
        for (key, value) in attrs {
            if !matches!(
                key.as_str(),
                "level" | "start" | "checked" | "rowspan" | "colspan" | "colwidth" | "width"
            ) && !value.is_null()
                && !value.is_string()
            {
                return Err(invalid());
            }
        }
    }
    if let Some(marks) = &node.marks {
        if !inline || marks.len() > 8 {
            return Err(invalid());
        }
        let mut seen = std::collections::HashSet::new();
        for mark in marks {
            if !seen.insert(&mark.mark_type) {
                return Err(invalid());
            }
            let attrs = match mark.mark_type.as_str() {
                "bold" | "italic" | "strike" | "underline" | "code" | "subscript"
                | "superscript" => &[][..],
                "font" => &["family", "size"][..],
                "highlight" => &["color"][..],
                "link" => &["href", "target", "rel"][..],
                _ => return Err(invalid()),
            };
            attrs_allowed(&mark.attrs, attrs)?;
            if let Some(attrs) = &mark.attrs {
                if attrs.values().any(|v| !v.is_null() && !v.is_string()) {
                    return Err(invalid());
                }
            }
            if mark.mark_type == "font" {
                if mark
                    .attrs
                    .as_ref()
                    .and_then(|attrs| attrs.get("family"))
                    .is_some_and(|value| {
                        !matches!(value.as_str(), Some("body" | "sans" | "serif" | "mono"))
                    })
                {
                    return Err(invalid());
                }
                if mark
                    .attrs
                    .as_ref()
                    .and_then(|attrs| attrs.get("size"))
                    .is_some_and(|value| !safe_font_size(value))
                {
                    return Err(invalid());
                }
            }
            if mark.mark_type == "link"
                && !mark
                    .attrs
                    .as_ref()
                    .and_then(|a| a.get("href"))
                    .and_then(Value::as_str)
                    .is_some_and(safe_url)
            {
                return Err(invalid());
            }
        }
    }
    if kind == "table" {
        if in_table {
            return Err(invalid());
        }
        validate_table(node)?;
    }
    for child in children {
        validate_node(child, kind, depth + 1, in_table || kind == "table", budget)?;
    }
    Ok(())
}
fn validate_table(table: &RichNode) -> Result<(), CommandError> {
    let rows = table.content.as_deref().unwrap_or_default();
    if rows.is_empty() || rows.len() > 1000 {
        return Err(invalid());
    }
    let mut grid = vec![vec![false; 256]; rows.len()];
    let mut width = 0;
    for (r, row) in rows.iter().enumerate() {
        let mut col = 0;
        for cell in row.content.as_deref().unwrap_or_default() {
            while col < 256 && grid[r][col] {
                col += 1;
            }
            let colspan = integer(cell, "colspan", 1, 256)? as usize;
            let rowspan = integer(cell, "rowspan", 1, 1000)? as usize;
            if col + colspan > 256 || r + rowspan > rows.len() {
                return Err(invalid());
            }
            if let Some(widths) = attr(cell, "colwidth") {
                let widths = widths.as_array().ok_or_else(invalid)?;
                if widths.len() != colspan
                    || widths
                        .iter()
                        .any(|v| !v.as_u64().is_some_and(|v| v <= 4096))
                {
                    return Err(invalid());
                }
            }
            for line in grid.iter_mut().skip(r).take(rowspan) {
                for occupied in line.iter_mut().skip(col).take(colspan) {
                    if *occupied {
                        return Err(invalid());
                    }
                    *occupied = true;
                }
            }
            col += colspan;
            width = width.max(col);
        }
    }
    if width == 0 || grid.iter().any(|row| row[..width].iter().any(|v| !*v)) {
        return Err(invalid());
    }
    Ok(())
}
pub fn plain_text(note: &NoteDocument) -> String {
    match &note.content {
        None => super::markdown::plain_text_from_markdown(&note.markdown),
        Some(NoteContent::Text { text }) => text.clone(),
        Some(NoteContent::File { file }) => file.original_name.clone(),
        Some(NoteContent::Document { document }) => {
            let mut text = String::new();
            walk_text(&document.root, &mut text);
            text.trim().to_owned()
        }
    }
}
fn walk_text(node: &RichNode, out: &mut String) {
    if node.node_type == "hardBreak" {
        out.push('\n');
        return;
    }
    if let Some(text) = &node.text {
        out.push_str(text);
    }
    if let Some(text) = attr(node, "label")
        .or_else(|| attr(node, "source"))
        .or_else(|| attr(node, "latex"))
        .and_then(Value::as_str)
    {
        out.push_str(text);
    }
    for child in node.content.as_deref().unwrap_or_default() {
        walk_text(child, out);
    }
    if matches!(
        node.node_type.as_str(),
        "paragraph"
            | "heading"
            | "codeBlock"
            | "tableRow"
            | "tableCell"
            | "tableHeader"
            | "rawMarkdown"
            | "mathBlock"
            | "attachment"
    ) && !out.ends_with('\n')
    {
        out.push('\n');
    }
}
pub(crate) fn links(note: &NoteDocument) -> Vec<super::repository::ParsedLink> {
    match &note.content {
        None => super::repository::parse_links(&note.markdown),
        Some(NoteContent::Document { document }) => {
            let mut result = Vec::new();
            walk_links(&document.root, &mut result);
            result
        }
        _ => Vec::new(),
    }
}
fn walk_links(node: &RichNode, out: &mut Vec<super::repository::ParsedLink>) {
    if matches!(node.node_type.as_str(), "internalLink" | "attachment") {
        let key = if node.node_type == "internalLink" {
            "noteId"
        } else {
            "entryId"
        };
        if let Some(target) = attr(node, key)
            .and_then(Value::as_str)
            .and_then(|s| NoteId::parse_str(s).ok())
        {
            out.push(super::repository::ParsedLink {
                target,
                label: attr(node, "label")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                start: out.len(),
                end: out.len() + 1,
            });
        }
    }
    for child in node.content.as_deref().unwrap_or_default() {
        walk_links(child, out);
    }
}
pub(crate) fn rewrite_labels(node: &mut RichNode, target: NoteId, title: &str) -> bool {
    let mut changed = false;
    if matches!(node.node_type.as_str(), "internalLink" | "attachment") {
        let key = if node.node_type == "internalLink" {
            "noteId"
        } else {
            "entryId"
        };
        if attr(node, key).and_then(Value::as_str) == Some(target.to_string().as_str())
            && attr(node, "label").and_then(Value::as_str) != Some(title)
        {
            node.attrs
                .get_or_insert_default()
                .insert("label".into(), Value::String(title.into()));
            changed = true;
        }
    }
    for child in node.content.as_mut().into_iter().flatten() {
        changed |= rewrite_labels(child, target, title);
    }
    changed
}
