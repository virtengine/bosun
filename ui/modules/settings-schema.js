/* ─────────────────────────────────────────────────────────────
 *  Settings Schema — Shared definition of all configurable env vars
 *  Used by both the Settings UI and the server-side settings API.
 * ────────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} SettingDef
 * @property {string} key          - Environment variable name
 * @property {string} label        - Human-readable label
 * @property {string} description  - Tooltip help text explaining the setting
 * @property {string} category     - Category ID for grouping
 * @property {string} type         - 'string' | 'number' | 'boolean' | 'select' | 'secret' | 'text' | 'json'
 * @property {*}      [defaultVal] - Default value
 * @property {string[]} [options]  - Valid choices for 'select' type
 * @property {boolean} [sensitive] - If true, value is masked in UI and excluded from GET responses
 * @property {string|Function}  [validate]  - Regex pattern string or predicate for validation
 * @property {number}  [min]       - Min value for 'number' type
 * @property {number}  [max]       - Max value for 'number' type
 * @property {string}  [unit]      - Display unit (e.g., 'ms', 'min', 'sec')
 * @property {boolean} [restart]   - If true, changing requires process restart
 * @property {boolean} [advanced]  - If true, hidden unless "Show advanced" is on
 * @property {string}  [section]   - Optional UI subsection label within a category
 */

export const CATEGORIES = [
  { id: "telegram",  label: "Telegram Bot",         icon: "phone", description: "Bot token, chat, polling, and notification settings" },
  { id: "miniapp",   label: "Mini App / UI",        icon: "monitor", description: "Web UI server, port, auth, and tunnel settings" },
  { id: "executor",  label: "Agent Architecture",   icon: "cpu", description: "Choose Bosun's primary agent runtime, configure harness providers, and manage legacy SDK compatibility only when needed" },
  { id: "voice",     label: "Voice Assistant",       icon: "headphones", description: "Real-time voice endpoints, provider routing, and voice behavior settings" },
  { id: "kanban",    label: "Kanban / Tasks",       icon: "clipboard", description: "Task backend, sync, labels, and project mapping" },
  { id: "gates",     label: "Gates / Safeguards",   icon: "shield", description: "PR trust, merge gates, execution posture, and runtime safeguards" },
  { id: "github",    label: "GitHub / Git",         icon: "git", description: "Repository, auth, PR, merge, and reconciliation settings" },
  { id: "network",   label: "Network / Tunnel",     icon: "globe", description: "Cloudflare tunnel, presence, and multi-instance coordination" },
  { id: "security",  label: "Security / Sandbox",   icon: "shield", description: "Sandbox mode, container isolation, and permissions" },
  { id: "sentinel",  label: "Sentinel / Reliability", icon: "link", description: "Auto-restart, crash recovery, and repair agent settings" },
  { id: "hooks",     label: "Agent Hooks",          icon: "link", description: "Pre-push, pre-commit, and lifecycle hook configuration" },
  { id: "logging",   label: "Logging / Monitoring", icon: "chart", description: "Work logs, error thresholds, cost tracking, and retention" },
  { id: "advanced",  label: "Advanced",             icon: "settings", description: "Daemon, dev mode, paths, and low-level tuning" },
  { id: "context-shredding", label: "Context Shredding",   icon: "scissors", description: "Tiered context compression to reduce token usage while preserving important history" },
];

function validateExecutorsPoolValue(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return true;
  const entries = raw.split(",").map((entry) => String(entry || "").trim()).filter(Boolean);
  if (!entries.length) return true;
  return entries.every((entry) => {
    const parts = entry.split(":");
    if (parts.length < 3) return false;
    const [executor = "", variant = "", weight = "", ...modelParts] = parts;
    if (!/^[A-Z_]+$/i.test(String(executor || "").trim())) return false;
    if (!/^[A-Z0-9._-]+$/i.test(String(variant || "").trim())) return false;
    if (!/^\d+$/.test(String(weight || "").trim())) return false;
    if (!modelParts.length) return true;
    const models = modelParts
      .join(":")
      .split("|")
      .map((model) => String(model || "").trim())
      .filter(Boolean);
    if (!models.length) return false;
    return models.every((model) => /^[A-Z0-9._:/-]+$/i.test(model));
  });
}

