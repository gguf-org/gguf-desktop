import { useState, useEffect, useRef, useCallback } from "react";
import {
  Server,
  Settings2,
  Package,
  Terminal,
  Play,
  Square,
  Copy,
  Check,
  AlertCircle,
  Folder,
  X,
  RefreshCw,
  Sun,
  Moon,
  Info,
  Cpu,
  Wifi,
  Wrench,
  Key,
  Tag,
  HardDrive,
  Code2,
  Eye,
  MessageSquare,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Settings {
  host: string;
  port: number;
  contextLength: number;
  gpuLayers: number;
  cpuThreads: number;
  nParallel: number;
  batchSize: number;
  ubatchSize: number;
  apiKey: string;
  modelAlias: string;
  flashAttn: boolean;
  cacheTypeK: string;
  cacheTypeV: string;
  contBatching: boolean;
  mlock: boolean;
  noMmap: boolean;
}

interface ModelConfig {
  modelPath: string;
  mmprojPath: string;
  chatTemplateMode: "auto" | "file" | "custom";
  chatTemplateFile: string;
  chatTemplate: string;
}

type TabId = "server" | "model" | "settings" | "logs";
type Theme = "dark" | "light";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Settings = {
  host: "127.0.0.1",
  port: 8888,
  contextLength: 4096,
  gpuLayers: 0,
  cpuThreads: 8,
  nParallel: 1,
  batchSize: 512,
  ubatchSize: 512,
  apiKey: "",
  modelAlias: "",
  flashAttn: false,
  cacheTypeK: "f16",
  cacheTypeV: "f16",
  contBatching: true,
  mlock: false,
  noMmap: false,
};

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  modelPath: "",
  mmprojPath: "",
  chatTemplateMode: "auto",
  chatTemplateFile: "",
  chatTemplate: "",
};

const STORAGE_KEY = "gguf-desktop-v1";
const LEGACY_STORAGE_KEY = "llm-desktop-v1";
const THEME_STORAGE_KEY = "gguf-desktop-theme";
const LEGACY_THEME_STORAGE_KEY = "llm-desktop-theme";

const CACHE_TYPES = [
  "f32",
  "f16",
  "q8_0",
  "q4_0",
  "q4_1",
  "iq4_nl",
  "q5_0",
  "q5_1",
];
const HOST_OPTIONS = ["127.0.0.1", "0.0.0.0", "localhost"];

const ENDPOINTS = [
  { method: "GET", path: "/v1/models", desc: "List available models" },
  {
    method: "POST",
    path: "/v1/chat/completions",
    desc: "Chat completions (streaming supported)",
  },
  { method: "POST", path: "/v1/completions", desc: "Text completions" },
  { method: "POST", path: "/v1/embeddings", desc: "Text embeddings" },
  { method: "GET", path: "/health", desc: "Health check" },
  { method: "GET", path: "/metrics", desc: "Prometheus metrics" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cn(
  ...classes: (string | boolean | undefined | null)[]
): string {
  return classes.filter(Boolean).join(" ");
}

function filename(path: string): string {
  if (!path) return "";
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

// ─── Small UI components ──────────────────────────────────────────────────────

interface SliderFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  description?: string;
}
function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit = "",
  description,
}: SliderFieldProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-zinc-300">{label}</label>
        <span className="text-sm font-mono text-zinc-100 dark:text-zinc-200">
          {value.toLocaleString()}
          {unit}
        </span>
      </div>
      {description && (
        <p className="text-xs text-zinc-500 leading-relaxed">{description}</p>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
      <div className="flex justify-between text-xs text-zinc-600">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  description?: string;
}
function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  description,
}: NumberFieldProps) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-zinc-300">{label}</label>
      {description && (
        <p className="text-xs text-zinc-500 leading-relaxed">{description}</p>
      )}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-zinc-400 font-mono"
      />
    </div>
  );
}

