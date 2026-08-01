use pulldown_cmark::{Event, Options, Parser, TagEnd};
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
        if lower.contains(&format!("</{tag}")) {
            *suppressed = None;
        }
        return;
    }
    for tag in ["script", "style"] {
        if lower.starts_with(&format!("<{tag}")) && !lower.contains(&format!("</{tag}")) {
            *suppressed = Some(tag);
            return;
        }
    }
}
