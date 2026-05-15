use std::fs::OpenOptions;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_PORT: u16 = 8888;
const DEFAULT_HOST: &str = "127.0.0.1";
const HEALTH_POLL_MS: u64 = 500;
const HEALTH_TIMEOUT_S: u64 = 120;

// Injected by build.rs — e.g. "x86_64-pc-windows-msvc" or "aarch64-apple-darwin"
const TARGET_TRIPLE: &str = env!("TARGET_TRIPLE");

struct AppState {
    llama_child: Arc<Mutex<Option<ManagedChild>>>,
    // Incremented each time start_llama_server is called so stale health-check
    // threads from previous runs know to exit without interfering.
    epoch: Arc<AtomicU64>,
    current_host: Arc<Mutex<String>>,
    current_port: Arc<Mutex<u16>>,
}

struct ManagedChild {
    process: Child,
    log_path: PathBuf,
}

// ── Platform helpers ────────────────────────────────────────────────────────

#[cfg(windows)]
fn suppress_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_console(_: &mut Command) {}

fn binary_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{}.exe", stem)
    } else {
        stem.to_string()
    }
}

fn candidate_binary_names() -> Vec<String> {
    let plain = binary_name("llama-server");
    let with_triple = binary_name(&format!("llama-server-{TARGET_TRIPLE}"));
    if with_triple == plain {
        vec![plain]
    } else {
        vec![plain, with_triple]
    }
}

// ── Path resolution ─────────────────────────────────────────────────────────

/// Finds the llama-server binary. Search order:
/// 1. resource_dir (production bundle)
/// 2. Same directory as the running exe
/// 3. Walk up the directory tree, checking binaries/ at each level
///    and also sibling project src-tauri/binaries/ dirs (monorepo dev mode)
fn resolve_llama_server(app: &AppHandle) -> Option<PathBuf> {
    let names = candidate_binary_names();

    // 1. resource_dir — production bundles
    if let Ok(dir) = app.path().resource_dir() {
        for name in &names {
            let c = dir.join(name);
            if c.exists() {
                return Some(c);
            }
        }
    }

    // 2. Same directory as the running exe
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in &names {
                let c = dir.join(name);
                if c.exists() {
                    return Some(c);
                }
            }
        }
    }

    // 3. Walk up from the exe, checking binaries/ and sibling project dirs
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..10 {
            if let Some(d) = dir {
                // Check direct binaries/ subdir at this level
                for name in &names {
                    let c = d.join("binaries").join(name);
                    if c.exists() {
                        return Some(c);
                    }
                }
                // Check sibling projects' src-tauri/binaries/ (monorepo layout)
                if let Ok(entries) = std::fs::read_dir(&d) {
                    for entry in entries.flatten() {
                        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            for name in &names {
                                let c = entry
                                    .path()
                                    .join("src-tauri")
                                    .join("binaries")
                                    .join(name);
                                if c.exists() {
                                    return Some(c);
                                }
                            }
                        }
                    }
                }
                dir = d.parent().map(Path::to_path_buf);
            } else {
                break;
            }
        }
    }

    None
}

// ── Server lifecycle ────────────────────────────────────────────────────────

fn kill_existing(child_state: &Arc<Mutex<Option<ManagedChild>>>) {
    if let Ok(mut guard) = child_state.lock() {
        if let Some(mut child) = guard.take() {
            child.process.kill().ok();
            child.process.wait().ok();
        }
    }
}

