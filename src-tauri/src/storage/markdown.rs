use pulldown_cmark::{Event, Parser, TagEnd};

/// Extracts searchable visible text without changing the durable Markdown source.
pub fn plain_text_from_markdown(markdown: &str) -> String {
    let markdown = strip_frontmatter(markdown);
    let mut visible = String::new();
    for event in Parser::new(markdown) {
        match event {
            Event::Text(text)
            | Event::Code(text)
            | Event::InlineMath(text)
            | Event::DisplayMath(text) => append_segment(&mut visible, &text),
            Event::SoftBreak | Event::HardBreak => append_space(&mut visible),
            Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::Item
                | TagEnd::CodeBlock
                | TagEnd::TableCell
                | TagEnd::TableRow,
            ) => append_space(&mut visible),
            Event::Html(_)
            | Event::InlineHtml(_)
            | Event::FootnoteReference(_)
            | Event::Rule
            | Event::TaskListMarker(_)
            | Event::Start(_)
            | Event::End(_) => {}
        }
    }
    visible.trim().to_owned()
}

fn strip_frontmatter(markdown: &str) -> &str {
    markdown
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n").map(|(_, body)| body))
        .unwrap_or(markdown)
}

fn append_segment(output: &mut String, segment: &str) {
    for part in segment.split_whitespace() {
        append_space(output);
        output.push_str(part);
    }
}

fn append_space(output: &mut String) {
    if !output.is_empty() && !output.ends_with(' ') {
        output.push(' ');
    }
}