interface ToggleFieldProps {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  description?: string;
}
function ToggleField({
  label,
  checked,
  onChange,
  description,
}: ToggleFieldProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="flex-1">
        <p className="text-sm font-medium text-zinc-300">{label}</p>
        {description && (
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
            {description}
          </p>
        )}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 mt-0.5",
          checked ? "bg-zinc-900 dark:bg-zinc-200" : "bg-zinc-700"
        )}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-5" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  description?: string;
}
function SelectField({
  label,
  value,
  onChange,
  options,
  description,
}: SelectFieldProps) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-zinc-300">{label}</label>
      {description && (
        <p className="text-xs text-zinc-500 leading-relaxed">{description}</p>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-zinc-400"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  description?: string;
}
function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  description,
}: TextFieldProps) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-zinc-300">{label}</label>
      {description && (
        <p className="text-xs text-zinc-500 leading-relaxed">{description}</p>
      )}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-zinc-400 placeholder:text-zinc-600"
      />
    </div>
  );
}

function SectionHeader({
  icon,
  title,
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 pb-3 mb-1 border-b border-zinc-800">
      <span className="text-zinc-400 dark:text-zinc-300">{icon}</span>
      <h3 className="font-semibold text-zinc-100 text-sm">{title}</h3>
    </div>
  );
}

function FilePickerRow({
  value,
  onClear,
  onBrowse,
  placeholder,
}: {
  value: string;
  onClear: () => void;
  onBrowse: () => void;
  placeholder: string;
}) {
  return (
    <div className="flex gap-2">
      <div className="flex-1 flex items-center gap-2 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 min-w-0">
        <span
          className={cn(
            "text-sm flex-1 font-mono truncate",
            value ? "text-zinc-200" : "text-zinc-600"
          )}
        >
          {value || placeholder}
        </span>
        {value && (
          <button
            onClick={onClear}
            className="text-zinc-500 hover:text-zinc-300 flex-shrink-0"
          >
            <X size={13} />
          </button>
        )}
      </div>
      <button
        onClick={onBrowse}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm font-medium transition-colors flex-shrink-0"
      >
        <Folder size={13} />
        Browse
      </button>
    </div>
  );
}

// ─── Server Panel ─────────────────────────────────────────────────────────────

interface ServerPanelProps {
  serverRunning: boolean;
  serverStarting: boolean;
  serverError: string | null;
  serverUrl: string;
  settings: Settings;
  modelConfig: ModelConfig;
  onStart: () => void;
  onStop: () => void;
}