fn wait_for_port_free(host: &str, port: u16) {
    let addr = format!("{}:{}", host, port);
    for _ in 0..60 {
        if TcpStream::connect(&addr).is_err() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

struct ServerArgs {
    model_path: String,
    mmproj_path: Option<String>,
    host: String,
    port: u16,
    context_length: u32,
    gpu_layers: u32,
    cpu_threads: Option<u32>,
    n_parallel: Option<u32>,
    batch_size: Option<u32>,
    ubatch_size: Option<u32>,
    api_key: Option<String>,
    model_alias: Option<String>,
    flash_attn: bool,
    cache_type_k: Option<String>,
    cache_type_v: Option<String>,
    cont_batching: bool,
    mlock: bool,
    no_mmap: bool,
    chat_template: Option<String>,
    chat_template_file: Option<String>,
}

fn ensure_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(path).map_err(|e| format!("Failed to read binary metadata: {e}"))?;
        let mode = meta.permissions().mode();
        if mode & 0o111 == 0 {
            let mut perms = meta.permissions();
            perms.set_mode(mode | 0o111);
            std::fs::set_permissions(path, perms)
                .map_err(|e| format!("Failed to set executable bit on llama-server: {e}"))?;
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn spawn_llama_server(binary: &Path, args: &ServerArgs, dylib_dir: Option<PathBuf>) -> Result<ManagedChild, String> {
    ensure_executable(binary)?;

    let log_path = std::env::temp_dir().join(format!(
        "gguf-desktop-{}.log",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));

    let log_stdout = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to create log file: {e}"))?;
    let log_stderr = log_stdout
        .try_clone()
        .map_err(|e| format!("Failed to clone log handle: {e}"))?;

    let mut cmd = Command::new(binary);

    cmd.args(["--model", &args.model_path])
        .args(["--host", &args.host])
        .args(["--port", &args.port.to_string()])
        .args(["--ctx-size", &args.context_length.to_string()])
        .args(["--n-gpu-layers", &args.gpu_layers.to_string()]);

    if let Some(mmproj) = &args.mmproj_path {
        if !mmproj.is_empty() {
            cmd.args(["--mmproj", mmproj]);
        }
    }

    if let Some(threads) = args.cpu_threads {
        cmd.args(["--threads", &threads.to_string()]);
    }

    if let Some(parallel) = args.n_parallel {
        if parallel > 1 {
            cmd.args(["--parallel", &parallel.to_string()]);
        }
    }

    if let Some(batch) = args.batch_size {
        cmd.args(["--batch-size", &batch.to_string()]);
    }

    if let Some(ubatch) = args.ubatch_size {
        cmd.args(["--ubatch-size", &ubatch.to_string()]);
    }

    if let Some(key) = &args.api_key {
        if !key.is_empty() {
            cmd.args(["--api-key", key]);
        }
    }

    if let Some(alias) = &args.model_alias {
        if !alias.is_empty() {
            cmd.args(["--alias", alias]);
        }
    }

    if args.flash_attn {
        cmd.arg("--flash-attn");
    }

    if let Some(kt) = &args.cache_type_k {
        if !kt.is_empty() && kt != "f16" {
            cmd.args(["--cache-type-k", kt]);
        }
    }

    if let Some(vt) = &args.cache_type_v {
        if !vt.is_empty() && vt != "f16" {
            cmd.args(["--cache-type-v", vt]);
        }
    }

    if args.cont_batching {
        cmd.arg("--cont-batching");
    }

    if args.mlock {
        cmd.arg("--mlock");
    }

    if args.no_mmap {
        cmd.arg("--no-mmap");
    }

    if let Some(tmpl) = &args.chat_template {
        if !tmpl.is_empty() {
            cmd.args(["--chat-template", tmpl]);
        }
    }

    if let Some(tmpl_file) = &args.chat_template_file {
        if !tmpl_file.is_empty() && Path::new(tmpl_file).exists() {
            cmd.args(["--chat-template-file", tmpl_file]);
        }
    }

    // Hide CUDA devices when user explicitly chose CPU-only (not applicable on macOS/Metal)
    #[cfg(not(target_os = "macos"))]
    if args.gpu_layers == 0 {
        cmd.env("CUDA_VISIBLE_DEVICES", "-1");
    }

    // Set working dir to binary's parent so sibling libraries are found
    if let Some(parent) = binary.parent() {
        cmd.current_dir(parent);
    }

    // On macOS, add dylib search paths so the bundled .dylib files are found
    #[cfg(target_os = "macos")]
    {
        let mut search_paths: Vec<PathBuf> = Vec::new();
        if let Some(parent) = binary.parent() {
            search_paths.push(parent.to_path_buf());
        }
        if let Some(d) = dylib_dir {
            search_paths.push(d);
        }
        if !search_paths.is_empty() {
            let joined = search_paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(":");
            cmd.env("DYLD_LIBRARY_PATH", &joined);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = dylib_dir;

    cmd.stdout(Stdio::from(log_stdout))
        .stderr(Stdio::from(log_stderr))
        .stdin(Stdio::null());

    suppress_console(&mut cmd);

    let process = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn llama-server: {e}"))?;
    Ok(ManagedChild { process, log_path })
}

fn summarize_output(output: &str) -> Option<String> {
    let s = output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    if s.is_empty() {
        None
    } else if s.chars().count() > 900 {
        Some(format!("{}...", s.chars().take(900).collect::<String>()))
    } else {
        Some(s)
    }
}

fn read_log(log_path: &Path) -> String {
    std::fs::read_to_string(log_path).unwrap_or_default()
}

/// Poll the TCP port until the server is ready, the process exits early, or we
/// time out. `my_epoch` lets the thread self-terminate when a newer run starts.
fn wait_for_server(
    app: &AppHandle,
    model_id: String,
    host: String,
    port: u16,
    child_state: Arc<Mutex<Option<ManagedChild>>>,
    epoch_state: Arc<AtomicU64>,
    my_epoch: u64,
) {
    let addr = format!("{}:{}", host, port);
    let max_iters = (HEALTH_TIMEOUT_S * 1000) / HEALTH_POLL_MS;
    let app = app.clone();

    std::thread::spawn(move || {
        for _ in 0..max_iters {
            if epoch_state.load(Ordering::Relaxed) != my_epoch {
                return;
            }

            // Check for early process exit
            let exit_err: Option<String> = if let Ok(mut guard) = child_state.lock() {
                if let Some(child) = guard.as_mut() {
                    match child.process.try_wait() {
                        Ok(Some(status)) => {
                            let output = read_log(&child.log_path);
                            let log_path = child.log_path.display().to_string();
                            *guard = None;
                            let hint = "Check: GPU Layers (try 0 for CPU-only), \
                                        model file path, or that all dylibs are present.";
                            let detail = summarize_output(&output)
                                .map(|m| format!(" llama-server: {m}"))
                                .unwrap_or_else(|| format!(" See log: {log_path}"));
                            Some(if status.success() {
                                format!("llama-server exited before binding port {port}. {hint}")
                            } else {
                                format!("llama-server exited ({status}).{detail} {hint}")
                            })
                        }
                        _ => None,
                    }
                } else {
                    None
                }
            } else {
                None
            };

            if let Some(error) = exit_err {
                if epoch_state.load(Ordering::Relaxed) == my_epoch {
                    let _ = app.emit("llm-server-ready", serde_json::json!({ "error": error }));
                }
                return;
            }

            // Check TCP port
            if TcpStream::connect(&addr).is_ok() {
                if epoch_state.load(Ordering::Relaxed) == my_epoch {
                    let _ = app.emit(
                        "llm-server-ready",
                        serde_json::json!({
                            "running": true,
                            "url": format!("http://{}:{}/v1", host, port),
                            "modelId": model_id,
                            "port": port,
                            "host": host,
                        }),
                    );
                }
                return;
            }

            std::thread::sleep(Duration::from_millis(HEALTH_POLL_MS));
        }

        if epoch_state.load(Ordering::Relaxed) == my_epoch {
            let _ = app.emit(
                "llm-server-ready",
                serde_json::json!({
                    "error": format!(
                        "llama-server did not start within {}s on {}:{}. \
                         The model may be too large for available memory.",
                        HEALTH_TIMEOUT_S, host, port
                    )
                }),
            );
        }
    });
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct StartResult {
    starting: bool,
    port: u16,
    host: String,
}

#[tauri::command]
fn start_llama_server(
    app: AppHandle,
    state: tauri::State<AppState>,
    model_path: String,
    mmproj_path: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    context_length: Option<u32>,
    gpu_layers: Option<u32>,
    cpu_threads: Option<u32>,
    n_parallel: Option<u32>,
    batch_size: Option<u32>,
    ubatch_size: Option<u32>,
    api_key: Option<String>,
    model_alias: Option<String>,
    flash_attn: Option<bool>,
    cache_type_k: Option<String>,
    cache_type_v: Option<String>,
    cont_batching: Option<bool>,
    mlock: Option<bool>,
    no_mmap: Option<bool>,
    chat_template: Option<String>,
    chat_template_file: Option<String>,
) -> Result<StartResult, String> {
    // Bump epoch first so any running health-check thread stops immediately
    let my_epoch = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;

    kill_existing(&state.llama_child);

    let host_val = host.filter(|h| !h.is_empty()).unwrap_or_else(|| DEFAULT_HOST.to_string());
    let port_val = port.unwrap_or(DEFAULT_PORT);

    wait_for_port_free(&host_val, port_val);

    let binary = resolve_llama_server(&app).ok_or_else(|| {
        format!(
            "llama-server binary not found. \
             Looked for 'llama-server' and 'llama-server-{TARGET_TRIPLE}' \
             in the app directory and src-tauri/binaries/. \
             Copy the llama-server binary to src-tauri/binaries/."
        )
    })?;

    let model = PathBuf::from(&model_path);
    if !model.exists() {
        return Err(format!("Model file not found: {model_path}"));
    }
    if let Some(mmproj) = &mmproj_path {
        if !mmproj.is_empty() && !Path::new(mmproj).exists() {
            return Err(format!("mmproj file not found: {mmproj}"));
        }
    }

    let model_id = model_alias
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| {
            model
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "model".to_string())
        });

    let args = ServerArgs {
        model_path,
        mmproj_path,
        host: host_val.clone(),
        port: port_val,
        context_length: context_length.unwrap_or(4096).clamp(512, 131072),
        gpu_layers: gpu_layers.unwrap_or(0).min(999),
        cpu_threads,
        n_parallel,
        batch_size,
        ubatch_size,
        api_key,
        model_alias,
        flash_attn: flash_attn.unwrap_or(false),
        cache_type_k,
        cache_type_v,
        cont_batching: cont_batching.unwrap_or(true),
        mlock: mlock.unwrap_or(false),
        no_mmap: no_mmap.unwrap_or(false),
        chat_template,
        chat_template_file,
    };

    let dylib_dir = app.path().resource_dir().ok();
    let child = spawn_llama_server(&binary, &args, dylib_dir)?;
    *state.llama_child.lock().unwrap() = Some(child);
    *state.current_host.lock().unwrap() = host_val.clone();
    *state.current_port.lock().unwrap() = port_val;

    wait_for_server(
        &app,
        model_id,
        host_val.clone(),
        port_val,
        Arc::clone(&state.llama_child),
        Arc::clone(&state.epoch),
        my_epoch,
    );

    Ok(StartResult { starting: true, port: port_val, host: host_val })
}

#[tauri::command]
fn stop_llama_server(state: tauri::State<AppState>) -> Result<(), String> {
    state.epoch.fetch_add(1, Ordering::SeqCst);
    kill_existing(&state.llama_child);
    Ok(())
}

#[derive(serde::Serialize)]
struct ServerStatus {
    running: bool,
    port: u16,
    host: String,
}

#[tauri::command]
fn get_server_status(state: tauri::State<AppState>) -> ServerStatus {
    let running = state
        .llama_child
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    let port = state.current_port.lock().map(|p| *p).unwrap_or(DEFAULT_PORT);
    let host = state
        .current_host
        .lock()
        .map(|h| h.clone())
        .unwrap_or_else(|_| DEFAULT_HOST.to_string());
    ServerStatus { running, port, host }
}

#[tauri::command]
fn read_log_tail(state: tauri::State<AppState>, max_bytes: Option<u64>) -> String {
    let log_path = {
        let guard = match state.llama_child.lock() {
            Ok(g) => g,
            Err(_) => return String::new(),
        };
        match guard.as_ref() {
            Some(child) => child.log_path.clone(),
            None => return String::new(),
        }
    };

    let limit = max_bytes.unwrap_or(100_000) as usize;
    match std::fs::read(&log_path) {
        Ok(data) => {
            let start = data.len().saturating_sub(limit);
            String::from_utf8_lossy(&data[start..]).into_owned()
        }
        Err(_) => String::new(),
    }
}

// ── Entry point ─────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            llama_child: Arc::new(Mutex::new(None)),
            epoch: Arc::new(AtomicU64::new(0)),
            current_host: Arc::new(Mutex::new(DEFAULT_HOST.to_string())),
            current_port: Arc::new(Mutex::new(DEFAULT_PORT)),
        })
        .invoke_handler(tauri::generate_handler![
            start_llama_server,
            stop_llama_server,
            get_server_status,
            read_log_tail,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.epoch.fetch_add(1, Ordering::SeqCst);
                    kill_existing(&state.llama_child);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running GGUF Desktop");
}
