//! Windows 链接回归（STATUS_ENTRYPOINT_NOT_FOUND，2026-08-26）：
//!
//! `cargo test` 产物没有 tauri 为应用二进制内嵌的 manifest，依赖链里的
//! comctl32 6.0-only 导入（TaskDialogIndirect 等）会按系统 5.82 版绑定，
//! 测试进程在 main 之前就以入口点缺失退出——build.rs 因此用
//! `cargo:rustc-link-arg=/MANIFESTDEPENDENCY:...` 对所有链接产物声明
//! Common-Controls v6 依赖（`rustc-link-arg-tests` 只覆盖 tests/ 下的
//! 显式集成测试目标，罩不住 lib 单测）；下面的用例在运行时断言
//! 6.0 绑定确实可用。

#![cfg(windows)]

use windows_sys::Win32::Foundation::HMODULE;
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};

#[test]
fn common_controls_v6_symbols_resolve() {
    // LoadLibraryA 解析到哪个版本由本测试 exe 内嵌的 manifest 决定：
    // 带 Common-Controls v6 依赖 → 6.0（符号存在）；缺失 → 系统 5.82。
    let comctl32: HMODULE = unsafe { LoadLibraryA(c"comctl32.dll".as_ptr().cast()) };
    assert!(!comctl32.is_null(), "comctl32.dll failed to load");
    let proc = |name: &std::ffi::CStr| unsafe { GetProcAddress(comctl32, name.as_ptr().cast()) }.is_some();
    // 这两个符号只存在于 Common-Controls 6.0 程序集；缺 manifest 时拿到
    // 5.82 版则解析失败。
    assert!(
        proc(c"TaskDialogIndirect"),
        "TaskDialogIndirect missing: comctl32 resolved to the 5.82 assembly \
         (test binaries must embed the Common-Controls v6 manifest dependency)"
    );
    assert!(proc(c"SetWindowSubclass"));
}
