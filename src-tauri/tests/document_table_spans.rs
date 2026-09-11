use serde_json::json;
use simple_notes_lib::{domain::RichDocument, storage::rich_document::validate};

#[test]
fn a_row_fully_covered_by_an_earlier_rowspan_can_be_empty() {
    let document: RichDocument = serde_json::from_value(json!({
        "schemaVersion": 1,
        "root": { "type": "doc", "content": [{
            "type": "table", "content": [
                { "type": "tableRow", "content": [{
                    "type": "tableCell", "attrs": {"rowspan": 2, "colspan": 2},
                    "content": [{"type": "paragraph"}]
                }]},
                { "type": "tableRow" }
            ]
        }]}
    }))
    .unwrap();
    assert!(validate(&document).is_ok());
    let mut uncovered = document;
    uncovered.root.content.as_mut().unwrap()[0]
        .content
        .as_mut()
        .unwrap()[0]
        .content
        .as_mut()
        .unwrap()[0]
        .attrs
        .as_mut()
        .unwrap()
        .insert("rowspan".into(), json!(1));
    assert!(validate(&uncovered).is_err());
}
