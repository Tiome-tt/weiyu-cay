use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use std::ops::Range;
use unicode_normalization::UnicodeNormalization;

/// Extracts searchable visible text without changing the durable Markdown source.
pub fn plain_text_from_markdown(markdown: &str) -> String {
    let markdown = strip_frontmatter(markdown);
    let options = Options::ENABLE_GFM
        | Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS;
    let mut visible = String::new();
    let mut previous_visible_end = 0;
    let mut block_separator = false;
    let mut suppressed_html: Option<&str> = None;
    for (event, range) in Parser::new_ext(markdown, options).into_offset_iter() {
        if let Event::Html(html) | Event::InlineHtml(html) = &event {
            update_html_suppression(&mut suppressed_html, html);
            continue;
        }
        if suppressed_html.is_some() {
            continue;
        }
        match event {
            Event::Text(text)
            | Event::Code(text)
            | Event::InlineMath(text)
            | Event::DisplayMath(text) => {
                let gap_has_whitespace = markdown[previous_visible_end..range.start]
                    .chars()
                    .any(char::is_whitespace);
                append_segment(&mut visible, &text, block_separator || gap_has_whitespace);
                previous_visible_end = range.end;
                block_separator = false;
            }
            Event::SoftBreak | Event::HardBreak => block_separator = true,
            Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::Item
                | TagEnd::CodeBlock
                | TagEnd::TableCell
                | TagEnd::TableRow,
            ) => block_separator = true,
            Event::FootnoteReference(_)
            | Event::Rule
            | Event::TaskListMarker(_)
            | Event::Start(_)
            | Event::End(_) => {}
            Event::Html(_) | Event::InlineHtml(_) => unreachable!(),
        }
    }
    visible.trim().nfkc().collect()
}

/// Returns byte ranges where application-specific link syntax is ordinary
/// CommonMark prose. Consumers can edit only these ranges without interpreting
/// code, standard links/images, metadata, or raw HTML as application syntax.
pub fn commonmark_prose_ranges(markdown: &str) -> Vec<Range<usize>> {
    let options = Options::ENABLE_GFM
        | Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS;
    let mut exclusions = Vec::new();
    let mut text_ranges = Vec::new();
    let mut html_lines = Vec::new();

    for (event, range) in Parser::new_ext(markdown, options).into_offset_iter() {
        match event {
            Event::Start(tag) => {
                let inherited = exclusions.last().copied().unwrap_or(false);
                exclusions.push(inherited || excludes_application_syntax(&tag));
            }
            Event::End(_) => {
                exclusions.pop();
            }
            Event::Text(_) if !exclusions.last().copied().unwrap_or(false) => {
                text_ranges.push(range);
            }
            Event::Html(_) | Event::InlineHtml(_) => {
                html_lines.push(expand_to_lines(markdown, range));
            }
            _ => {}
        }
    }

    merge_prose_ranges(markdown, text_ranges)
        .into_iter()
        .filter(|text| !html_lines.iter().any(|html| ranges_overlap(text, html)))
        .collect()
}

fn merge_prose_ranges(markdown: &str, ranges: Vec<Range<usize>>) -> Vec<Range<usize>> {
    let mut merged: Vec<Range<usize>> = Vec::with_capacity(ranges.len());
    for range in ranges {
        if let Some(previous) = merged.last_mut() {
            let application_escape_gap = markdown.get(previous.end..range.start) == Some("\\")
                && markdown[range.start..].starts_with(['\\', '|', '[', ']']);
            if previous.end == range.start || application_escape_gap {
                previous.end = range.end;
                continue;
            }
        }
        merged.push(range);
    }
    merged
}

fn excludes_application_syntax(tag: &Tag<'_>) -> bool {
    matches!(
        tag,
        Tag::CodeBlock(_)
            | Tag::HtmlBlock
            | Tag::Link { .. }
            | Tag::Image { .. }
            | Tag::MetadataBlock(_)
    )
}

fn expand_to_lines(markdown: &str, range: Range<usize>) -> Range<usize> {
    let start = markdown[..range.start]
        .rfind('\n')
        .map_or(0, |position| position + 1);
    let end = markdown[range.end..]
        .find('\n')
        .map_or(markdown.len(), |position| range.end + position + 1);
    start..end
}

fn ranges_overlap(left: &Range<usize>, right: &Range<usize>) -> bool {
    left.start < right.end && left.end > right.start
}

fn strip_frontmatter(markdown: &str) -> &str {
    markdown
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n").map(|(_, body)| body))
        .unwrap_or(markdown)
}

fn append_segment(output: &mut String, segment: &str, separate: bool) {
    if separate
        && !output.is_empty()
        && !output.ends_with(char::is_whitespace)
        && !segment.starts_with(char::is_whitespace)
    {
        append_space(output);
    }
    output.push_str(segment);
}

fn append_space(output: &mut String) {
    if !output.is_empty() && !output.ends_with(' ') {
        output.push(' ');
    }
}

fn update_html_suppression(suppressed: &mut Option<&str>, html: &str) {
    let lower = html.trim_start().to_ascii_lowercase();
    if let Some(tag) = *suppressed {
        if contains_html_tag(&lower, &format!("</{tag}")) {
            *suppressed = None;
        }
        return;
    }
    for tag in ["script", "style"] {
        if starts_with_html_tag(&lower, &format!("<{tag}"))
            && !lower.trim_end().ends_with("/>")
            && !contains_html_tag(&lower, &format!("</{tag}"))
        {
            *suppressed = Some(tag);
            return;
        }
    }
}

fn starts_with_html_tag(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|rest| html_tag_boundary(rest.chars().next()))
}

fn contains_html_tag(value: &str, prefix: &str) -> bool {
    value
        .match_indices(prefix)
        .any(|(index, _)| html_tag_boundary(value[index + prefix.len()..].chars().next()))
}

fn html_tag_boundary(next: Option<char>) -> bool {
    next.is_none_or(|character| {
        character == '>' || character == '/' || character.is_ascii_whitespace()
    })
}
