# GGUF Desktop

GGUF Desktop is a Tauri desktop app for running local `.gguf` models with 
an OpenAI-compatible HTTP API. The UI provides model selection, 
runtime settings, server lifecycle controls, endpoint reference, and
live log viewing.

![screenshot](https://raw.githubusercontent.com/gguf-org/gguf-desktop/master/demo.gif)

## Features

- Select a GGUF model file from disk.
- Optionally select a vision projector / `mmproj` GGUF file.
- Configure host, port, API key, model alias, context length, GPU layers,
  CPU threads, batching, KV cache types, flash attention, `mlock`, and mmap.
- Use automatic, file-based, or custom Jinja2 chat templates.
- Start and stop server from the desktop UI.
- Expose OpenAI-compatible endpoints at `http://<host>:<port>/v1`.
- View the current server log tail from the Logs tab.
- Persist app settings in browser `localStorage`.

## Tech Stack

- Frontend: React 19, TypeScript, Vite, Tailwind CSS, lucide-react.
- Desktop shell: Tauri 2.
- Backend: Rust commands exposed through Tauri invoke handlers.
- Runtime engine: bundled llama.cpp.
- Target package: macOS DMG.

## Architecture

```text
User
  |
  v
React UI (src/App.tsx)
  |  Tauri invoke/event API
  v
Rust backend (src-tauri/src/lib.rs)
  |  spawn/kill child process
  v
llama-server binary (src-tauri/binaries/)
  |  loads model + dylibs
  v
OpenAI-compatible HTTP API
  http://127.0.0.1:8888/v1
```

### Frontend Responsibilities

The React app owns the interactive desktop experience:

- Maintains tabs for Server, Model, Settings, and Logs.
- Stores user settings and model configuration under `gguf-desktop-v1`.
- Opens native file dialogs through `@tauri-apps/plugin-dialog`.
- Calls Rust commands with `@tauri-apps/api/core`.
- Listens for the `llm-server-ready` event from Rust.
- Polls `read_log_tail` while the Logs tab is active.

### Backend Responsibilities

The Rust backend owns process management:

- Validates model, projector, and template file paths.
- Converts UI settings into CLI arguments.
- Sets macOS dynamic library lookup paths for bundled `.dylib` files.
- Polls the configured TCP host and port until the server is ready.
- Emits readiness or startup errors back to the frontend.
- Kills the managed process when stopped or when the window is destroyed.
- Reads the active process log file from the temp directory.

## Runtime Workflow

```text
1. User chooses a .gguf model in the Model tab.
2. User adjusts runtime settings in the Settings tab.
3. User clicks Start Server.
4. React invokes start_llama_server with model and settings.
5. Rust stops any existing managed server process.
6. Rust resolves llama-server from the bundle/dev paths.
7. Rust validates selected files and builds CLI arguments.
8. Rust starts llama-server and redirects stdout/stderr to a temp log.
9. Rust polls host:port until the server accepts TCP connections.
10. Rust emits llm-server-ready.
11. React marks the server as running and displays the /v1 endpoint.
12. External clients can call the OpenAI-compatible API.
```

Stop flow:

```text
User clicks Stop
  -> React invokes stop_llama_server
  -> Rust increments the lifecycle epoch
  -> Rust kills and waits for the child process
  -> React clears running state and endpoint status
```

## Project Structure

```text
.
├── index.html
├── package.json
├── postcss.config.js
├── tailwind.config.js
├── tsconfig*.json
├── vite.config.ts
├── src/
│   ├── App.tsx              # Main React UI and Tauri command calls
│   ├── index.css            # Tailwind entry and global styles
│   ├── main.tsx             # React entry point
│   └── vite-env.d.ts
└── src-tauri/
    ├── Cargo.toml           # Rust crate and Tauri dependencies
    ├── build.rs             # Exposes TARGET_TRIPLE to Rust code
    ├── tauri.conf.json      # Tauri app, bundle, resources, and DMG config
    ├── capabilities/
    │   └── default.json     # Tauri permissions for main window/dialogs
    ├── binaries/
    │   ├── llama-server-aarch64-apple-darwin
    │   └── *.dylib          # llama.cpp runtime libraries
    └── src/
        ├── lib.rs           # Backend command handlers and process lifecycle
        └── main.rs          # Tauri executable entry point
```

## Tauri Commands

The frontend invokes these commands from `src/App.tsx`:

| Command | Purpose |
| --- | --- |
| `start_llama_server` | Starts a managed `llama-server` child process using the selected model and settings. |
| `stop_llama_server` | Stops the managed child process. |
| `get_server_status` | Returns whether a managed child process exists plus current host and port. |
| `read_log_tail` | Reads the last N bytes of the active server log file. |

The backend emits this event:

| Event | Purpose |
| --- | --- |
| `llm-server-ready` | Reports successful startup with endpoint metadata, or a startup error. |

## OpenAI-Compatible Endpoints

When the server is running, the app displays an endpoint such as:

```text
http://127.0.0.1:8888/v1
```

Common routes exposed by server (engine) include:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/models` | List available models. |
| `POST` | `/v1/chat/completions` | Chat completions, including streaming. |
| `POST` | `/v1/completions` | Text completions. |
| `POST` | `/v1/embeddings` | Text embeddings. |
| `GET` | `/health` | Health check. |
| `GET` | `/metrics` | Prometheus metrics. |

Example request:

```bash
curl http://127.0.0.1:8888/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local-model",
    "messages": [
      { "role": "user", "content": "Write a one sentence summary of GGUF." }
    ]
  }'
