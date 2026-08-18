fn main() {
    // Build metadata is intentionally self-contained. Product credentials are
    // runtime-owned and this build script never reads the repository `.env`.
    tauri_build::build();
}