function ServerPanel({
  serverRunning,
  serverStarting,
  serverError,
  serverUrl,
  settings,
  modelConfig,
  onStart,
  onStop,
}: ServerPanelProps) {
  const [copied, setCopied] = useState(false);

  const endpointUrl =
    serverUrl || `http://${settings.host}:${settings.port}/v1`;

  const copyUrl = () => {
    navigator.clipboard.writeText(endpointUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const statusDotCls = serverRunning
    ? "bg-emerald-400"
    : serverStarting
      ? "bg-amber-400 animate-pulse"
      : "bg-zinc-600";
  const statusLabel = serverRunning
    ? "Running"
    : serverStarting
      ? "Starting…"
      : "Stopped";
  const statusTextCls = serverRunning
    ? "text-emerald-400"
    : serverStarting
      ? "text-amber-400"
      : "text-zinc-500";

  return (
    <div className="space-y-5">
      {/* Status card */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className={cn("w-2.5 h-2.5 rounded-full", statusDotCls)} />
            <span className={cn("font-semibold text-base", statusTextCls)}>
              {statusLabel}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onStart}
              disabled={serverRunning || serverStarting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              <Play size={13} />
              Start Server
            </button>
            <button
              onClick={onStop}
              disabled={!serverRunning && !serverStarting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rose-800 hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              <Square size={13} />
              Stop
            </button>
          </div>
        </div>

        {/* Endpoint URL */}
        <div className="space-y-1.5">
          <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">
            API Endpoint
          </p>
          <div className="flex items-center gap-2 bg-zinc-800 rounded-lg px-4 py-2.5 font-mono text-sm">
            <span
              className={cn(
                "flex-1",
                serverRunning ? "text-emerald-400" : "text-zinc-400"
              )}
            >
              {endpointUrl}
            </span>
            <button
              onClick={copyUrl}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {copied ? (
                <Check size={14} className="text-emerald-400" />
              ) : (
                <Copy size={14} />
              )}
            </button>
          </div>
        </div>

        {/* Error */}
        {serverError && (
          <div className="mt-4 flex items-start gap-3 bg-rose-950/50 border border-rose-900 rounded-lg p-3.5">
            <AlertCircle
              size={15}
              className="text-rose-400 mt-0.5 flex-shrink-0"
            />
            <p className="text-sm text-rose-300 leading-relaxed">
              {serverError}
            </p>
          </div>
        )}
      </div>

      {/* Config summary */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <SectionHeader icon={<Info size={14} />} title="Active Configuration" />
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 mt-3">
          <ConfigRow
            label="Model"
            value={filename(modelConfig.modelPath) || "(none selected)"}
            mono
          />
          <ConfigRow
            label="Vision Projector"
            value={filename(modelConfig.mmprojPath) || "(none)"}
            mono
          />
          <ConfigRow
            label="Context Length"
            value={`${settings.contextLength.toLocaleString()} tokens`}
          />
          <ConfigRow
            label="GPU Layers"
            value={
              settings.gpuLayers === 0
                ? "CPU only"
                : `${settings.gpuLayers} layers`
            }
          />
          <ConfigRow
            label="CPU Threads"
            value={settings.cpuThreads.toString()}
          />
          <ConfigRow
            label="Parallel Slots"
            value={settings.nParallel.toString()}
          />
          <ConfigRow
            label="Model Alias"
            value={settings.modelAlias || "(auto-detect)"}
          />
          <ConfigRow
            label="API Key"
            value={settings.apiKey ? "••••••••" : "(disabled)"}
          />
          <ConfigRow
            label="Flash Attention"
            value={settings.flashAttn ? "Enabled" : "Disabled"}
          />
          <ConfigRow
            label="Continuous Batching"
            value={settings.contBatching ? "Enabled" : "Disabled"}
          />
        </div>
      </div>

      {/* Endpoint reference */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <SectionHeader
          icon={<Code2 size={14} />}
          title="OpenAI-Compatible Endpoints"
        />
        <div className="mt-3 space-y-1.5">
          {ENDPOINTS.map((ep) => (
            <div key={ep.path} className="flex items-center gap-3 text-sm py-1">
              <span
                className={cn(
                  "text-xs font-mono font-bold px-2 py-0.5 rounded min-w-[44px] text-center",
                  ep.method === "GET"
                    ? "bg-emerald-900/50 text-emerald-200"
                    : "bg-zinc-800 text-zinc-300"
                )}
              >
                {ep.method}
              </span>
              <span className="font-mono text-zinc-300 w-48 flex-shrink-0">
                {ep.path}
              </span>
              <span className="text-zinc-500 text-xs">{ep.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConfigRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-zinc-500">{label}</p>
      <p
        className={cn(
          "text-sm text-zinc-200 mt-0.5 truncate",
          mono && "font-mono"
        )}
      >
        {value}
      </p>
    </div>
  );
}

// ─── Model Panel ──────────────────────────────────────────────────────────────

interface ModelPanelProps {
  modelConfig: ModelConfig;
  setModelConfig: React.Dispatch<React.SetStateAction<ModelConfig>>;
}

function ModelPanel({ modelConfig, setModelConfig }: ModelPanelProps) {
  const update = <K extends keyof ModelConfig>(key: K, value: ModelConfig[K]) =>
    setModelConfig((prev) => ({ ...prev, [key]: value }));

  const openGguf = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        filters: [{ name: "GGUF Model", extensions: ["gguf"] }],
        title: "Select GGUF Model File",
      });
      if (path && typeof path === "string") update("modelPath", path);
    } catch (err) {
      console.error("File dialog error:", err);
    }
  };

  const openMmproj = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        filters: [{ name: "Vision Projector", extensions: ["gguf"] }],
        title: "Select Vision Projector (mmproj)",
      });
      if (path && typeof path === "string") update("mmprojPath", path);
    } catch (err) {
      console.error("File dialog error:", err);
    }
  };

  const openTemplate = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        filters: [
          {
            name: "Template Files",
            extensions: ["json", "jinja", "jinja2", "txt"],
          },
          { name: "All Files", extensions: ["*"] },
        ],
        title: "Select Chat Template File",
      });
      if (path && typeof path === "string") update("chatTemplateFile", path);
    } catch (err) {
      console.error("File dialog error:", err);
    }
  };

  return (
    <div className="space-y-5">
      {/* GGUF Model */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4">
        <SectionHeader
          icon={<HardDrive size={14} />}
          title="GGUF Model File"
        />

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-xs text-zinc-500">Model file</p>
            <span className="text-xs font-mono text-zinc-600">.gguf</span>
          </div>
          <FilePickerRow
            value={modelConfig.modelPath}
            onClear={() => update("modelPath", "")}
            onBrowse={openGguf}
            placeholder="No model selected…"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-xs text-zinc-500">Vision projector / mmproj</p>
            <span className="text-xs font-mono text-zinc-600">.gguf</span>
            <span className="text-xs bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded">
              optional
            </span>
            <span className="text-xs bg-zinc-800 text-zinc-300 px-1.5 py-0.5 rounded flex items-center gap-1">
              <Eye size={9} /> enables vision
            </span>
          </div>
          <FilePickerRow
            value={modelConfig.mmprojPath}
            onClear={() => update("mmprojPath", "")}
            onBrowse={openMmproj}
            placeholder="No projector selected…"
          />
        </div>
      </div>

      {/* Chat Template */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4">
        <SectionHeader
          icon={<MessageSquare size={14} />}
          title="Chat Template"
        />

        <div className="space-y-3">
          {(["auto", "file", "custom"] as const).map((mode) => (
            <label key={mode} className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="chatTemplateMode"
                value={mode}
                checked={modelConfig.chatTemplateMode === mode}
                onChange={() => update("chatTemplateMode", mode)}
                className="mt-0.5 accent-zinc-900 dark:accent-zinc-200"
              />
              <div>
                <p className="text-sm font-medium text-zinc-300">
                  {mode === "auto"
                    ? "Auto-detect from GGUF metadata"
                    : mode === "file"
                      ? "Import from file"
                      : "Custom Jinja2 template"}
                </p>
                <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
                  {mode === "auto"
                    ? "Reads tokenizer.chat_template from the model's GGUF metadata (recommended)"
                    : mode === "file"
                      ? "Load a Jinja2 template from a .json, .jinja, or .txt file"
                      : "Enter a raw Jinja2 chat template string"}
                </p>
              </div>
            </label>
          ))}
        </div>

        {modelConfig.chatTemplateMode === "file" && (
          <div className="space-y-2 pt-1">
            <p className="text-xs text-zinc-500">Template file</p>
            <FilePickerRow
              value={modelConfig.chatTemplateFile}
              onClear={() => update("chatTemplateFile", "")}
              onBrowse={openTemplate}
              placeholder="No template file selected…"
            />
          </div>
        )}

        {modelConfig.chatTemplateMode === "custom" && (
          <div className="space-y-2 pt-1">
            <p className="text-xs text-zinc-500">Jinja2 template string</p>
            <textarea
              value={modelConfig.chatTemplate}
              onChange={(e) => update("chatTemplate", e.target.value)}
              placeholder="{%- for message in messages -%}..."
              rows={7}
              className="w-full px-3 py-2.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-xs font-mono focus:outline-none focus:border-zinc-400 placeholder:text-zinc-600 leading-relaxed"
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

interface SettingsPanelProps {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
}

function SettingsPanel({ settings, setSettings }: SettingsPanelProps) {
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-5">
      {/* Network */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4">
        <SectionHeader icon={<Wifi size={14} />} title="Network" />
        <div className="grid grid-cols-2 gap-4">
          <SelectField
            label="Host"
            value={settings.host}
            onChange={(v) => update("host", v)}
            options={HOST_OPTIONS}
            description="Listen address. Use 0.0.0.0 to accept connections from other devices."
          />
          <NumberField
            label="Port"
            value={settings.port}
            onChange={(v) => update("port", v)}
            min={1024}
            max={65535}
            description="Default: 8888. LM Studio uses 1234, Ollama uses 11434."
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label="API Key"
            value={settings.apiKey}
            onChange={(v) => update("apiKey", v)}
            type="password"
            placeholder="(optional)"
            description="If set, clients must pass Authorization: Bearer <key> in headers."
          />
          <TextField
            label="Model Alias"
            value={settings.modelAlias}
            onChange={(v) => update("modelAlias", v)}
            placeholder="my-model"
            description="Name shown by the /v1/models endpoint. Leave blank to use filename."
          />
        </div>
      </div>

      {/* Performance */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-5">
        <SectionHeader icon={<Cpu size={14} />} title="Performance" />
        <SliderField
          label="Context Length"
          value={settings.contextLength}
          onChange={(v) => update("contextLength", v)}
          min={512}
          max={131072}
          step={512}
          unit=" tokens"
          description="Maximum context window size. Higher values require more VRAM/RAM."
        />
        <SliderField
          label="GPU Layers"
          value={settings.gpuLayers}
          onChange={(v) => update("gpuLayers", v)}
          min={0}
          max={200}
          description="Number of model layers offloaded to GPU. Set to 0 for CPU-only mode."
        />
        <SliderField
          label="CPU Threads"
          value={settings.cpuThreads}
          onChange={(v) => update("cpuThreads", v)}
          min={1}
          max={64}
          description="Number of CPU threads used for token generation."
        />
        <SliderField
          label="Parallel Slots"
          value={settings.nParallel}
          onChange={(v) => update("nParallel", v)}
          min={1}
          max={16}
          description="Simultaneous request slots for server batching."
        />
        <div className="grid grid-cols-2 gap-4">
          <NumberField
            label="Batch Size"
            value={settings.batchSize}
            onChange={(v) => update("batchSize", v)}
            min={32}
            max={4096}
            description="Logical batch size for prompt processing."
          />
          <NumberField
            label="Micro Batch Size"
            value={settings.ubatchSize}
            onChange={(v) => update("ubatchSize", v)}
            min={32}
            max={4096}
            description="Physical batch size for prompt processing."
          />
        </div>
      </div>

      {/* Advanced */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4">
        <SectionHeader icon={<Wrench size={14} />} title="Advanced" />
        <div className="grid grid-cols-2 gap-4">
          <SelectField
            label="KV Cache — Keys"
            value={settings.cacheTypeK}
            onChange={(v) => update("cacheTypeK", v)}
            options={CACHE_TYPES}
            description="q8_0 saves VRAM with minimal quality loss."
          />
          <SelectField
            label="KV Cache — Values"
            value={settings.cacheTypeV}
            onChange={(v) => update("cacheTypeV", v)}
            options={CACHE_TYPES}
            description="Data type for attention value cache."
          />
        </div>
        <div className="space-y-1 divide-y divide-zinc-800/60">
          <ToggleField
            label="Flash Attention"
            checked={settings.flashAttn}
            onChange={(v) => update("flashAttn", v)}
            description="Faster attention computation — requires compatible GPU."
          />
          <ToggleField
            label="Continuous Batching"
            checked={settings.contBatching}
            onChange={(v) => update("contBatching", v)}
            description="Serve multiple requests in a single inference pass."
          />
          <ToggleField
            label="Memory Lock (mlock)"
            checked={settings.mlock}
            onChange={(v) => update("mlock", v)}
            description="Keep model weights pinned in RAM to prevent swapping."
          />
          <ToggleField
            label="Disable mmap"
            checked={settings.noMmap}
            onChange={(v) => update("noMmap", v)}
            description="Load model entirely into RAM instead of memory-mapping the file."
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={() => setSettings(DEFAULT_SETTINGS)}
          className="px-4 py-2 rounded-lg border border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-zinc-200 text-sm font-medium transition-colors"
        >
          Reset to Defaults
        </button>
        <p className="text-xs text-zinc-600">Settings are saved automatically</p>
      </div>
    </div>
  );
}

// ─── Logs Panel ───────────────────────────────────────────────────────────────

interface LogsPanelProps {
  logs: string;
  serverRunning: boolean;
  onRefresh: () => void;
}

function LogsPanel({ logs, serverRunning, onRefresh }: LogsPanelProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  return (
    <div className="space-y-3 h-full">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">Auto-scroll</span>
          <button
            onClick={() => setAutoScroll((v) => !v)}
            className={cn(
              "relative inline-flex h-4 w-7 items-center rounded-full transition-colors",
              autoScroll ? "bg-zinc-900 dark:bg-zinc-200" : "bg-zinc-700"
            )}
          >
            <span
              className={cn(
                "inline-block h-3 w-3 rounded-full bg-white shadow transition-transform",
                autoScroll ? "translate-x-3.5" : "translate-x-0.5"
              )}
            />
          </button>
        </div>
        <button
          onClick={onRefresh}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-xs transition-colors"
        >
          <RefreshCw size={11} />
          Refresh
        </button>
        {!serverRunning && (
          <span className="text-xs text-zinc-600 italic">
            Start the server to see logs
          </span>
        )}
      </div>
      <pre
        ref={logRef}
        className="w-full overflow-auto rounded-xl bg-zinc-900 border border-zinc-800 p-4 text-xs font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap"
        style={{ height: "calc(100vh - 260px)" }}
      >
        {logs ||
          (serverRunning
            ? "Waiting for log output…"
            : "No log available. Start the server first.")}
      </pre>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "server", label: "Server", icon: <Server size={14} /> },
  { id: "model", label: "Model", icon: <Package size={14} /> },
  { id: "settings", label: "Settings", icon: <Settings2 size={14} /> },
  { id: "logs", label: "Logs", icon: <Terminal size={14} /> },
];

export default function App() {
  const [theme, setTheme] = useState<Theme>(
    () =>
      ((localStorage.getItem(THEME_STORAGE_KEY) ||
        localStorage.getItem(LEGACY_THEME_STORAGE_KEY)) as Theme) || "dark"
  );
  const [activeTab, setActiveTab] = useState<TabId>("server");

  const [serverRunning, setServerRunning] = useState(false);
  const [serverStarting, setServerStarting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState("");

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [modelConfig, setModelConfig] =
    useState<ModelConfig>(DEFAULT_MODEL_CONFIG);

  const [logs, setLogs] = useState("");

  // Persist theme
  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  // Load persisted settings/model config
  useEffect(() => {
    try {
      const saved =
        localStorage.getItem(STORAGE_KEY) ||
        localStorage.getItem(LEGACY_STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved) as {
          settings?: Partial<Settings>;
          modelConfig?: Partial<ModelConfig>;
        };
        if (data.settings)
          setSettings((_s) => ({ ...DEFAULT_SETTINGS, ...data.settings }));
        if (data.modelConfig)
          setModelConfig((_m) => ({
            ...DEFAULT_MODEL_CONFIG,
            ...data.modelConfig,
          }));
      }
    } catch {
      // ignore corrupt storage
    }
  }, []);

  // Auto-save on change
  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ settings, modelConfig })
    );
  }, [settings, modelConfig]);

  // Listen for server-ready events from Rust backend
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function setup() {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{
        running?: boolean;
        url?: string;
        error?: string;
        port?: number;
        host?: string;
      }>("llm-server-ready", (event) => {
        setServerStarting(false);
        if (event.payload.error) {
          setServerRunning(false);
          setServerError(event.payload.error);
        } else {
          setServerRunning(true);
          setServerError(null);
          setServerUrl(event.payload.url ?? "");
        }
      });
    }
    setup();
    return () => {
      unlisten?.();
    };
  }, []);

  // Check server status on mount (in case app was reloaded)
  useEffect(() => {
    async function check() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const status = await invoke<{
          running: boolean;
          port: number;
          host: string;
        }>("get_server_status");
        setServerRunning(status.running);
        if (status.running) {
          setServerUrl(`http://${status.host}:${status.port}/v1`);
        }
      } catch {
        // not in Tauri context or error — ignore
      }
    }
    check();
  }, []);

  // Poll logs while on the Logs tab
  const fetchLogs = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const content = await invoke<string>("read_log_tail", {
        maxBytes: 100000,
      });
      setLogs(content);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (activeTab !== "logs") return;
    let cancelled = false;
    async function poll() {
      while (!cancelled) {
        await fetchLogs();
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [activeTab, fetchLogs]);

  const handleStart = useCallback(async () => {
    if (!modelConfig.modelPath) {
      setServerError(
        "No model file selected. Go to the Model tab and choose a .gguf file."
      );
      setActiveTab("model");
      return;
    }
    setServerStarting(true);
    setServerError(null);
    setLogs("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("start_llama_server", {
        modelPath: modelConfig.modelPath,
        mmprojPath: modelConfig.mmprojPath || null,
        host: settings.host,
        port: settings.port,
        contextLength: settings.contextLength,
        gpuLayers: settings.gpuLayers,
        cpuThreads: settings.cpuThreads,
        nParallel: settings.nParallel,
        batchSize: settings.batchSize,
        ubatchSize: settings.ubatchSize,
        apiKey: settings.apiKey || null,
        modelAlias: settings.modelAlias || null,
        flashAttn: settings.flashAttn,
        cacheTypeK: settings.cacheTypeK,
        cacheTypeV: settings.cacheTypeV,
        contBatching: settings.contBatching,
        mlock: settings.mlock,
        noMmap: settings.noMmap,
        chatTemplate:
          modelConfig.chatTemplateMode === "custom"
            ? modelConfig.chatTemplate || null
            : null,
        chatTemplateFile:
          modelConfig.chatTemplateMode === "file"
            ? modelConfig.chatTemplateFile || null
            : null,
      });
    } catch (err: unknown) {
      setServerStarting(false);
      setServerError(String(err));
    }
  }, [settings, modelConfig]);

  const handleStop = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("stop_llama_server");
    } catch {
      // ignore
    }
    setServerRunning(false);
    setServerUrl("");
    setServerError(null);
  }, []);

  const isDark = theme === "dark";

  return (
    <div
      className={cn(
        "flex flex-col h-screen overflow-hidden",
        isDark
          ? "dark bg-zinc-950 text-zinc-100"
          : "light bg-gray-50 text-zinc-900"
      )}
    >
      {/* ── Header ── */}
      <header
        className={cn(
          "flex items-center justify-between px-5 py-2.5 border-b flex-shrink-0",
          isDark
            ? "bg-zinc-900 border-zinc-800"
            : "bg-white border-gray-200"
        )}
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-black dark:bg-white flex items-center justify-center flex-shrink-0">
            <Server size={12} className="text-white dark:text-zinc-950" />
          </div>
          <span className="font-semibold text-sm">GGUF Desktop</span>
          <span
            className={cn(
              "text-xs px-1.5 py-0.5 rounded",
              isDark
                ? "bg-zinc-800 text-zinc-500"
                : "bg-gray-100 text-gray-400"
            )}
          >
            engine
          </span>
        </div>

        <div className="flex items-center gap-4">
          {/* Live status pill */}
          <div className="flex items-center gap-1.5">
            <div
              className={cn(
                "w-2 h-2 rounded-full",
                serverRunning
                  ? "bg-emerald-400"
                  : serverStarting
                    ? "bg-amber-400 animate-pulse"
                    : isDark
                      ? "bg-zinc-700"
                      : "bg-gray-300"
              )}
            />
            <span
              className={cn(
                "text-xs font-medium",
                serverRunning
                  ? "text-emerald-400"
                  : serverStarting
                    ? "text-amber-400"
                    : isDark
                      ? "text-zinc-600"
                      : "text-gray-400"
              )}
            >
              {serverRunning
                ? `Running :${settings.port}`
                : serverStarting
                  ? "Starting…"
                  : "Stopped"}
            </span>
          </div>

          <button
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            className={cn(
              "p-1.5 rounded-lg transition-colors",
              isDark
                ? "hover:bg-zinc-800 text-zinc-400"
                : "hover:bg-gray-100 text-gray-500"
            )}
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
      </header>

      {/* ── Tab bar ── */}
      <div
        className={cn(
          "flex items-center gap-0.5 px-3 py-1.5 border-b flex-shrink-0",
          isDark
            ? "bg-zinc-900 border-zinc-800"
            : "bg-white border-gray-200"
        )}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors relative",
              activeTab === tab.id
                ? isDark
                  ? "bg-zinc-800 text-zinc-100"
                  : "bg-gray-100 text-zinc-900"
                : isDark
                  ? "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-100/60"
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.id === "logs" && serverRunning && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-400" />
            )}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-2xl mx-auto px-5 py-5">
          {activeTab === "server" && (
            <ServerPanel
              serverRunning={serverRunning}
              serverStarting={serverStarting}
              serverError={serverError}
              serverUrl={serverUrl}
              settings={settings}
              modelConfig={modelConfig}
              onStart={handleStart}
              onStop={handleStop}
            />
          )}
          {activeTab === "model" && (
            <ModelPanel
              modelConfig={modelConfig}
              setModelConfig={setModelConfig}
            />
          )}
          {activeTab === "settings" && (
            <SettingsPanel settings={settings} setSettings={setSettings} />
          )}
          {activeTab === "logs" && (
            <LogsPanel
              logs={logs}
              serverRunning={serverRunning}
              onRefresh={fetchLogs}
            />
          )}
        </div>
      </main>

      {/* ── Status bar ── */}
      <footer
        className={cn(
          "flex items-center gap-4 px-5 py-1.5 border-t text-xs flex-shrink-0",
          isDark
            ? "bg-zinc-900 border-zinc-800 text-zinc-600"
            : "bg-white border-gray-200 text-gray-400"
        )}
      >
        <div className="flex items-center gap-1.5">
          <Key size={10} />
          <span>
            {settings.apiKey ? "API key set" : "No API key"}
          </span>
        </div>
        <span className={isDark ? "text-zinc-800" : "text-gray-200"}>|</span>
        <div className="flex items-center gap-1.5">
          <Tag size={10} />
          <span className="font-mono">
            {settings.modelAlias ||
              filename(modelConfig.modelPath) ||
              "(no model)"}
          </span>
        </div>
        <span className={isDark ? "text-zinc-800" : "text-gray-200"}>|</span>
        <span className="font-mono">
          {serverRunning
            ? serverUrl || `http://${settings.host}:${settings.port}/v1`
            : `http://${settings.host}:${settings.port}/v1`}
        </span>
        <div className="flex-1" />
        <span>OpenAI-compatible</span>
      </footer>
    </div>
  );
}
