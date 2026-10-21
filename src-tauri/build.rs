fn main() {
    println!("cargo:rerun-if-changed=../.env");
    dotenvy::from_path("../.env").ok();
    for name in ["AGNES_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] {
        println!("cargo:rerun-if-env-changed={name}");
        let value = std::env::var(name).unwrap_or_default();
        println!("cargo:rustc-env={name}={}", value.trim());
    }
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