```

If an API key is configured in the app, clients must include:

```text
Authorization: Bearer <key>
```

## Development

### Prerequisites

- Node.js and npm.
- Rust toolchain compatible with `rust-version = 1.77.2`.
- Tauri system prerequisites for macOS development.
- A compatible `llama-server` binary in `src-tauri/binaries/`.
- The required llama.cpp `.dylib` files in `src-tauri/binaries/`.

### Install Dependencies

```bash
npm install
```

### Run the Desktop App for Development

```bash
npm run tauri:dev
```

Tauri runs `npm run dev` automatically through `beforeDevCommand` and loads the
frontend from `http://localhost:3000`.

### Build Frontend Assets

```bash
npm run build
```

### Build the macOS App Bundle / DMG

```bash
npm run tauri:build
```

The Tauri config currently enables the `dmg` bundle target.

For the current macOS ARM layout, the project includes:

```text
src-tauri/binaries/llama-server-aarch64-apple-darwin
```

`build.rs` injects the Cargo target triple into `TARGET_TRIPLE` so the backend
can resolve triple-suffixed binaries.

## Packaging Notes

`src-tauri/tauri.conf.json` configures:

- Product name: `GGUF Desktop`.
- App identifier: `com.gguf.desktop`.
- Main window size: `1024x720`, minimum `800x600`.
- Frontend output: `../dist`.
- Dev URL: `http://localhost:3000`.
- External binary entry: `binaries/llama-server`.
- macOS minimum system version: `11.0`.
- Bundled llama.cpp dynamic libraries as Tauri resources.

On macOS, the backend sets `DYLD_LIBRARY_PATH` to include the binary/resource
locations so `llama-server` can load the bundled `.dylib` files.

## Troubleshooting

### Server exits before binding the port

Open the Logs tab or inspect the temp log path referenced by the startup error.
Common causes are:

- Model path does not exist.
- Projector path does not exist.
- Missing bundled `.dylib` files.
- GPU layer count is too high for available memory.
- Model is too large for available RAM/VRAM.

Try setting GPU Layers to `0` for CPU-only startup.

### Port is already in use

Change the port in Settings. The default is `8888`.

### Other devices cannot connect

Set Host to `0.0.0.0`, confirm the firewall allows inbound connections, and use
the machine's LAN IP from the client device.

## License

This project is licensed under the MIT License. See `LICENSE`.
