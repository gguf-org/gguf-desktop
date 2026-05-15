fn main() {
    // Expose the full target triple so lib.rs can find the triple-suffixed binary name
    let target = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rustc-env=TARGET_TRIPLE={target}");
    tauri_build::build()
}
