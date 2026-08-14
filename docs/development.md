## Rust 构建缓存

`src-tauri/target` 只包含可再生成的 Rust 编译与测试产物，不包含笔记数据。可在仓库根目录运行：

`cargo clean --manifest-path src-tauri/Cargo.toml`

该命令不会删除笔记数据或源代码，但清理后的首次 Rust 编译会更慢。长期执行 debug、测试和 release 构建时，目录仍可能重新增长到数十 GiB。
