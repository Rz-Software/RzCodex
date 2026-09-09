use std::env;
use std::fs;
use std::path::PathBuf;

const SETUP_BIN: &str = "codex-windows-sandbox-setup";
const SETUP_MANIFEST: &str = "codex-windows-sandbox-setup.manifest";

fn main() -> Result<(), String> {
    println!("cargo:rerun-if-changed={SETUP_MANIFEST}");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return Ok(());
    }

    let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")
        .ok_or_else(|| "CARGO_MANIFEST_DIR should be set for build scripts".to_string())?;
    let out_dir = env::var_os("OUT_DIR")
        .ok_or_else(|| "OUT_DIR should be set for build scripts".to_string())?;

    // A shared CARGO_TARGET_DIR replays cached rustc-link-arg-bin output even
    // after the originating checkout is deleted, so the /MANIFESTINPUT path
    // must point into the target dir. Materialize the manifest under OUT_DIR;
    // a source-tree path would dangle once that checkout is removed.
    let source_manifest = PathBuf::from(manifest_dir).join(SETUP_MANIFEST);
    let embedded_manifest = PathBuf::from(out_dir).join(SETUP_MANIFEST);
    fs::copy(&source_manifest, &embedded_manifest).map_err(|error| {
        format!(
            "failed to copy {} to {}: {error}",
            source_manifest.display(),
            embedded_manifest.display()
        )
    })?;
    let manifest_path = embedded_manifest.display();

    // Keep this scoped to the setup helper so Codex binaries that link the
    // library do not inherit any resource metadata from this package.
    match (
        env::var("CARGO_CFG_TARGET_ENV").as_deref(),
        env::var("CARGO_CFG_TARGET_ABI").as_deref(),
    ) {
        (Ok("msvc"), _) => {
            println!("cargo:rustc-link-arg-bin={SETUP_BIN}=/MANIFEST:EMBED");
            println!("cargo:rustc-link-arg-bin={SETUP_BIN}=/MANIFESTINPUT:{manifest_path}");
        }
        (Ok("gnu"), Ok("llvm")) => {
            println!("cargo:rustc-link-arg-bin={SETUP_BIN}=-Wl,-Xlink=/manifest:embed");
            println!(
                "cargo:rustc-link-arg-bin={SETUP_BIN}=-Wl,-Xlink=/manifestinput:{manifest_path}"
            );
        }
        _ => {}
    }

    Ok(())
}
