# Windows Desktop Control

This plugin gives Codex a local Windows desktop-control MCP server. It is designed for Windows-native app automation where browser-native tooling is not enough.

## What it exposes

- `list_displays`
- `screenshot`
- `list_windows`
- `focus_window`
- `move_window`
- `click`
- `double_click`
- `type_text`
- `press_keys`
- `scroll`
- `drag`
- `launch_app`
- `uia_inspect`
- `uia_invoke`

## Multi-display and hidden-display workflow

- Use `list_displays` first to map `displayId`, `deviceName`, bounds, and the combined virtual desktop.
- Use `screenshot` with `displayId` or `displayName` to capture a specific monitor, or `virtualScreen: true` to capture the full desktop span.
- Use `displayRelative: true` with `click`, `double_click`, `scroll`, `drag`, and regional `screenshot` captures when you want monitor-local coordinates instead of absolute virtual-desktop coordinates.
- Use `move_window` after `launch_app` or `list_windows` to place an app on a secondary or virtual display before interacting with it.
- For non-interrupting runs, point the workflow at a Windows-visible virtual monitor and keep automation on that display instead of the user’s primary screen.

## Recommended operating modes

1. UIA-first native app mode: `list_windows` -> `focus_window` -> `uia_inspect` -> `uia_invoke` -> `screenshot`.
2. Virtual-display isolation mode: `list_displays` -> `launch_app` -> `move_window` to the isolated display -> `screenshot`/`uia_*` -> coordinate fallback only if needed.
3. Coordinate fallback mode: `screenshot` the target display, then `click`/`drag`/`scroll` with `displayRelative: true`.
4. Desktop overview mode: `screenshot` with `virtualScreen: true` to inspect the whole multi-monitor layout before moving a window or choosing a display.

## Safety defaults

- `launch_app` is allowlisted. By default the server only allows `notepad.exe`, `calc.exe`, `mspaint.exe`, and `explorer.exe`.
- Extend the allowlist with `WINDOWS_DESKTOP_ALLOWED_APPS`.
- Bypass the allowlist only by setting `WINDOWS_DESKTOP_ALLOW_UNSAFE=1`.
- Potentially destructive key chords such as `Alt+F4`, `Ctrl+W`, and `Delete` require `confirm: true`.

## Install flow

1. Keep this plugin under the repo-local `plugins/windows-desktop-control` path.
2. Point Codex at the repo-local marketplace in `.agents/plugins/marketplace.json`.
3. Install the plugin through Codex's normal plugin flow.

## Notes

- The server only performs desktop actions on Windows. On other platforms it still starts and lists tools, but action calls fail with a clear message.
- `type_text` uses clipboard paste with clipboard restore as the default text-entry fallback.
- `uia_inspect` and `uia_invoke` use Windows UI Automation first. Use those before coordinate clicks when controls are exposed cleanly.
- “Hidden” display operation means a display target that Windows exposes but the user is not actively working on, such as a secondary monitor or a virtual monitor provided by the host environment.
