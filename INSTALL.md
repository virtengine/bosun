# Bosun — Installation & Deployment Guide

This guide covers every way to install and run Bosun: from npm, from source, via Docker, and as the Electron desktop app.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 22.13+** | Required for npm / source installs because Bosun uses the built-in `node:sqlite` module. Node 24 LTS recommended. Not needed for Docker. |
| **Git** | On PATH. Needed by all installation methods. |
| **Bash** or **PowerShell 7+** | For executor wrapper scripts. Windows ships with PowerShell; macOS/Linux ship with bash. |
| **GitHub CLI (`gh`)** | Recommended for PR workflows. `brew install gh` / `winget install GitHub.cli` / `apt install gh`. |
| **Docker** | Required only for Docker-based installs. v20+ recommended. |

At least one AI provider key is needed for executor functionality:

| Provider | Environment variable |
|---|---|
| OpenAI / Codex | `OPENAI_API_KEY` |
| Anthropic / Claude | `ANTHROPIC_API_KEY` |
| Google / Gemini | `GEMINI_API_KEY` |
| OpenCode | `OPENCODE_MODEL`, `OPENCODE_PORT` |

---

## Option 1 — Install from npm (recommended)

The fastest path for most users.

```bash
# Install globally
npm install -g bosun

# Verify
bosun --version
```

Then navigate to the repository you want Bosun to supervise and run setup:

```bash
cd your-repo
bosun --setup
```

The setup wizard opens a browser-based UI on `https://localhost:3080` where you configure your executor, task backend, Telegram, and credentials.

### Start Bosun

```bash
# Foreground (interactive)
bosun

# Background daemon
bosun --daemon

# Daemon + Telegram sentinel
bosun --daemon --sentinel

# Stop background daemon
bosun --stop-daemon

# Hard-stop all Bosun processes
bosun --terminate
```

### Validate

```bash
bosun --doctor          # Health check
bosun --daemon-status   # Daemon heartbeat
bosun --workspace-list  # Registered workspaces
```

---

## Option 2 — Install from source

Use this when you want to develop, contribute, or run the latest unreleased code.

```bash
# Clone the repository
git clone https://github.com/virtengine/bosun.git
cd bosun

# Install dependencies
npm install

# Run directly
node cli.mjs --setup

# Or link globally
npm link
bosun --setup
```

### Development commands

```bash
# Run tests
npm test

# Lint / annotation audit
npm run audit:ci

# Prepublish checks
npm run prepublishOnly

# Install local git hooks
npm run hooks:install
```

---

## Option 3 — Docker (from Docker Hub)

