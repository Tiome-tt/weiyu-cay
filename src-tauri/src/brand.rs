pub const ENGLISH_BUILD: bool = cfg!(cay_english);
pub const fn text(chinese: &'static str, english: &'static str) -> &'static str {
    if ENGLISH_BUILD {
        english
    } else {
        chinese
    }
}
pub const APP_NAME: &str = text("微屿", "Cay");
pub const EXPORT_ROOT_NAME: &str = text("微屿导出", "Cay export");
#[cfg(test)]
mod tests {
    #[test]
    fn native_brand_uses_the_approved_primary_name() {
        assert_eq!(
            super::APP_NAME,
            if super::ENGLISH_BUILD {
                "Cay"
            } else {
                "微屿"
            }
        );
        assert_eq!(
            super::text("中文", "English"),
            if super::ENGLISH_BUILD {
                "English"
            } else {
                "中文"
            }
        );
    }
}
