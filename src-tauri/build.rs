fn main() {
    // Windows `cargo test` 产物（含 lib 单测）没有 tauri 为应用二进制内嵌的
    // manifest；依赖链（对话框/窗口栈）里的 comctl32 6.0-only 导入
    // （TaskDialogIndirect、SetWindowSubclass 等）在无 manifest 时按系统
    // 5.82 版绑定，测试进程在 main 之前即以 STATUS_ENTRYPOINT_NOT_FOUND
    // 退出。cargo 没有「仅 lib 单测」的链接参数通道（rustc-link-arg-tests
    // 只覆盖 tests/ 下的集成测试目标），因此对所有链接产物声明 Common-
    // Controls v6 SxS 依赖；应用二进制由 tauri 内嵌的完整 manifest 提供同
    // 一依赖，两者口径一致不冲突。
    if cfg!(windows) {
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
             name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
             publicKeyToken='6595b64144ccf1df' language='*' \
             processorArchitecture='*'"
        );
    }

    // Build metadata is intentionally self-contained. Product credentials are
    // runtime-owned and this build script never reads the repository `.env`.
    tauri_build::build();
}