/** @type {SettingDef[]} */
export const SETTINGS_SCHEMA = [
  // ── Telegram Bot ──────────────────────────────────────────────
  { key: "TELEGRAM_BOT_TOKEN",              label: "Bot Token",                  category: "telegram", type: "secret",  sensitive: true, description: "Token from @BotFather. Required for all Telegram features.", restart: true },
  { key: "TELEGRAM_CHAT_ID",               label: "Chat ID",                    category: "telegram", type: "secret",  sensitive: true, description: "Primary chat/group ID for status messages and commands." },
  { key: "TELEGRAM_ALLOWED_CHAT_IDS",      label: "Allowed Chat IDs",           category: "telegram", type: "string",  description: "Comma-separated list of chat IDs allowed to send commands. Leave empty to allow all.", validate: "^[0-9,\\-\\s]*$" },
  { key: "TELEGRAM_INTERVAL_MIN",          label: "Status Interval",            category: "telegram", type: "number",  defaultVal: 10, min: 1, max: 1440, unit: "min", description: "Minutes between automatic status summary messages." },
  { key: "TELEGRAM_COMMAND_POLL_TIMEOUT_SEC", label: "Poll Timeout",            category: "telegram", type: "number",  defaultVal: 20, min: 5, max: 120, unit: "sec", description: "Long-polling timeout for receiving commands." },
  { key: "TELEGRAM_AGENT_TIMEOUT_MIN",     label: "Agent Timeout",              category: "telegram", type: "number",  defaultVal: 90, min: 5, max: 720, unit: "min", description: "Maximum time an SDK-triggered agent can run before timeout." },
  { key: "TELEGRAM_COMMAND_CONCURRENCY",   label: "Command Concurrency",        category: "telegram", type: "number",  defaultVal: 2, min: 1, max: 10, description: "Max concurrent command handlers." },
  { key: "TELEGRAM_VERBOSITY",             label: "Message Verbosity",          category: "telegram", type: "select",  defaultVal: "summary", options: ["minimal", "summary", "detailed"], description: "Level of detail in Telegram status messages." },
  { key: "TELEGRAM_BATCH_NOTIFICATIONS",   label: "Batch Notifications",        category: "telegram", type: "boolean", defaultVal: false, description: "Batch multiple notifications into periodic digests instead of sending individually." },
  { key: "TELEGRAM_BATCH_INTERVAL_SEC",    label: "Batch Interval",             category: "telegram", type: "number",  defaultVal: 300, min: 30, max: 3600, unit: "sec", description: "Seconds between batch flushes when batching is enabled.", advanced: true },
  { key: "TELEGRAM_BATCH_MAX_SIZE",        label: "Batch Max Size",             category: "telegram", type: "number",  defaultVal: 50, min: 5, max: 500, description: "Force flush batch when it reaches this many messages.", advanced: true },
  { key: "TELEGRAM_IMMEDIATE_PRIORITY",    label: "Immediate Priority",         category: "telegram", type: "select",  defaultVal: "1", options: ["1", "2", "3"], description: "Messages at or above this priority send immediately even when batching. 1=critical only, 2=+errors, 3=+warnings.", advanced: true },
  { key: "TELEGRAM_API_BASE_URL",          label: "API Base URL",               category: "telegram", type: "string",  defaultVal: "https://api.telegram.org", description: "Override for Telegram API proxy.", advanced: true, validate: "^https?://" },
  { key: "TELEGRAM_HTTP_TIMEOUT_MS",       label: "HTTP Timeout",               category: "telegram", type: "number",  defaultVal: 15000, min: 5000, max: 60000, unit: "ms", description: "Per-request timeout for Telegram API calls.", advanced: true },
  { key: "TELEGRAM_RETRY_ATTEMPTS",        label: "Retry Attempts",             category: "telegram", type: "number",  defaultVal: 4, min: 0, max: 10, description: "Number of retry attempts for transient Telegram API failures.", advanced: true },
  { key: "TELEGRAM_HISTORY_RETENTION_DAYS", label: "Auto-Delete History",       category: "telegram", type: "number",  defaultVal: 3, min: 0, max: 365, unit: "days", description: "Automatically delete bot messages older than this many days to keep the chat tidy. 0 = disabled. Note: Telegram may silently skip messages older than 48 h in private chats.", restart: false },
  { key: "PROJECT_NAME",                   label: "Project Name",               category: "telegram", type: "string",  description: "Display name used in Telegram messages and logs. Auto-detected from package.json if not set." },

  // ── Mini App / UI Server ──────────────────────────────────────
  { key: "TELEGRAM_MINIAPP_ENABLED",       label: "Enable Mini App",            category: "miniapp", type: "boolean", defaultVal: false, description: "Enable the Telegram Mini App web UI server.", restart: true },
  { key: "TELEGRAM_UI_PORT",               label: "UI Port",                    category: "miniapp", type: "number",  min: 1024, max: 65535, description: "HTTP/HTTPS port for the Mini App server. Required when enabled.", restart: true },
  { key: "TELEGRAM_UI_HOST",               label: "Bind Host",                  category: "miniapp", type: "string",  defaultVal: "0.0.0.0", description: "Network interface to bind. Use 127.0.0.1 for local-only access.", restart: true },
  { key: "TELEGRAM_UI_PUBLIC_HOST",        label: "Public Host",                category: "miniapp", type: "string",  description: "Public hostname if behind a reverse proxy. Auto-detected if not set." },
  { key: "TELEGRAM_UI_BASE_URL",           label: "Base URL Override",          category: "miniapp", type: "string",  description: "Full public URL (e.g., https://my-domain.com). Takes precedence over auto-detection.", validate: "^https?://" },
  { key: "TELEGRAM_UI_ALLOW_UNSAFE",       label: "Allow Unsafe (No Auth)",      category: "miniapp", type: "boolean", defaultVal: false, description: "DANGER: Disables ALL authentication. Anyone with your URL can control agents, read secrets, and execute code on your machine. Combined with a tunnel, this exposes your machine to the ENTIRE INTERNET. Only enable for localhost-only debugging with tunnel DISABLED.", restart: true, danger: true },
  { key: "_UNSAFE_TUNNEL_WARNING",          label: "",                            category: "miniapp", type: "info",    description: "WARNING: If 'Allow Unsafe' is ON and 'Tunnel Mode' is not disabled, your UI is publicly accessible with ZERO authentication. This is a critical security risk." },
  { key: "TELEGRAM_UI_AUTH_MAX_AGE_SEC",   label: "Auth Token Max Age",         category: "miniapp", type: "number",  defaultVal: 86400, min: 300, max: 604800, unit: "sec", description: "Maximum age for Telegram initData tokens before they expire." },
  { key: "TELEGRAM_UI_TUNNEL",             label: "Tunnel Mode",                category: "miniapp", type: "select",  defaultVal: "named", options: ["named", "quick", "auto", "cloudflared", "disabled"], description: "Cloudflare tunnel mode. 'named' is default and uses persistent hostname + DNS sync. 'quick' is explicit fallback.", restart: true },
  { key: "TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK", label: "Allow Quick Fallback", category: "miniapp", type: "boolean", defaultVal: false, description: "When named tunnel startup fails, allow fallback to random trycloudflare hostname.", restart: true, advanced: true },
  { key: "BOSUN_UI_RATE_LIMIT_PER_MIN", label: "Mutation Limit", category: "miniapp", type: "number", defaultVal: 30, min: 1, max: 600, unit: "req/min", description: "Baseline POST rate limit for non-session UI traffic.", advanced: true },
  { key: "BOSUN_UI_RATE_LIMIT_AUTHENTICATED_PER_MIN", label: "Authed Mutation Limit", category: "miniapp", type: "number", defaultVal: 120, min: 1, max: 1200, unit: "req/min", description: "Higher POST rate limit for authenticated Telegram/session users.", advanced: true },
  { key: "BOSUN_UI_RATE_LIMIT_PRIVILEGED_PER_MIN", label: "Privileged Mutation Limit", category: "miniapp", type: "number", defaultVal: 600, min: 1, max: 5000, unit: "req/min", description: "POST rate limit for desktop API key, fallback-auth, and unsafe local admin contexts.", advanced: true },
  { key: "TELEGRAM_UI_FALLBACK_AUTH_ENABLED", label: "Enable Fallback Auth", category: "miniapp", type: "boolean", defaultVal: true, description: "Enable admin fallback PIN/password auth for recovering access when Telegram/session token auth is unavailable.", restart: false },
  { key: "TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_IP_PER_MIN", label: "Fallback Per-IP Limit", category: "miniapp", type: "number", defaultVal: 10, min: 1, max: 200, unit: "req/min", description: "Per-IP rate limit for fallback auth attempts.", advanced: true },
  { key: "TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_GLOBAL_PER_MIN", label: "Fallback Global Limit", category: "miniapp", type: "number", defaultVal: 60, min: 1, max: 500, unit: "req/min", description: "Global rate limit for fallback auth attempts.", advanced: true },
  { key: "TELEGRAM_UI_FALLBACK_AUTH_MAX_FAILURES", label: "Fallback Max Failures", category: "miniapp", type: "number", defaultVal: 5, min: 1, max: 50, description: "Failed fallback auth attempts before temporary lockout.", advanced: true },
  { key: "TELEGRAM_UI_FALLBACK_AUTH_LOCKOUT_MS", label: "Fallback Lockout", category: "miniapp", type: "number", defaultVal: 600000, min: 10000, max: 86400000, unit: "ms", description: "Temporary lockout duration after too many failed fallback auth attempts.", advanced: true },
  { key: "TELEGRAM_UI_FALLBACK_AUTH_ROTATE_DAYS", label: "Fallback Rotate Days", category: "miniapp", type: "number", defaultVal: 30, min: 1, max: 365, unit: "days", description: "Rotation target for fallback auth credential.", advanced: true },
  { key: "TELEGRAM_UI_FALLBACK_AUTH_TRANSIENT_COOLDOWN_MS", label: "Fallback Cooldown", category: "miniapp", type: "number", defaultVal: 5000, min: 1000, max: 60000, unit: "ms", description: "Cooldown when fallback auth backend returns transient errors.", advanced: true },

  // ── Executor / AI ──────────────────────────────────────────
  { key: "BOSUN_AGENT_RUNTIME",           label: "Primary Agent Runtime",       category: "executor", type: "select", defaultVal: "harness", options: ["harness", "sdk-cli"], description: "Choose the main runtime Bosun should use for interactive sessions and agent execution. 'harness' uses the Bosun-native provider kernel, shared tools, and observability spine. 'sdk-cli' keeps the legacy shell and SDK stack as the primary runtime.", restart: true },
  { key: "BOSUN_HARNESS_ENABLED",         label: "Harness Control Plane Enabled", category: "executor", section: "Harness Control Plane", type: "boolean", defaultVal: true, description: "Turns on the Bosun-native harness control plane for provider-backed execution, shared tool orchestration, and first-class observability." },
  { key: "BOSUN_HARNESS_SOURCE",          label: "Harness Profile Source",      category: "executor", section: "Harness Control Plane", type: "string", description: "Path to the JSON or markdown-fenced JSON profile file that defines Bosun harness stages and control-plane behavior." },
  { key: "BOSUN_HARNESS_VALIDATION_MODE", label: "Harness Validation Policy",   category: "executor", section: "Harness Control Plane", type: "select", defaultVal: "report", options: ["off", "report", "enforce"], description: "off records compile output without blocking, report returns validation issues, and enforce blocks invalid harness compile or activate requests." },
  { key: "BOSUN_PROVIDER_DEFAULT",         label: "Fallback Provider Kernel Default",   category: "executor", section: "Harness Provider Fabric", type: "select", defaultVal: "openai-responses", options: ["openai-responses", "openai-codex-subscription", "azure-openai-responses", "anthropic-messages", "claude-subscription-shim", "openai-compatible", "ollama", "copilot-oauth", "openrouter", "perplexity", "deepinfra", "groq", "together", "xai", "fireworks", "cerebras", "sambanova", "nebius", "gemini-generate-content"], description: "Fallback provider family used only when a named Harness executor does not already define the runtime instance Bosun should use." },
  { key: "BOSUN_PROVIDER_ROUTING_MODE",    label: "Fallback Provider Kernel Routing",   category: "executor", section: "Harness Provider Fabric", type: "select", defaultVal: "default-only", options: ["default-only", "fallback", "spread"], description: "Fallback routing posture for the shared provider kernel. Named Harness executors above remain the preferred way to define actual chat-visible runtime instances." },
  { key: "BOSUN_PROVIDER_DEFAULT_MODEL",   label: "Fallback Provider Default Model",      category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional shared model default applied only when a provider or named Harness executor does not set its own default model.", advanced: true },
  { key: "INTERNAL_EXECUTOR_PARALLEL",     label: "Queued Task Slots",          category: "executor", section: "Queued Task Execution", type: "number", defaultVal: 3, min: 1, max: 20, description: "Maximum number of concurrent queued-task slots Bosun can run at once." },
  { key: "INTERNAL_EXECUTOR_TIMEOUT_MS",   label: "Queued Task Timeout",        category: "executor", section: "Queued Task Execution", type: "number", defaultVal: 5400000, min: 60000, max: 14400000, unit: "ms", description: "Maximum time a single queued task execution can run (default: 90 min)." },
  { key: "INTERNAL_EXECUTOR_MAX_RETRIES",  label: "Queued Task Retries",        category: "executor", section: "Queued Task Execution", type: "number", defaultVal: 2, min: 0, max: 10, description: "Number of automatic retries per queued task before marking it failed." },
  { key: "INTERNAL_EXECUTOR_POLL_MS",      label: "Queue Poll Interval",        category: "executor", section: "Queued Task Execution", type: "number", defaultVal: 30000, min: 5000, max: 300000, unit: "ms", description: "How often Bosun polls the task source for new queued work.", advanced: true },
  { key: "INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED", label: "Queued Review Agent", category: "executor", section: "Queued Task Execution", type: "boolean", defaultVal: true, description: "Enable automatic PR review handoff after queued task completion." },
  { key: "INTERNAL_EXECUTOR_REPLENISH_ENABLED", label: "Auto Replenish Backlog", category: "executor", section: "Queued Task Execution", type: "boolean", defaultVal: false, description: "Automatically generate new tasks when backlog is low." },
  { key: "INTERNAL_EXECUTOR_SDK",          label: "Queued Task SDK/CLI Family", category: "executor", section: "SDK/CLI Compatibility", type: "select", defaultVal: "auto", options: ["auto", "codex", "copilot", "claude", "gemini", "opencode"], description: "Legacy SDK family used for queued tasks only when the primary runtime is set to SDK/CLI." },
  { key: "PRIMARY_AGENT",                  label: "Primary SDK/CLI Runtime",    category: "executor", section: "SDK/CLI Compatibility", type: "select", defaultVal: "codex-sdk", options: ["codex-sdk", "copilot-sdk", "claude-sdk", "gemini-sdk", "opencode-sdk"], description: "Legacy compatibility transport used when Bosun runs in SDK/CLI mode." },
  { key: "CODEX_SDK_DISABLED",             label: "Disable Codex SDK",          category: "executor", type: "boolean", defaultVal: false, description: "When true, Codex SDK is unavailable for chat and will not appear in the executor picker.", restart: true },
  { key: "COPILOT_SDK_DISABLED",           label: "Disable Copilot SDK",        category: "executor", type: "boolean", defaultVal: false, description: "When true, Copilot SDK is unavailable for chat and will not appear in the executor picker.", restart: true },
  { key: "CLAUDE_SDK_DISABLED",            label: "Disable Claude SDK",         category: "executor", type: "boolean", defaultVal: false, description: "When true, Claude SDK is unavailable for chat and will not appear in the executor picker.", restart: true },
  { key: "GEMINI_SDK_DISABLED",            label: "Disable Gemini SDK",         category: "executor", type: "boolean", defaultVal: false, description: "When true, Gemini SDK is unavailable for chat and will not appear in the executor picker.", restart: true },
  { key: "OPENCODE_SDK_DISABLED",          label: "Disable OpenCode SDK",       category: "executor", type: "boolean", defaultVal: false, description: "When true, OpenCode SDK is unavailable for chat and will not appear in the executor picker.", restart: true },
  { key: "EXECUTORS",                      label: "SDK/CLI Routing Pool",       category: "executor", section: "SDK/CLI Compatibility", type: "string", defaultVal: "CODEX:DEFAULT:100", description: "Optional weighted pool for routing queued tasks across multiple SDK/CLI runtimes. Format: TYPE:VARIANT:WEIGHT[:MODEL|MODEL],... (e.g., CODEX:DEFAULT:70:gpt-5.2-codex|gpt-5.1-codex-mini,COPILOT:CLAUDE_OPUS_4_6:30:claude-opus-4.6). This does not configure harness providers.", validate: validateExecutorsPoolValue },
  { key: "EXECUTOR_DISTRIBUTION",          label: "SDK/CLI Routing Strategy",   category: "executor", section: "SDK/CLI Compatibility", type: "select", defaultVal: "weighted", options: ["weighted", "round-robin", "primary-only"], description: "How Bosun distributes queued tasks across the SDK/CLI routing pool.", advanced: true },
  { key: "FAILOVER_STRATEGY",              label: "SDK/CLI Failover",           category: "executor", section: "SDK/CLI Compatibility", type: "select", defaultVal: "next-in-line", options: ["next-in-line", "weighted-random", "round-robin"], description: "How Bosun selects the next SDK/CLI runtime when the preferred executor fails.", advanced: true },
  { key: "COMPLEXITY_ROUTING_ENABLED",     label: "SDK/CLI Complexity Routing", category: "executor", section: "SDK/CLI Compatibility", type: "boolean", defaultVal: true, description: "Automatically route queued SDK/CLI tasks to different model families based on estimated complexity.", advanced: true },
  { key: "PROJECT_REQUIREMENTS_PROFILE",   label: "Planning Requirements Profile", category: "executor", section: "Queued Task Execution", type: "select", defaultVal: "feature", options: ["simple-feature", "feature", "large-feature", "system", "multi-system"], description: "Project complexity profile for task generation and planning." },

  // ── AI Provider Keys ────────────────────────────────────────
  { key: "OPENAI_API_KEY",                 label: "OpenAI API Key",             category: "executor", section: "Harness Provider Credentials", type: "secret", sensitive: true, description: "OpenAI API key used by OpenAI Responses and any OpenAI-backed Bosun integrations that require manual credentials." },
  { key: "AZURE_OPENAI_API_KEY",           label: "Azure OpenAI API Key",       category: "executor", section: "Harness Provider Credentials", type: "secret", sensitive: true, description: "Azure OpenAI API key used when Azure OpenAI Responses runs in key-based mode." },
  { key: "CODEX_MODEL",                    label: "Codex Model",                category: "executor", type: "string", defaultVal: "gpt-4o", description: "Model for Codex SDK. E.g., gpt-4o, o3, o4-mini." },
  { key: "CODEX_MODEL_PROFILE",            label: "Active Model Profile",       category: "executor", type: "select", defaultVal: "xl", options: ["xl", "m"], description: "Select active Codex model profile for runtime sessions." },
  { key: "CODEX_MODEL_PROFILE_SUBAGENT",   label: "Subagent Profile",           category: "executor", type: "select", defaultVal: "m", options: ["xl", "m"], description: "Default profile to prefer for subagent-style delegated work." },
  { key: "CODEX_MODEL_PROFILE_XL_PROVIDER", label: "XL Provider",               category: "executor", type: "select", defaultVal: "openai", options: ["openai", "azure", "compatible"], description: "Provider for XL profile." },
  { key: "CODEX_MODEL_PROFILE_XL_MODEL",   label: "XL Model",                   category: "executor", type: "string", defaultVal: "gpt-5.3-codex", description: "Model/deployment name for XL profile." },
  { key: "CODEX_MODEL_PROFILE_XL_BASE_URL", label: "XL Base URL",               category: "executor", type: "string", description: "Optional base URL override for XL profile.", validate: "^$|^https?://" },
  { key: "CODEX_MODEL_PROFILE_XL_API_KEY", label: "XL API Key",                 category: "executor", type: "secret", sensitive: true, description: "Optional profile-scoped API key for XL profile." },
  { key: "CODEX_MODEL_PROFILE_M_PROVIDER", label: "M Provider",                 category: "executor", type: "select", defaultVal: "openai", options: ["openai", "azure", "compatible"], description: "Provider for M profile." },
  { key: "CODEX_MODEL_PROFILE_M_MODEL",    label: "M Model",                    category: "executor", type: "string", defaultVal: "gpt-5.1-codex-mini", description: "Model/deployment name for M profile." },
  { key: "CODEX_MODEL_PROFILE_M_BASE_URL", label: "M Base URL",                 category: "executor", type: "string", description: "Optional base URL override for M profile.", validate: "^$|^https?://" },
  { key: "CODEX_MODEL_PROFILE_M_API_KEY", label: "M API Key",                  category: "executor", type: "secret", sensitive: true, description: "Optional profile-scoped API key for M profile." },
  { key: "CODEX_SUBAGENT_MODEL",           label: "Subagent Model",             category: "executor", type: "string", defaultVal: "gpt-5.1-codex-mini", description: "Preferred lightweight model for delegated/subagent work." },
  { key: "ANTHROPIC_API_KEY",              label: "Anthropic API Key",          category: "executor", section: "Harness Provider Credentials", type: "secret", sensitive: true, description: "Anthropic API key used by the Anthropic Messages provider and any Anthropic-backed Bosun integrations that require manual credentials." },
  { key: "CLAUDE_MODEL",                   label: "Claude Model",               category: "executor", type: "string", defaultVal: "claude-opus-4-6", description: "Model for Claude SDK. E.g., claude-opus-4-6, claude-sonnet-4.6, claude-haiku-4.5." },
  { key: "GEMINI_API_KEY",                 label: "Gemini API Key",             category: "executor", section: "Harness Provider Credentials", type: "secret", sensitive: true, description: "Google AI Studio key used by Gemini integrations when manual credentials are required (alternative: GOOGLE_API_KEY)." },
  { key: "GOOGLE_API_KEY",                 label: "Google API Key",             category: "executor", section: "Harness Provider Credentials", type: "secret", sensitive: true, description: "Alternative Google API key env used by Gemini integrations." },
  { key: "GEMINI_MODEL",                   label: "Gemini Model",               category: "executor", type: "string", defaultVal: "gemini-3.1-pro", description: "Model for Gemini SDK sessions (for example gemini-3.1-pro)." },
  { key: "GEMINI_TRANSPORT",               label: "Gemini Transport",           category: "executor", type: "select", defaultVal: "auto", options: ["auto", "sdk", "cli"], description: "Gemini adapter transport. 'auto' uses SDK then falls back to CLI." },
  { key: "OPENCODE_MODEL",                 label: "OpenCode Model",             category: "executor", type: "string", defaultVal: "gpt-5.2-codex", description: "Model override passed to OpenCode sessions." },
  { key: "COPILOT_MODEL",                  label: "Copilot Model",              category: "executor", type: "string", defaultVal: "gpt-5", description: "Model for Copilot SDK sessions." },
  { key: "COPILOT_CLI_TOKEN",              label: "Copilot CLI Token",          category: "executor", type: "secret", sensitive: true, description: "Auth token for Copilot CLI remote mode." },

  // ── Harness Provider Kernel ────────────────────────────────
  { key: "BOSUN_PROVIDER_OPENAI_RESPONSES_ENABLED", label: "Enable OpenAI Responses", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: true, description: "Enable the OpenAI Responses provider in the Bosun harness." },
  { key: "BOSUN_PROVIDER_OPENAI_RESPONSES_MODEL", label: "OpenAI Responses Model", category: "executor", section: "Harness Provider Fabric", type: "string", defaultVal: "gpt-5.4", description: "Default model for the OpenAI Responses provider.", advanced: true },
  { key: "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED", label: "Enable ChatGPT Codex Subscription", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the ChatGPT Codex subscription provider path." },
  { key: "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_MODE", label: "ChatGPT Codex Auth Mode", category: "executor", section: "Harness Provider Fabric", type: "select", defaultVal: "subscription", options: ["subscription", "oauth", "apiKey"], description: "Preferred auth mode for the ChatGPT Codex subscription provider." },
  { key: "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_MODEL", label: "ChatGPT Codex Model", category: "executor", section: "Harness Provider Fabric", type: "string", defaultVal: "gpt-5.4", description: "Default model for the ChatGPT Codex subscription provider.", advanced: true },
  { key: "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_WORKSPACE", label: "ChatGPT Codex Workspace", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional ChatGPT Codex workspace or organization scope for subscription routing." },
  { key: "BOSUN_PROVIDER_AZURE_OPENAI_ENABLED", label: "Enable Azure OpenAI Responses", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the Azure OpenAI Responses provider path." },
  { key: "BOSUN_PROVIDER_AZURE_OPENAI_MODE", label: "Azure Auth Mode", category: "executor", section: "Harness Provider Fabric", type: "select", defaultVal: "apiKey", options: ["apiKey", "oauth"], description: "Preferred auth mode for Azure OpenAI Responses." },
  { key: "BOSUN_PROVIDER_AZURE_OPENAI_MODEL", label: "Azure Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", defaultVal: "gpt-5.4", description: "Default model for Azure OpenAI Responses.", advanced: true },
  { key: "BOSUN_PROVIDER_AZURE_OPENAI_ENDPOINT", label: "Azure Endpoint", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Azure OpenAI endpoint URL.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_AZURE_OPENAI_DEPLOYMENT", label: "Azure Deployment", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Azure OpenAI deployment name." },
  { key: "BOSUN_PROVIDER_AZURE_OPENAI_API_VERSION", label: "Azure API Version", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Azure OpenAI API version override.", advanced: true },
  { key: "BOSUN_PROVIDER_ANTHROPIC_ENABLED", label: "Enable Anthropic Messages", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: true, description: "Enable the Anthropic Messages provider." },
  { key: "BOSUN_PROVIDER_ANTHROPIC_MODEL", label: "Anthropic Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", defaultVal: "claude-opus-4.1", description: "Default model for the Anthropic Messages provider.", advanced: true },
  { key: "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_ENABLED", label: "Enable Claude Subscription Shim", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the Claude subscription shim provider path." },
  { key: "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_MODE", label: "Claude Subscription Auth", category: "executor", section: "Harness Provider Fabric", type: "select", defaultVal: "subscription", options: ["subscription", "oauth"], description: "Preferred auth mode for the Claude subscription provider." },
  { key: "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_MODEL", label: "Claude Subscription Model", category: "executor", section: "Harness Provider Fabric", type: "string", defaultVal: "claude-opus-4.1", description: "Default model for the Claude subscription provider.", advanced: true },
  { key: "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_WORKSPACE", label: "Claude Subscription Workspace", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional Claude subscription workspace or organization scope for subscription routing." },
  { key: "BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED", label: "Enable OpenAI-Compatible Endpoint", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable a custom OpenAI-compatible provider endpoint." },
  { key: "BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODE", label: "Compatible Auth Mode", category: "executor", section: "Harness Provider Fabric", type: "select", defaultVal: "apiKey", options: ["apiKey", "local"], description: "Preferred auth mode for the OpenAI-compatible provider." },
  { key: "BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODEL", label: "Compatible Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Default model for the OpenAI-compatible provider.", advanced: true },
  { key: "BOSUN_PROVIDER_OPENAI_COMPATIBLE_BASE_URL", label: "Compatible Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Base URL for the OpenAI-compatible endpoint.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_OLLAMA_ENABLED", label: "Enable Ollama", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the local Ollama provider." },
  { key: "BOSUN_PROVIDER_OLLAMA_MODEL", label: "Ollama Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", defaultVal: "qwen2.5-coder:latest", description: "Default model for the Ollama provider.", advanced: true },
  { key: "BOSUN_PROVIDER_OLLAMA_BASE_URL", label: "Ollama Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional base URL override for Ollama.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_COPILOT_OAUTH_ENABLED", label: "Enable GitHub Copilot OAuth", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the GitHub Copilot OAuth provider path." },
  { key: "BOSUN_PROVIDER_COPILOT_OAUTH_MODEL", label: "Copilot OAuth Model", category: "executor", section: "Harness Provider Fabric", type: "string", defaultVal: "gpt-4o", description: "Default model for the Copilot OAuth provider.", advanced: true },
  { key: "BOSUN_PROVIDER_OPENROUTER_ENABLED", label: "Enable OpenRouter", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the Bosun-native OpenRouter provider path." },
  { key: "BOSUN_PROVIDER_OPENROUTER_MODEL", label: "OpenRouter Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Default model for OpenRouter.", advanced: true },
  { key: "BOSUN_PROVIDER_OPENROUTER_BASE_URL", label: "OpenRouter Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional OpenRouter base URL override.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_PERPLEXITY_ENABLED", label: "Enable Perplexity", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the Bosun-native Perplexity provider path." },
  { key: "BOSUN_PROVIDER_PERPLEXITY_MODEL", label: "Perplexity Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", defaultVal: "sonar-pro", description: "Default model for Perplexity.", advanced: true },
  { key: "BOSUN_PROVIDER_PERPLEXITY_BASE_URL", label: "Perplexity Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional Perplexity base URL override.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_DEEPINFRA_ENABLED", label: "Enable DeepInfra", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the Bosun-native DeepInfra provider path." },
  { key: "BOSUN_PROVIDER_DEEPINFRA_MODEL", label: "DeepInfra Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Default model for DeepInfra.", advanced: true },
  { key: "BOSUN_PROVIDER_DEEPINFRA_BASE_URL", label: "DeepInfra Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional DeepInfra base URL override.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_GROQ_ENABLED", label: "Enable Groq", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the Bosun-native Groq provider path." },
  { key: "BOSUN_PROVIDER_GROQ_MODEL", label: "Groq Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Default model for Groq.", advanced: true },
  { key: "BOSUN_PROVIDER_GROQ_BASE_URL", label: "Groq Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional Groq base URL override.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_TOGETHER_ENABLED", label: "Enable Together", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the Bosun-native Together provider path." },
  { key: "BOSUN_PROVIDER_TOGETHER_MODEL", label: "Together Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Default model for Together.", advanced: true },
  { key: "BOSUN_PROVIDER_TOGETHER_BASE_URL", label: "Together Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional Together base URL override.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_XAI_ENABLED", label: "Enable xAI", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the Bosun-native xAI provider path." },
  { key: "BOSUN_PROVIDER_XAI_MODEL", label: "xAI Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Default model for xAI.", advanced: true },
  { key: "BOSUN_PROVIDER_XAI_BASE_URL", label: "xAI Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional xAI base URL override.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_FIREWORKS_ENABLED", label: "Enable Fireworks AI", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the Bosun-native Fireworks AI provider path." },
  { key: "BOSUN_PROVIDER_FIREWORKS_MODEL", label: "Fireworks Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Default model for Fireworks AI.", advanced: true },
  { key: "BOSUN_PROVIDER_FIREWORKS_BASE_URL", label: "Fireworks Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional Fireworks AI base URL override.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_CEREBRAS_ENABLED", label: "Enable Cerebras", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the Bosun-native Cerebras provider path." },
  { key: "BOSUN_PROVIDER_CEREBRAS_MODEL", label: "Cerebras Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Default model for Cerebras.", advanced: true },
  { key: "BOSUN_PROVIDER_CEREBRAS_BASE_URL", label: "Cerebras Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional Cerebras base URL override.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_SAMBANOVA_ENABLED", label: "Enable SambaNova", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the Bosun-native SambaNova provider path." },
  { key: "BOSUN_PROVIDER_SAMBANOVA_MODEL", label: "SambaNova Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Default model for SambaNova.", advanced: true },
  { key: "BOSUN_PROVIDER_SAMBANOVA_BASE_URL", label: "SambaNova Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional SambaNova base URL override.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_NEBIUS_ENABLED", label: "Enable Nebius", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: false, description: "Enable the Bosun-native Nebius provider path." },
  { key: "BOSUN_PROVIDER_NEBIUS_MODEL", label: "Nebius Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Default model for Nebius.", advanced: true },
  { key: "BOSUN_PROVIDER_NEBIUS_BASE_URL", label: "Nebius Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional Nebius base URL override.", validate: "^$|^https?://" },
  { key: "BOSUN_PROVIDER_GEMINI_ENABLED", label: "Enable Gemini Generate Content", category: "executor", section: "Harness Provider Fabric", type: "boolean", defaultVal: true, description: "Enable the Bosun-native Gemini provider path." },
  { key: "BOSUN_PROVIDER_GEMINI_MODEL", label: "Gemini Default Model", category: "executor", section: "Harness Provider Fabric", type: "string", defaultVal: "gemini-2.5-pro", description: "Default model for Gemini Generate Content.", advanced: true },
  { key: "BOSUN_PROVIDER_GEMINI_BASE_URL", label: "Gemini Base URL", category: "executor", section: "Harness Provider Fabric", type: "string", description: "Optional Gemini base URL override.", validate: "^$|^https?://" },

  // ── Voice Assistant ──────────────────────────────────────────
  { key: "VOICE_ENABLED",                  label: "Enable Voice Mode",          category: "voice", type: "boolean", defaultVal: true, description: "Enable the real-time voice assistant in the chat UI." },
  { key: "VOICE_TURN_DETECTION",           label: "Turn Detection",             category: "voice", type: "select", defaultVal: "semantic_vad", options: ["server_vad", "semantic_vad", "none"], description: "How the model detects when you stop speaking. 'semantic_vad' is more intelligent but higher latency." },
  { key: "VOICE_TRANSCRIPTION_ENABLED",    label: "Input Transcription Enabled", category: "voice", type: "boolean", defaultVal: true, description: "Enable per-turn input audio transcription for OpenAI-compatible realtime sessions." },
  { key: "VOICE_TRANSCRIPTION_MODEL",      label: "Input Transcription Model",  category: "voice", type: "string", defaultVal: "gpt-4o-transcribe", description: "Model used for input audio transcription when transcription is enabled." },
  { key: "VOICE_AZURE_TRANSCRIPTION_ENABLED", label: "Azure Input Transcription", category: "voice", type: "boolean", defaultVal: false, description: "Enable input transcription specifically for Azure realtime sessions. Disabled by default to avoid Azure per-item transcription failures." },
  { key: "VOICE_DELEGATE_EXECUTOR",        label: "Delegate Executor",          category: "voice", type: "select", defaultVal: "codex-sdk", options: ["codex-sdk", "copilot-sdk", "claude-sdk", "gemini-sdk", "opencode-sdk"], description: "Which agent executor voice tool calls delegate to for complex tasks." },
  { key: "VOICE_FALLBACK_MODE",            label: "Fallback Mode",              category: "voice", type: "select", defaultVal: "browser", options: ["browser", "disabled"], description: "When Tier 1 (Realtime API) is unavailable, use browser speech APIs as fallback." },

  // ── Kanban / Tasks ─────────────────────────────────────────
  { key: "KANBAN_BACKEND",                 label: "Kanban Backend",             category: "kanban", type: "select", defaultVal: "internal", options: ["internal", "github", "jira", "repo-mirror"], description: "Task management backend. 'internal' uses the built-in store, 'github' syncs with GitHub Issues/Projects, 'jira' uses Jira, and 'repo-mirror' enables the optional RepoMirror projection backend." },
  { key: "KANBAN_SYNC_POLICY",             label: "Sync Policy",                category: "kanban", type: "select", defaultVal: "internal-primary", options: ["internal-primary", "bidirectional"], description: "How tasks sync between internal store and external backend." },
  { key: "REPO_MIRROR_ENABLED",            label: "Enable RepoMirror",                category: "kanban", type: "boolean", defaultVal: false, description: "Master toggle for the optional RepoMirror backend. Must be enabled before KANBAN_BACKEND can be switched to repo-mirror." },
  { key: "REPO_MIRROR_REPO_PATH",          label: "RepoMirror Repo Path",             category: "kanban", type: "string", description: "Absolute path to the repo or clone that will host RepoMirror projection data. Required when RepoMirror is selected." },
  { key: "REPO_MIRROR_SYNC_MODE",          label: "RepoMirror Sync Mode",             category: "kanban", type: "select", defaultVal: "projection", options: ["projection"], description: "Projection-only RepoMirror mode. Bosun keeps live claims, heartbeats, transcripts, and artifacts in private storage." },
  { key: "REPO_MIRROR_RUN_STORAGE",        label: "RepoMirror Run Storage",           category: "kanban", type: "select", defaultVal: "git", options: ["git", "local"], description: "Where RepoMirror run metadata is stored when projection export is active. 'git' matches RepoMirror-style audit history; 'local' keeps it private." },
  { key: "REPO_MIRROR_MESSAGE_STORAGE",    label: "RepoMirror Message Storage",       category: "kanban", type: "select", defaultVal: "off", options: ["off", "git", "local"], description: "Where RepoMirror message projections are stored. 'off' keeps agent-to-agent messages private by default." },
  { key: "REPO_MIRROR_PUBLIC_ROADMAP_ENABLED", label: "Public RepoMirror Roadmap",        category: "kanban", type: "boolean", defaultVal: false, description: "Allow sanitized RepoMirror roadmap projection for shared visibility. Disabled by default." },
  { key: "BOSUN_TASK_LABEL",       label: "Task Label",                 category: "kanban", type: "string", defaultVal: "bosun", description: "GitHub label used to scope which issues are managed by Bosun." },
  { key: "BOSUN_ENFORCE_TASK_LABEL", label: "Enforce Task Label",       category: "kanban", type: "boolean", defaultVal: true, description: "Only pick up issues that have the task label. Prevents processing unrelated issues." },
  { key: "STALE_TASK_AGE_HOURS",           label: "Stale Task Age",             category: "kanban", type: "number", defaultVal: 3, min: 1, max: 168, unit: "hours", description: "Hours before an in-progress task with no activity is considered stale and eligible for recovery." },
  { key: "TASK_PLANNER_MODE",              label: "Task Planner Mode",          category: "kanban", type: "select", defaultVal: "kanban", options: ["kanban", "codex-sdk", "disabled"], description: "How the autonomous task planner operates. 'disabled' turns off automatic task generation." },
  { key: "TASK_TRIGGER_SYSTEM_ENABLED",    label: "Trigger System",             category: "kanban", type: "boolean", defaultVal: false, description: "Enable configurable trigger-based task templates. Built-ins are disabled by default until explicitly turned on." },
  { key: "TASK_PLANNER_DEDUP_HOURS",       label: "Planner Dedup Window",       category: "kanban", type: "number", defaultVal: 6, min: 1, max: 72, unit: "hours", description: "Hours to look back for duplicate task detection.", advanced: true },

  // ── Branch Strategy ──────────────────────────────────────────────────
  { key: "TASK_BRANCH_MODE",               label: "Branch Mode",                 category: "branching", type: "select", defaultVal: "worktree", options: ["worktree", "direct"], description: "worktree: agents use isolated ve/<id>-<slug> sub-branches that PR into the module/base branch (default). direct: agents push directly onto the module branch — sequential, real-time conflict resolution.", restart: true },
  { key: "TASK_BRANCH_AUTO_MODULE",        label: "Auto Module Branch",          category: "branching", type: "boolean", defaultVal: true, description: "Automatically detect origin/<module> as base_branch from conventional commit titles (e.g. feat(veid): → origin/veid). Enables parallel branch-per-module strategy." },
  { key: "MODULE_BRANCH_PREFIX",           label: "Module Branch Prefix",        category: "branching", type: "string", defaultVal: "origin/", description: "Prefix prepended to module scope when building module branch refs (default: origin/).", advanced: true },
  { key: "DEFAULT_TARGET_BRANCH",          label: "Default Target Branch",       category: "branching", type: "string", defaultVal: "main", description: "The main upstream branch agents sync with before pushing (e.g. main). Used for upstream sync and PR base detection." },
  { key: "TASK_UPSTREAM_SYNC_MAIN",        label: "Upstream Main Sync",          category: "branching", type: "boolean", defaultVal: true, description: "Before each push, merge origin/main into the task branch to keep it continuously in sync with upstream. If a conflict occurs, it is aborted and the next agent on the branch resolves it." },
  { key: "BOSUN_PROMPT_PLANNER",  label: "Planner Prompt Path",         category: "advanced", type: "string", description: "Override the task planner prompt file path.", advanced: true },

  // ── Logging / Telemetry ──────────────────────────────────────
  { key: "BOSUN_TELEMETRY_SAMPLE_RATE",    label: "Telemetry Sample Rate",      category: "logging", type: "number", defaultVal: 1, min: 0, max: 1, description: "Sampling rate for high-volume telemetry events (agent_output/tool events). 1 = full, 0.1 = 10% sample.", advanced: true },
  { key: "AGENT_WORK_STREAM_RETENTION_DAYS", label: "Stream Retention",         category: "logging", type: "number", defaultVal: 30, min: 1, max: 365, unit: "days", description: "How long to keep agent-work stream logs before rotation.", advanced: true },
  { key: "AGENT_WORK_ERROR_RETENTION_DAYS",  label: "Error Retention",          category: "logging", type: "number", defaultVal: 90, min: 1, max: 365, unit: "days", description: "How long to keep error logs before rotation.", advanced: true },
  { key: "AGENT_WORK_SESSION_RETENTION_COUNT", label: "Session Retention Count", category: "logging", type: "number", defaultVal: 100, min: 10, max: 10000, description: "Number of session log files to keep.", advanced: true },
  { key: "AGENT_WORK_ARCHIVE_RETENTION_DAYS", label: "Archive Retention",       category: "logging", type: "number", defaultVal: 180, min: 30, max: 3650, unit: "days", description: "Retention window for compressed log archives.", advanced: true },
  { key: "AGENT_WORK_METRICS_ROTATION_ENABLED", label: "Rotate Metrics Log",    category: "logging", type: "boolean", defaultVal: true, description: "Rotate metrics log monthly to keep file size bounded.", advanced: true },

  // ── GitHub / Git ─────────────────────────────────────────
  { key: "GITHUB_TOKEN",                   label: "GitHub Token",               category: "github", type: "secret", sensitive: true, description: "Personal access token or fine-grained token for GitHub API. Required for GitHub kanban backend." },
  { key: "BOSUN_GITHUB_CLIENT_ID",         label: "GitHub OAuth Client ID",     category: "github", type: "string", description: "OAuth client ID used for GitHub device flow sign-in in the Bosun portal." },
  { key: "BOSUN_GITHUB_CLIENT_SECRET",     label: "GitHub OAuth Client Secret", category: "github", type: "secret", sensitive: true, description: "OAuth client secret used for GitHub web callback exchange.", advanced: true },
  { key: "BOSUN_GITHUB_APP_ID",            label: "GitHub App ID",              category: "github", type: "string", description: "Numeric Bosun GitHub App ID used for installation token auth.", advanced: true },
  { key: "BOSUN_GITHUB_PRIVATE_KEY_PATH",  label: "GitHub App Private Key",     category: "github", type: "string", description: "Absolute path to the Bosun GitHub App .pem private key.", advanced: true },
  { key: "BOSUN_GITHUB_WEBHOOK_SECRET",    label: "GitHub App Webhook Secret",  category: "github", type: "secret", sensitive: true, description: "Webhook HMAC secret for validating GitHub App webhook deliveries.", advanced: true },
  { key: "BOSUN_GITHUB_USER_TOKEN",        label: "GitHub User Token Override", category: "github", type: "secret", sensitive: true, description: "Optional direct OAuth user token override (skips auth-state lookup).", advanced: true },
  { key: "GITHUB_REPOSITORY",              label: "Repository",                 category: "github", type: "string", description: "GitHub repository in owner/repo format. Auto-detected from git remote if not set.", validate: "^[\\w.-]+/[\\w.-]+$" },
  { key: "GITHUB_PROJECT_MODE",            label: "Project Mode",               category: "github", type: "select", defaultVal: "issues", options: ["issues", "kanban"], description: "Use GitHub Issues directly, or GitHub Projects v2 kanban board." },
  { key: "GITHUB_PROJECT_NUMBER",          label: "Project Number",             category: "github", type: "number", min: 1, description: "GitHub Projects v2 number. Required when project mode is 'kanban'." },
  { key: "GITHUB_PROJECT_WEBHOOK_PATH",    label: "Project Webhook Path",       category: "github", type: "string", description: "HTTP path exposed by the UI server for GitHub webhook deliveries.", validate: "^/.*", advanced: true },
  { key: "GITHUB_PROJECT_WEBHOOK_SECRET",  label: "Project Webhook Secret",     category: "github", type: "secret", sensitive: true, description: "Shared secret to validate GitHub webhook signatures.", advanced: true },
  { key: "GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE", label: "Require Webhook Signature", category: "github", type: "boolean", defaultVal: false, description: "Reject webhook payloads unless signature validation succeeds.", advanced: true },
  { key: "GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD", label: "Sync Failure Alert Threshold", category: "github", type: "number", defaultVal: 3, min: 1, max: 20, description: "Consecutive project sync failures that trigger an alert.", advanced: true },
  { key: "GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD", label: "Rate Limit Alert Threshold", category: "github", type: "number", defaultVal: 3, min: 1, max: 20, description: "Rate-limit events before triggering an alert.", advanced: true },
  { key: "GITHUB_DEFAULT_ASSIGNEE",        label: "Default Assignee",           category: "github", type: "string", description: "GitHub username to assign new issues to. Uses authenticated user if not set." },
  { key: "GITHUB_AUTO_ASSIGN_CREATOR",     label: "Auto-Assign Creator",        category: "github", type: "boolean", defaultVal: true, description: "Automatically assign the authenticated user when creating issues." },
  { key: "BOSUN_TARGET_BRANCH",            label: "Target Branch",              category: "github", type: "string", defaultVal: "origin/main", description: "Default base branch for PR comparisons and merge targets." },
  { key: "CODEX_ANALYZE_MERGE_STRATEGY",   label: "Merge Analysis",             category: "github", type: "boolean", defaultVal: true, description: "Enable intelligent merge strategy analysis for PRs." },
  { key: "DEPENDABOT_AUTO_MERGE",          label: "Dependabot Auto-Merge",      category: "github", type: "boolean", defaultVal: true, description: "Automatically merge passing Dependabot PRs." },
  { key: "GH_RECONCILE_ENABLED",           label: "Issue Reconciler",           category: "github", type: "boolean", defaultVal: true, description: "Auto-close issues when their associated PR is merged." },

  // ── Network / Tunnel ──────────────────────────────────────
  { key: "CLOUDFLARE_TUNNEL_NAME",         label: "Tunnel Name",                category: "network", type: "string", description: "Named Cloudflare tunnel for persistent URL. Leave empty for random quick tunnel." },
  { key: "CLOUDFLARE_TUNNEL_CREDENTIALS",  label: "Tunnel Credentials",         category: "network", type: "secret", sensitive: true, description: "Path to Cloudflare tunnel credentials JSON file." },
  { key: "CLOUDFLARE_BASE_DOMAIN",         label: "Base Domain",                category: "network", type: "string", description: "Base domain for deterministic per-user hostnames (for example bosun.det.io)." },
  { key: "CLOUDFLARE_TUNNEL_HOSTNAME",     label: "Explicit Hostname",          category: "network", type: "string", description: "Optional explicit hostname override (for example jon.bosun.det.io)." },
  { key: "CLOUDFLARE_USERNAME_HOSTNAME_POLICY", label: "Hostname Policy",       category: "network", type: "select", defaultVal: "per-user-fixed", options: ["per-user-fixed", "fixed"], description: "per-user-fixed creates stable hostname per workstation user. fixed uses shared CLOUDFLARE_FIXED_HOST_LABEL.", advanced: true },
  { key: "CLOUDFLARE_ZONE_ID",             label: "Zone ID",                    category: "network", type: "string", description: "Cloudflare zone ID used by DNS orchestration API client.", advanced: true },
  { key: "CLOUDFLARE_API_TOKEN",           label: "API Token",                  category: "network", type: "secret", sensitive: true, description: "Cloudflare API token scoped to Zone DNS edit for the configured zone.", advanced: true },
  { key: "CLOUDFLARE_DNS_SYNC_ENABLED",    label: "DNS Sync Enabled",           category: "network", type: "boolean", defaultVal: true, description: "Enable idempotent Cloudflare DNS create/verify/update for the named tunnel hostname.", advanced: true },
  { key: "CLOUDFLARE_DNS_MAX_RETRIES",     label: "DNS Retry Count",            category: "network", type: "number", defaultVal: 3, min: 1, max: 8, description: "Retry attempts for Cloudflare DNS API operations.", advanced: true },
  { key: "CLOUDFLARE_DNS_RETRY_BASE_MS",   label: "DNS Retry Base",             category: "network", type: "number", defaultVal: 750, min: 100, max: 5000, unit: "ms", description: "Base delay for Cloudflare DNS API retry backoff.", advanced: true },
  { key: "TELEGRAM_PRESENCE_INTERVAL_SEC", label: "Presence Interval",          category: "network", type: "number", defaultVal: 60, min: 10, max: 600, unit: "sec", description: "How often this instance announces its presence to the coordinator." },
  { key: "TELEGRAM_PRESENCE_DISABLED",     label: "Disable Presence",           category: "network", type: "boolean", defaultVal: false, description: "Disable multi-instance presence entirely." },
  { key: "VE_INSTANCE_LABEL",              label: "Instance Label",             category: "network", type: "string", description: "Human-friendly name for this instance in multi-instance setups." },
  { key: "VE_COORDINATOR_ELIGIBLE",        label: "Coordinator Eligible",       category: "network", type: "boolean", defaultVal: true, description: "Whether this instance can be elected as coordinator in multi-instance mode." },
  { key: "VE_COORDINATOR_PRIORITY",        label: "Coordinator Priority",       category: "network", type: "number", defaultVal: 10, min: 1, max: 100, description: "Lower value = higher priority in coordinator election." },
  { key: "FLEET_ENABLED",                  label: "Fleet Enabled",              category: "network", type: "boolean", defaultVal: true, description: "Enable multi-workstation fleet coordination.", advanced: true },
  { key: "FLEET_BUFFER_MULTIPLIER",        label: "Fleet Buffer Multiplier",    category: "network", type: "number", defaultVal: 3, min: 1, unit: "x", description: "Scale the planning buffer when coordinating across instances.", advanced: true },
  { key: "FLEET_SYNC_INTERVAL_MS",         label: "Fleet Sync Interval",        category: "network", type: "number", defaultVal: 120000, min: 10000, max: 3600000, unit: "ms", description: "How often fleet state is synced across instances.", advanced: true },
  { key: "FLEET_PRESENCE_TTL_MS",          label: "Fleet Presence TTL",         category: "network", type: "number", defaultVal: 300000, min: 60000, max: 3600000, unit: "ms", description: "Time before a fleet instance is considered offline.", advanced: true },
  { key: "FLEET_KNOWLEDGE_ENABLED",        label: "Fleet Knowledge Enabled",    category: "network", type: "boolean", defaultVal: true, description: "Share local knowledge files across the fleet.", advanced: true },
  { key: "FLEET_KNOWLEDGE_FILE",           label: "Fleet Knowledge File",       category: "network", type: "string", defaultVal: "AGENTS.md", description: "Knowledge file name to share across fleet members.", advanced: true },

  // ── Security / Sandbox ────────────────────────────────────
  { key: "CODEX_SANDBOX",                  label: "Sandbox Mode",               category: "security", type: "select", defaultVal: "workspace-write", options: ["workspace-write", "danger-full-access", "read-only"], description: "Agent filesystem access level. 'workspace-write' is permissive within workspace while avoiding full host access." },
  { key: "CODEX_FEATURES_BWRAP",           label: "Bubblewrap Sandbox",          category: "security", type: "boolean", defaultVal: true, description: "Enable Linux bubblewrap sandbox. Disable if user namespaces are blocked (bwrap uid map errors)." },
  { key: "CODEX_SANDBOX_PERMISSIONS",      label: "Sandbox Permissions",         category: "security", type: "string", defaultVal: "disk-full-write-access", description: "Comma-separated sandbox permission entries for Codex CLI config." },
  { key: "CODEX_SANDBOX_WRITABLE_ROOTS",   label: "Writable Roots",              category: "security", type: "string", description: "Comma-separated writable roots for workspace-write sandbox (include repo/.git as needed)." },
  { key: "CONTAINER_ENABLED",              label: "Container Isolation",        category: "security", type: "boolean", defaultVal: false, description: "Run agent tasks inside Docker/Podman containers for OS-level isolation.", restart: true },
  { key: "CONTAINER_RUNTIME",              label: "Container Runtime",          category: "security", type: "select", defaultVal: "docker", options: ["auto", "docker", "podman", "container"], description: "Container engine to use for isolated execution." },
  { key: "CONTAINER_IMAGE",                label: "Container Image",            category: "security", type: "string", defaultVal: "node:22-slim", description: "Docker image for agent execution containers." },
  { key: "CONTAINER_TIMEOUT_MS",           label: "Container Timeout",          category: "security", type: "number", defaultVal: 1800000, min: 60000, max: 7200000, unit: "ms", description: "Maximum time a container can run before being killed (default: 30 min)." },
  { key: "MAX_CONCURRENT_CONTAINERS",      label: "Max Containers",             category: "security", type: "number", defaultVal: 3, min: 1, max: 10, description: "Maximum number of concurrent agent containers." },
  { key: "CONTAINER_MEMORY_LIMIT",         label: "Memory Limit",               category: "security", type: "string", description: "Container memory limit (e.g., '4g', '2048m'). Leave empty for no limit.", validate: "^\\d+[kmg]?$" },
  { key: "CONTAINER_CPU_LIMIT",            label: "CPU Limit",                  category: "security", type: "string", description: "Container CPU limit (e.g., '2', '1.5'). Leave empty for no limit.", validate: "^\\d+\\.?\\d*$" },

  // ── Sentinel / Reliability ─────────────────────────────────
  { key: "BOSUN_SENTINEL_AUTO_START", label: "Auto-Start Sentinel",     category: "sentinel", type: "boolean", defaultVal: false, description: "Automatically start the sentinel watchdog on boot." },
  { key: "SENTINEL_AUTO_RESTART_MONITOR",  label: "Auto-Restart on Crash",      category: "sentinel", type: "boolean", defaultVal: true, description: "Automatically restart the monitor process if it crashes." },
  { key: "SENTINEL_CRASH_LOOP_THRESHOLD",  label: "Crash Loop Threshold",       category: "sentinel", type: "number", defaultVal: 3, min: 2, max: 20, description: "Number of crashes within the window before declaring a crash loop." },
  { key: "SENTINEL_CRASH_LOOP_WINDOW_MIN", label: "Crash Loop Window",          category: "sentinel", type: "number", defaultVal: 10, min: 2, max: 60, unit: "min", description: "Rolling time window for crash loop detection." },
  { key: "SENTINEL_REPAIR_AGENT_ENABLED",  label: "Repair Agent",               category: "sentinel", type: "boolean", defaultVal: true, description: "Enable AI-powered repair agent when a crash loop is detected." },
  { key: "SENTINEL_REPAIR_TIMEOUT_MIN",    label: "Repair Timeout",             category: "sentinel", type: "number", defaultVal: 20, min: 5, max: 120, unit: "min", description: "Maximum time the repair agent can run." },

  // ── Agent Hooks ────────────────────────────────────────────
  { key: "BOSUN_HOOK_PROFILE",     label: "Hook Profile",               category: "hooks", type: "select", defaultVal: "strict", options: ["strict", "balanced", "lightweight", "none"], description: "Pre-configured hook intensity. 'strict' runs all checks, 'none' disables hooks." },
  { key: "BOSUN_HOOK_TARGETS",     label: "Hook Targets",               category: "hooks", type: "string", defaultVal: "codex,claude,copilot", description: "Comma-separated list of agent SDKs to install hooks for.", validate: "^[a-z,]+$" },
  { key: "BOSUN_HOOKS_ENABLED",    label: "Enable Hooks",               category: "hooks", type: "boolean", defaultVal: true, description: "Enable agent lifecycle hook scaffolding." },
  { key: "BOSUN_HOOKS_OVERWRITE",  label: "Overwrite Existing",         category: "hooks", type: "boolean", defaultVal: false, description: "Overwrite existing hook files when installing. Use with caution." },
  { key: "BOSUN_HOOKS_BUILTINS_MODE", label: "Built-ins Mode",          category: "hooks", type: "select", defaultVal: "force", options: ["force", "auto", "off"], description: "How built-in hooks are managed. 'force' always installs, 'auto' only if missing." },

  // ── Logging / Monitoring ────────────────────────────────────
  { key: "AGENT_WORK_LOGGING_ENABLED",     label: "Work Logging",               category: "logging", type: "boolean", defaultVal: true, description: "Enable structured agent work logging with transcripts." },
  { key: "AGENT_WORK_ANALYZER_ENABLED",    label: "Live Analyzer",              category: "logging", type: "boolean", defaultVal: true, description: "Enable real-time agent output stream analysis for anomaly detection." },
  { key: "AGENT_SESSION_LOG_RETENTION",     label: "Session Retention",          category: "logging", type: "number", defaultVal: 100, min: 10, max: 10000, description: "Number of agent session transcripts to keep before rotation." },
  { key: "AGENT_ERROR_LOOP_THRESHOLD",     label: "Error Loop Threshold",       category: "logging", type: "number", defaultVal: 4, min: 2, max: 20, description: "Errors in a 10-minute window that trigger a loop alert." },
  { key: "AGENT_STUCK_THRESHOLD_MS",       label: "Stuck Detection",            category: "logging", type: "number", defaultVal: 300000, min: 60000, max: 1800000, unit: "ms", description: "Idle time before an agent is considered stuck." },
  { key: "LOG_MAX_SIZE_MB",                label: "Max Log Size",               category: "logging", type: "number", defaultVal: 500, min: 0, max: 10000, unit: "MB", description: "Maximum total log size before rotation. 0 = unlimited." },
  { key: "BOSUN_UI_COORDINATION_STATE_ENABLED", label: "Coordination State API", category: "logging", section: "Server State", type: "boolean", defaultVal: false, description: "Expose compact coordination, planning, journal, and monitoring summaries through authenticated UI server-state APIs." },
  { key: "BOSUN_UI_SCOPE_LOCK_STATE_ENABLED", label: "Scope Lock Summary",      category: "logging", section: "Server State", type: "boolean", defaultVal: false, description: "Include repo scope-lock summaries in UI server-state responses.", advanced: true },
  { key: "BOSUN_UI_AUDIT_SUMMARY_ENABLED", label: "Audit Summary State",        category: "logging", section: "Server State", type: "boolean", defaultVal: false, description: "Include state-ledger audit and promoted-strategy summaries in UI server-state responses.", advanced: true },
  { key: "BOSUN_UI_EXECUTION_JOURNAL_STATE_ENABLED", label: "Execution Journals", category: "logging", section: "Server State", type: "boolean", defaultVal: false, description: "Include execution journal coverage and replay summaries in UI server-state responses.", advanced: true },
  { key: "BOSUN_UI_PLANNING_ACCOUNTING_ENABLED", label: "Planning Accounting",  category: "logging", section: "Server State", type: "boolean", defaultVal: false, description: "Include workspace planning posture and runtime accounting summaries in UI server-state responses.", advanced: true },
  { key: "BOSUN_UI_MONITORING_STATE_ENABLED", label: "Monitoring Summary",      category: "logging", section: "Server State", type: "boolean", defaultVal: false, description: "Include live monitor and runtime throughput summaries in UI server-state responses.", advanced: true },

  // ── Advanced ────────────────────────────────────────────────
  { key: "DEVMODE",                        label: "Dev Mode",                   category: "advanced", type: "boolean", defaultVal: false, description: "Enable development mode with extra logging, self-restart watcher, and debug endpoints." },
  { key: "SELF_RESTART_WATCH_ENABLED",     label: "Self-Restart Watcher",       category: "advanced", type: "boolean", description: "Auto-restart when source files change. Defaults to true in devmode." },
  { key: "SELF_RESTART_QUIET_MS",          label: "Watcher Idle Reload Delay",  category: "advanced", type: "number", defaultVal: 180000, min: 90000, max: 1800000, unit: "ms", description: "How long source-file watchers must stay idle before Bosun self-restarts to pick up code changes. 180000 means 3 minutes of watcher quiet time." },
  { key: "MAX_PARALLEL",                   label: "Global Max Parallel",        category: "advanced", type: "number", defaultVal: 6, min: 1, max: 50, description: "Global maximum parallel task slots across all executors." },
  { key: "RESTART_DELAY_MS",               label: "Restart Delay",              category: "advanced", type: "number", defaultVal: 180000, min: 1000, max: 1800000, unit: "ms", description: "Delay before restarting after a crash." },
  { key: "ENV_RELOAD_DELAY_MS",            label: "Settings Reload Delay",      category: "advanced", type: "number", defaultVal: 5000, min: 500, max: 60000, unit: "ms", description: "Quiet period before Bosun reloads runtime config after .env or settings changes. Higher values make restart-sensitive saves less abrupt." },
  { key: "SHARED_STATE_ENABLED",           label: "Shared State",               category: "advanced", type: "boolean", defaultVal: true, description: "Enable distributed task coordination for multi-instance setups." },
  { key: "WORKFLOW_AUTOMATION_ENABLED",    label: "Workflow Automation",        category: "advanced", type: "boolean", defaultVal: true, description: "Enable event-driven workflow auto-triggers from monitor events." },
  { key: "WORKFLOW_RISKY_ACTION_APPROVALS_ENABLED", label: "Risky Action Approvals", category: "advanced", type: "boolean", defaultVal: false, description: "Require operator approval before workflows execute irreversible actions such as push, PR creation, destructive git cleanup, and task deletion.", danger: true },
  { key: "SHARED_STATE_STALE_THRESHOLD_MS", label: "Stale Threshold",           category: "advanced", type: "number", defaultVal: 300000, min: 60000, max: 1800000, unit: "ms", description: "Time before a heartbeat is considered stale.", advanced: true },
  { key: "VE_CI_SWEEP_EVERY",              label: "CI Sweep Interval",          category: "advanced", type: "number", defaultVal: 15, min: 1, max: 100, description: "Trigger CI sweep after every N completed tasks.", advanced: true },

  // ── Context Shredding ──────────────────────────────────────────
  { key: "CONTEXT_SHREDDING_ENABLED",                label: "Enable Context Shredding",           category: "context-shredding", type: "boolean", defaultVal: true,  description: "Master switch for context compression. When off, agents receive their full history every turn (increases cost and risk of context overflow)." },
  { key: "CONTEXT_SHREDDING_FULL_CONTEXT_TURNS",     label: "Full Context Turns (Tier 0)",        category: "context-shredding", type: "number",  defaultVal: 3,     min: 1, max: 20,   description: "Number of most-recent turns to keep completely uncompressed. Higher values use more tokens but improve agent coherence on rapid back-and-forth." },
  { key: "CONTEXT_SHREDDING_COMPRESS_TOOL_OUTPUTS",  label: "Compress Tool Outputs",              category: "context-shredding", type: "boolean", defaultVal: true,  description: "Enable tiered compression for tool call outputs (file reads, search results, etc.)." },
  { key: "CONTEXT_SHREDDING_COMPRESS_MESSAGES",      label: "Compress Agent & User Messages",     category: "context-shredding", type: "boolean", defaultVal: true,  description: "Compress agent reasoning messages and user prompts as they age out. Prevents long planning monologues from occupying context permanently." },
  { key: "CONTEXT_SHREDDING_TIER1_MAX_AGE",          label: "Tier 1 Max Age",                     category: "context-shredding", type: "number",  defaultVal: 5,     min: 1, max: 50,   unit: "turns", description: "Turns threshold for light compression (head+tail truncation). Items older than Tier 0 but within this age get light compression.", advanced: true },
  { key: "CONTEXT_SHREDDING_TIER2_MAX_AGE",          label: "Tier 2 Max Age",                     category: "context-shredding", type: "number",  defaultVal: 9,     min: 2, max: 100,  unit: "turns", description: "Turns threshold for moderate compression. Items older than Tier 1 but within this age get heavy head+tail truncation.", advanced: true },
  { key: "CONTEXT_SHREDDING_TIER1_HEAD_CHARS",       label: "Tier 1 Head Characters",             category: "context-shredding", type: "number",  defaultVal: 2000,  min: 100, max: 10000, unit: "chars", description: "Maximum characters to keep from the start of a tool output in Tier 1 compression.", advanced: true },
  { key: "CONTEXT_SHREDDING_TIER1_TAIL_CHARS",       label: "Tier 1 Tail Characters",             category: "context-shredding", type: "number",  defaultVal: 800,   min: 0, max: 5000,  unit: "chars", description: "Maximum characters to keep from the end of a tool output in Tier 1 compression.", advanced: true },
  { key: "CONTEXT_SHREDDING_TIER2_HEAD_CHARS",       label: "Tier 2 Head Characters",             category: "context-shredding", type: "number",  defaultVal: 600,   min: 50, max: 5000,  unit: "chars", description: "Maximum characters to keep from the start of a tool output in Tier 2 compression.", advanced: true },
  { key: "CONTEXT_SHREDDING_TIER2_TAIL_CHARS",       label: "Tier 2 Tail Characters",             category: "context-shredding", type: "number",  defaultVal: 300,   min: 0, max: 2000,  unit: "chars", description: "Maximum characters to keep from the end of a tool output in Tier 2 compression.", advanced: true },
  { key: "CONTEXT_SHREDDING_SCORE_HIGH",             label: "High-Value Score Threshold",         category: "context-shredding", type: "number",  defaultVal: 70,    min: 1, max: 100,  description: "Items scored at or above this threshold are protected from compression (tier shifted down).", advanced: true },
  { key: "CONTEXT_SHREDDING_SCORE_LOW",              label: "Low-Value Score Threshold",          category: "context-shredding", type: "number",  defaultVal: 30,    min: 0, max: 99,   description: "Items scored below this threshold are compressed more aggressively (tier shifted up).", advanced: true },
  { key: "CONTEXT_SHREDDING_COMPRESS_AGENT_MESSAGES", label: "Compress Agent Messages",           category: "context-shredding", type: "boolean", defaultVal: true,  description: "Compress verbose agent thinking/planning messages after they age out of the active window.", advanced: true },
  { key: "CONTEXT_SHREDDING_COMPRESS_USER_MESSAGES", label: "Compress User Messages",             category: "context-shredding", type: "boolean", defaultVal: true,  description: "Compress old user prompt messages to a short breadcrumb. The current turn's prompt is always kept in full.", advanced: true },
  { key: "CONTEXT_SHREDDING_MSG_TIER0_MAX_AGE",      label: "Message Full-Text Turns",            category: "context-shredding", type: "number",  defaultVal: 1,     min: 0, max: 10,   unit: "turns", description: "Number of most-recent turns to preserve agent messages in full text.", advanced: true },
  { key: "CONTEXT_SHREDDING_MSG_TIER1_MAX_AGE",      label: "Message Summary Turns",              category: "context-shredding", type: "number",  defaultVal: 4,     min: 1, max: 20,   unit: "turns", description: "Turns within which agent messages get a moderate summary. Messages older than this become a one-line breadcrumb.", advanced: true },
  { key: "CONTEXT_SHREDDING_MSG_MIN_COMPRESS_CHARS", label: "Min Message Chars to Compress",      category: "context-shredding", type: "number",  defaultVal: 120,   min: 0, max: 2000, unit: "chars", description: "Agent messages shorter than this are never compressed.", advanced: true },
  { key: "CONTEXT_SHREDDING_USER_MSG_FULL_TURNS",    label: "User Message Full-Text Turns",       category: "context-shredding", type: "number",  defaultVal: 1,     min: 0, max: 10,   unit: "turns", description: "Turns during which the full user prompt is preserved. After this, only a short summary is kept.", advanced: true },
  { key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ENABLED", label: "Live Tool Compaction",          category: "context-shredding", type: "boolean", defaultVal: false, description: "Enable command-aware compaction of large tool outputs before they are stored in the active turn. Falls back to raw output on low confidence or unsafe shapes." },
  { key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MODE",    label: "Live Compaction Mode",          category: "context-shredding", type: "select",  defaultVal: "auto", options: ["off", "auto", "aggressive"], description: "off disables live compaction, auto compacts only when pressure or signal justify it, and aggressive favors stronger reduction for noisy command families.", advanced: true },
  { key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS", label: "Live Compaction Minimum Size", category: "context-shredding", type: "number",  defaultVal: 4000, min: 500, max: 500000, unit: "chars", description: "Minimum output size before live compaction is considered.", advanced: true },
  { key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_TARGET_CHARS", label: "Live Compaction Target Size", category: "context-shredding", type: "number", defaultVal: 1800, min: 200, max: 50000, unit: "chars", description: "Target upper bound for compacted live command output before retrieval hints and metadata.", advanced: true },
  { key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT", label: "Live Compaction Min Savings", category: "context-shredding", type: "number", defaultVal: 15, min: 0, max: 95, unit: "%", description: "Discard compacted output if it does not save at least this much space.", advanced: true },
  { key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_RUNTIME_MS", label: "Live Compaction Min Runtime", category: "context-shredding", type: "number", defaultVal: 2000, min: 0, max: 3600000, unit: "ms", description: "When command duration metadata is present, require at least this runtime before compacting in auto mode.", advanced: true },
  { key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_BLOCK_STRUCTURED_OUTPUT", label: "Skip Structured Output", category: "context-shredding", type: "boolean", defaultVal: true, description: "Avoid live compaction for likely JSON or other structured outputs where exact bytes matter more than size.", advanced: true },
  { key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ALLOW_COMMANDS", label: "Live Compaction Allowlist", category: "context-shredding", type: "text", defaultVal: "grep,rg,find,findstr,select-string,ag,ack,sift,fd,where,which,ls,dir,tree,git,go,npm,pnpm,yarn,npx,bun,node,python,python3,pytest,pip,pip3,poetry,docker,kubectl,helm,terraform,ansible,ansible-playbook,journalctl,tail,get-content,cargo,gradle,maven,mvn,javac,tsc,jest,vitest,deno,make,cmake,bazel,buck,nx,turbo,rush,composer,bundle", description: "Comma-separated command or tool families eligible for live compaction. Commands outside the allowlist pass through untouched.", advanced: true },
  { key: "CONTEXT_SHREDDING_PROFILES",               label: "Per-Type Profiles (JSON)",           category: "context-shredding", type: "json",    defaultVal: "",    description: 'JSON object with per-interaction-type or per-agent-type overrides. Example: { "perType": { "voice": { "fullContextTurns": 6 } }, "perAgent": { "claude-sdk": { "tier1MaxAge": 8 } } }', advanced: true },
];

/**
 * Get settings grouped by category.
 * @param {boolean} includeAdvanced - Include settings marked as advanced
 * @returns {Map<string, SettingDef[]>}
 */
export function getGroupedSettings(includeAdvanced = false) {
  const groups = new Map();
  for (const cat of CATEGORIES) groups.set(cat.id, []);
  for (const s of SETTINGS_SCHEMA) {
    if (!includeAdvanced && s.advanced) continue;
    const list = groups.get(s.category);
    if (list) list.push(s);
  }
  return groups;
}

/**
 * Validate a value against a setting definition.
 * @param {SettingDef} def
 * @param {string} value
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateSetting(def, value) {
  if (value === "" || value == null) return { valid: true };
  if (def.key === "BOSUN_HOOK_TARGETS") {
    const targets = String(value || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    const allowed = new Set(["codex", "claude", "copilot", "all"]);
    const invalid = targets.filter((entry) => !allowed.has(entry));
    if (invalid.length > 0) {
      return {
        valid: false,
        error: `Invalid targets: ${invalid.join(", ")}`,
      };
    }
    return { valid: true };
  }
  switch (def.type) {
    case "number": {
      const n = Number(value);
      if (isNaN(n)) return { valid: false, error: "Must be a number" };
      if (def.min != null && n < def.min) return { valid: false, error: `Minimum: ${def.min}` };
      if (def.max != null && n > def.max) return { valid: false, error: `Maximum: ${def.max}` };
      return { valid: true };
    }
    case "boolean":
      if (!["true", "false", "1", "0", ""].includes(String(value).toLowerCase()))
        return { valid: false, error: "Must be true or false" };
      return { valid: true };
    case "select":
      if (def.options && !def.options.includes(String(value))) {
        // Allow arbitrary values when the schema includes "custom" as an option
        if (def.options.includes("custom")) return { valid: true };
        return { valid: false, error: `Must be one of: ${def.options.join(", ")}` };
      }
      return { valid: true };
    case "json":
      try {
        const parsed = JSON.parse(String(value));
        if (parsed == null || typeof parsed !== "object") {
          return { valid: false, error: "Must be a JSON object or array" };
        }
        return { valid: true };
      } catch {
        return { valid: false, error: "Invalid JSON" };
      }
    default:
      if (def.validate) {
        try {
          if (typeof def.validate === "function") {
            if (!def.validate(value, def)) {
              return { valid: false, error: "Invalid format" };
            }
          } else if (!new RegExp(def.validate).test(value)) {
            return { valid: false, error: "Invalid format" };
          }
        } catch { /* ignore bad regex */ }
      }
      return { valid: true };
  }
}

/** List of env var keys that are sensitive and should never be returned in full via API. */
export const SENSITIVE_KEYS = new Set(
  SETTINGS_SCHEMA.filter((s) => s.sensitive).map((s) => s.key),
);
