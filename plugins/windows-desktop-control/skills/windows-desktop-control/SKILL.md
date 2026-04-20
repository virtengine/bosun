# Windows Desktop Control

Use this plugin when the task involves native Windows desktop apps or browser surfaces that do not have a stronger structured integration available.

## Operating modes

Pick one of these modes before taking action:

1. UIA-first mode: preferred for native Windows apps with accessible controls.
2. Visible-display mode: for quick manual-adjacent automation on the user’s active screen.
3. Isolated-display mode: for non-interrupting automation on a secondary or virtual display that Windows exposes.
4. Coordinate-fallback mode: for canvas apps, remote surfaces, or controls that UI Automation cannot reach reliably.

## Decision rules

- Prefer structured browser automation for websites when a browser tool or MCP server already exists.
- Prefer `uia_inspect` and `uia_invoke` for native Windows controls before coordinate clicks.
- Prefer `list_displays` and display-aware screenshots before assuming the primary screen is the correct target.
- Prefer `move_window` to place apps on a non-user display before interacting when isolation matters.
- Use screenshots to verify state before and after mutating actions.
- Ask for human confirmation before destructive actions such as deleting data, closing unsaved work, submitting forms, or sending messages.

## Mode patterns

### UIA-first mode

1. Call `list_windows` and `focus_window` to target the correct app.
2. Call `uia_inspect` to find stable selectors.
3. Use `uia_invoke`, `type_text`, or `press_keys`.
4. Capture a `screenshot` after important mutations.

### Isolated-display mode

1. Call `list_displays` and choose the non-user display by `displayId` or `displayName`.
2. Launch or find the app with `launch_app` or `list_windows`.
3. Call `move_window` to place the window on that display. Use `fitToDisplay: true` when full-display placement is better than a preserved window size.
4. Use `screenshot` against that display, then prefer `uia_*` actions.
5. If coordinate fallback is required, pass `displayRelative: true` so coordinates stay local to the isolated display.

### Coordinate-fallback mode

1. Capture a display-specific `screenshot`.
2. Use `click`, `double_click`, `drag`, or `scroll` with `displayRelative: true` when you are targeting a specific monitor.
3. Re-capture a `screenshot` after each mutation that could change layout or focus.

### Desktop-overview mode

1. Use `screenshot` with `virtualScreen: true` to inspect the full multi-monitor layout.
2. Use `list_displays` to resolve the right target display before moving windows or clicking.

## Guardrails

- `launch_app` is allowlisted by default. Expand the allowlist intentionally instead of disabling it.
- For risky key chords, pass `confirm: true` only after the user has explicitly approved the action.
- Treat browser work inside Edge, Chrome, or Electron as browser automation first unless the task specifically needs full-desktop interaction.
- Treat “hidden display” as a Windows-visible secondary or virtual monitor. If Windows does not expose the target as a display, this plugin cannot safely target it as one.
