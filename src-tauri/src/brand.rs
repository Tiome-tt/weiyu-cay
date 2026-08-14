pub const APP_NAME: &str = "微屿";

#[cfg(test)]
mod tests {
    #[test]
    fn native_brand_uses_the_approved_primary_name() {
        assert_eq!(super::APP_NAME, "微屿");
    }
}