Run Bosun as a container with zero Node.js setup on the host. The image is published to [Docker Hub](https://hub.docker.com/r/virtengine/bosun).

### Quick start

```bash
docker run -d \
  --name bosun \
  -p 3080:3080 \
  -v bosun-data:/data \
  -e BOSUN_API_KEY=your-secret-key-here \
  -e OPENAI_API_KEY=sk-... \
  virtengine/bosun:latest
```

Then open `https://localhost:3080` in your browser. The first visit launches the setup wizard.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `BOSUN_API_KEY` | Recommended | API key for external clients (Electron, scripts). Min 8 characters. |
| `OPENAI_API_KEY` | At least one | OpenAI / Codex provider key. |
| `ANTHROPIC_API_KEY` | At least one | Anthropic / Claude provider key. |
| `GEMINI_API_KEY` | At least one | Google / Gemini provider key. |
| `TELEGRAM_BOT_TOKEN` | Optional | Telegram bot token for notifications and control. |
| `TELEGRAM_CHAT_ID` | Optional | Telegram chat ID for message delivery. |
| `GITHUB_TOKEN` | Optional | GitHub personal access token for PR workflows. |
| `BOSUN_PORT` | Optional | Internal port (default `3080`). |

### Persist data

The container stores all state (config, sessions, logs, caches) in `/data`. Mount a volume to retain data across container restarts:

```bash
-v bosun-data:/data
```

### Healthcheck

The image includes a built-in healthcheck on `/healthz`. Docker reports the container as `healthy` once the server is ready:

```bash
docker ps   # STATUS column shows "(healthy)"
```

### Authentication

When `BOSUN_API_KEY` is set, all API and portal requests require authentication:

- **Header:** `X-API-Key: <key>` or `Authorization: Bearer <key>`
- **WebSocket:** `wss://host:3080/ws?apiKey=<key>`
- **Browser:** The setup wizard handles session cookies automatically.

Without `BOSUN_API_KEY`, the server falls back to session-based auth only.

### Mount a local workspace

To give the container access to repositories on the host:

```bash
docker run -d \
  --name bosun \
  -p 3080:3080 \
  -v bosun-data:/data \
  -v /path/to/your/repos:/workspace:rw \
  -e BOSUN_API_KEY=your-secret-key-here \
  virtengine/bosun:latest
```

---

## Option 4 — Docker (from source with docker-compose)

Build and run from the cloned repository using `docker-compose.yml`.

```bash
# Clone the repository
git clone https://github.com/virtengine/bosun.git
cd bosun

# Copy and edit environment
cp .env.example .env
# Edit .env — set at least one AI provider key

# Build and start
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f bosun

# Stop
docker compose down
```

### Customise docker-compose.yml

The provided `docker-compose.yml` includes commented environment variables. Uncomment and set the ones you need:

```yaml
services:
  bosun:
    build: .
    ports:
      - "${BOSUN_PORT:-3080}:3080"
    volumes:
      - bosun-data:/data
      # Mount local repos:
      # - /path/to/your/repos:/workspace:rw
    environment:
      - BOSUN_API_KEY=your-secret-key-here
      - OPENAI_API_KEY=sk-...
      # - TELEGRAM_BOT_TOKEN=...
      # - TELEGRAM_CHAT_ID=...
      # - GITHUB_TOKEN=...
```

### Build the image locally

If you want to build the image without docker compose:

```bash
docker build -t bosun .
docker run -d --name bosun -p 3080:3080 -v bosun-data:/data bosun
```

---

## Option 5 — Electron desktop app

Bosun includes an Electron wrapper for a native desktop experience.

```bash
# From the bosun directory
npm install
npm run desktop
```

The desktop app starts a local Bosun daemon and opens the portal in a native window. It can also connect to a remote Bosun server:

1. On launch, choose **Connect to Remote** in the connection dialog.
2. Enter the server endpoint (e.g. `https://bosun.example.com:3080`).
3. Enter the API key configured on the server (`BOSUN_API_KEY`).

---

## Post-install: first-run setup

Regardless of installation method, the first visit to `https://localhost:3080` launches the **Setup Wizard**. It walks through:

1. **Project identity** — repository name and workspace shape.
2. **Executor defaults** — Codex, Copilot, Claude, Gemini, or OpenCode.
3. **Task backend** — internal, GitHub Issues, or Jira.
4. **Control surfaces** — Telegram Mini App, sentinel, desktop settings.
5. **Credentials** — API keys, tokens, and integration secrets.

You can re-run setup at any time:

```bash
bosun --setup              # Web-based wizard
bosun --setup-terminal     # Legacy terminal wizard
```

---

## Configuration files

| File | Purpose |
|---|---|
| `.env` | Canonical Bosun runtime env in the resolved config directory (`bosun --where`). Repo-root `.env` is legacy/bootstrap fallback only. |
| `bosun.config.json` | Structured config (executor, routing, profiles). |
| `bosun.config.example.json` | Canonical reference for config shape. |
| `.env.example` | Canonical reference for environment variables and bootstrap template. |

The runtime reads the config-dir `.env` first. If that file does not exist yet, Bosun may fall back to a repo-root `.env` for compatibility, but new setups should keep the canonical file in the config directory.

Find all config paths:

```bash
bosun --where
```

---

## Useful CLI flags

| Flag | Description |
|---|---|
| `--setup` | Launch web-based setup wizard. |
| `--setup-terminal` | Legacy terminal setup. |
| `--daemon` | Run as background daemon. |
| `--sentinel` | Start Telegram sentinel companion. |
| `--stop-daemon` | Stop background daemon. |
| `--terminate` | Hard-stop all Bosun processes. |
| `--doctor` | Health check and diagnostics. |
| `--daemon-status` | Show daemon heartbeat. |
| `--sentinel-status` | Show sentinel status. |
| `--workspace-list` | List registered workspaces. |
| `--where` | Show resolved config directory. |
| `--version` | Print version. |

---

## Troubleshooting

### Port already in use

```bash
# Check what's on port 3080
lsof -i :3080         # macOS/Linux
netstat -ano | findstr 3080   # Windows
```

### Docker container unhealthy

```bash
docker logs bosun                        # Full logs
docker inspect bosun --format='{{json .State.Health}}'  # Health details
```

### Self-signed TLS warning

Bosun auto-generates a self-signed certificate on first start. Your browser will show a security warning — this is expected for local development. Accept the certificate or use `curl -k` for API calls.

When TLS is enabled, the UI server now negotiates HTTP/2 automatically and keeps HTTP/1.1 fallback enabled for secure WebSocket upgrades.

### Reset everything

```bash
bosun --terminate
rm -rf $(bosun --where)   # Caution: deletes all Bosun config and state
```

---

## Further reading

- [Bosun Docs](https://bosun.engineer/docs/) — full documentation site.
- [Configuration Guide](https://bosun.engineer/docs/configuration.html) — detailed config reference.
- [CLI Reference](https://bosun.engineer/docs/cli-reference.html) — complete command surface.
- [Architecture](https://bosun.engineer/docs/architecture.html) — system design and module map.
- [Integrations](https://bosun.engineer/docs/integrations.html) — GitHub, Telegram, Jira, Cloudflare.
