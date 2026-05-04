import * as ReactModule from "react";
import htm from "htm";
import * as ink from "ink";

const React = ReactModule.default ?? ReactModule;
const useCallback = ReactModule.useCallback ?? React.useCallback;
const useEffect = ReactModule.useEffect ?? React.useEffect;
const useMemo = ReactModule.useMemo ?? React.useMemo;
const useState = ReactModule.useState ?? React.useState;
const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useApp = ink.useApp ?? ink.default?.useApp;
const useInput = ink.useInput ?? ink.default?.useInput;
const useStdout = ink.useStdout ?? ink.default?.useStdout;

import wsBridgeFactory from "./lib/ws-bridge.mjs";
import { getNextScreenForInput } from "./lib/navigation.mjs";
import StatusHeader from "./components/status-header.mjs";
import TasksScreen from "./screens/tasks.mjs";
import AgentsScreen from "./screens/agents.mjs";
import LogsScreen from "./screens/logs.mjs";
import StatusScreen from "./screens/status.mjs";
import WorkflowsScreen from "./screens/workflows.mjs";
import TelemetryScreen from "./screens/telemetry.mjs";
import SettingsScreen from "./screens/settings.mjs";
import ConnectionSetupScreen from "./screens/connection-setup.mjs";
import { readTuiHeaderConfig } from "./lib/header-config.mjs";
import { createTaskApiFromRequestJson, listTasksFromApi } from "../ui/tui/tasks-screen-helpers.js";
import { useWorkflows } from "../ui/tui/useWorkflows.js";
import CommandPalette from "./CommandPalette.js";
import { buildCommandPaletteActions, createCommandPaletteHistoryAdapter } from "./lib/command-palette.mjs";
import HelpScreen, { getFooterHints, SHORTCUT_GROUPS } from "../ui/tui/HelpScreen.js";
import {
  buildCanonicalSessionApiPath,
  normalizeSessionsUpdatePayload,
} from "../ui/modules/session-api.js";
import {
  appendLogEntry,
  createDefaultLogsFilterState,
  ensureLogSource,
} from "../ui/tui/logs-screen-helpers.js";
import { buildTuiHttpUrl } from "./lib/ws-bridge.mjs";
import {
  ensureLocalBosunBackendRunning,
  readRemoteConnectionConfig,
  resolveLocalTuiConnectionTarget,
} from "./lib/connection-target.mjs";

const CLI_SHORTCUT_TITLES = new Set(["Global", "Tasks screen", "Agents screen", "Modals"]);
const CLI_SHORTCUT_GROUPS = SHORTCUT_GROUPS.filter((group) => CLI_SHORTCUT_TITLES.has(group.title));
const html = htm.bind(React.createElement);

const SCREENS = {
  status: StatusScreen,
  tasks: TasksScreen,
  agents: AgentsScreen,
  logs: LogsScreen,
  workflows: WorkflowsScreen,
  telemetry: TelemetryScreen,
  settings: SettingsScreen,
};

function ScreenTabs({ screen }) {
  const navItems = [
    { key: "status", num: "1", label: "Status" },
    { key: "tasks", num: "2", label: "Tasks" },
    { key: "agents", num: "3", label: "Agents" },
    { key: "logs", num: "4", label: "Logs" },
    { key: "workflows", num: "5", label: "Workflows" },
    { key: "telemetry", num: "6", label: "Telemetry" },
    { key: "settings", num: "7", label: "Settings" },
  ];

  return html`
    <${Box} paddingX=${1}>
      ${navItems.map((item, index) => html`
        <${Box} key=${item.key}>
          <${Text} inverse=${screen === item.key} color=${screen === item.key ? undefined : "cyan"}>
            [${item.num}] ${item.label}
          <//>
          ${index < navItems.length - 1 ? html`<${Text} dimColor>  <//>` : null}
        <//>
      `)}
      <${Text} dimColor>  [Ctrl+P] Palette  [:] Command  [?] Help  [q] Quit<//>
    <//>
  `;
}

function upsertById(items = [], nextItem) {
  if (!nextItem?.id) return items;
  const index = items.findIndex((item) => item.id === nextItem.id);
  if (index === -1) return [nextItem, ...items];
  const next = [...items];
  next[index] = { ...next[index], ...nextItem };
  return next;
}

function toRefreshSeconds(value) {
  return Math.max(0, Math.ceil(Number(value || 2000) / 1000));
}

function isCtrlPaletteShortcut(input, key) {
  // In Ink 5, Ctrl+P arrives as input='p' with key.ctrl=true (not as '\u0010')
  return key?.ctrl === true && input === "p";
}

function isPaletteShortcut(input, key) {
  return input === ":" || isCtrlPaletteShortcut(input, key);
}

function isRemoteAttachTarget(target = {}) {
  const source = String(target?.source || "").trim().toLowerCase();
  if (["saved-remote", "cli-endpoint", "cli-host-port"].includes(source)) return true;
  return Boolean(String(target?.apiKey || "").trim());
}

async function fallbackRequestJson(host, port, protocol, apiKey, path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  if (apiKey && !headers["x-api-key"] && !headers["X-API-Key"]) {
    headers["x-api-key"] = apiKey;
  }
  const response = await fetch(buildTuiHttpUrl({ host, port, path, protocol }), {
    method: options.method || (options.body ? "POST" : "GET"),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || payload?.message || `Request failed: ${response.status}`);
  }
  return payload;
}

export default function App({
  config,
  configDir,
  host,
  port,
  protocol = "ws",
  apiKey = "",
  connectOnly,
  initialScreen,
  refreshMs,
  wsClient,
  historyAdapter,
  connectionSource = "",
  connectionEndpoint = "",
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [connectionTarget, setConnectionTarget] = useState(() => ({
    host,
    port,
    protocol,
    apiKey,
    source: connectionSource,
    endpoint: connectionEndpoint,
  }));
  const [screen, setScreen] = useState(initialScreen || "status");
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState("offline");
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [logs, setLogs] = useState([]);
  const [workflowEvents, setWorkflowEvents] = useState([]);
  const [logsFilterState, setLogsFilterState] = useState(createDefaultLogsFilterState());
  const [error, setError] = useState(null);
  const [screenInputLocked, setScreenInputLocked] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpScrollOffset, setHelpScrollOffset] = useState(0);
  const [footerHints, setFooterHints] = useState(() => getFooterHints(initialScreen || "status"));
  const [effectiveRefreshMs, setEffectiveRefreshMs] = useState(Number(refreshMs || 2000));
  const [refreshCountdownSec, setRefreshCountdownSec] = useState(toRefreshSeconds(refreshMs));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recentActionIds, setRecentActionIds] = useState([]);
  const [connectionSetupOpen, setConnectionSetupOpen] = useState(false);
  const [connectionSetupReason, setConnectionSetupReason] = useState("");
  const [everConnected, setEverConnected] = useState(false);

  const resolvedConfigDir = configDir || process.env.BOSUN_DIR || undefined;
  const resolvedHost = connectionTarget.host || host;
  const resolvedPort = connectionTarget.port || port;
  const resolvedProtocol = connectionTarget.protocol || protocol;
  const resolvedApiKey = connectionTarget.apiKey || "";

  const bridge = useMemo(
    () => wsClient || wsBridgeFactory({
      host: resolvedHost,
      port: resolvedPort,
      protocol: resolvedProtocol,
      apiKey: resolvedApiKey,
      configDir: resolvedConfigDir,
    }),
    [resolvedApiKey, resolvedConfigDir, resolvedHost, resolvedPort, resolvedProtocol, wsClient],
  );
  const workflowsConfig = useMemo(() => ({}), []);
  const headerConfig = useMemo(
    () => readTuiHeaderConfig(bridge?.configDir),
    [bridge?.configDir],
  );
  const localWorkflowsState = useWorkflows(workflowsConfig);
  const workflowsState = useMemo(() => ({
    ...localWorkflowsState,
    workflows,
    loading: localWorkflowsState.loading && workflows.length === 0,
    error: localWorkflowsState.error,
  }), [localWorkflowsState, workflows]);
  const resolvedHistory = useMemo(
    () => historyAdapter || createCommandPaletteHistoryAdapter(),
    [historyAdapter],
  );

  useEffect(() => {
    setConnectionTarget({
      host,
      port,
      protocol,
      apiKey,
      source: connectionSource,
      endpoint: connectionEndpoint,
    });
  }, [apiKey, connectionEndpoint, connectionSource, host, port, protocol]);

  const requestJson = useCallback((path, options = {}) => {
    if (typeof bridge?.requestJson === "function") {
      return bridge.requestJson(path, options);
    }
    return fallbackRequestJson(resolvedHost, resolvedPort, resolvedProtocol, resolvedApiKey, path, options);
  }, [bridge, resolvedApiKey, resolvedHost, resolvedPort, resolvedProtocol]);
  const taskApi = useMemo(() => createTaskApiFromRequestJson(requestJson), [requestJson]);

  useEffect(() => {
    const nextRefreshMs = Number(refreshMs || 2000);
    setEffectiveRefreshMs(nextRefreshMs);
    setRefreshCountdownSec(toRefreshSeconds(nextRefreshMs));
  }, [refreshMs]);

  useEffect(() => {
    void resolvedHistory.load().then(setRecentActionIds).catch(() => {});
  }, [resolvedHistory]);

  useEffect(() => {
    let active = true;
    const unsubscribes = [];

    const resetRefreshCountdown = () => {
      setRefreshCountdownSec(toRefreshSeconds(effectiveRefreshMs));
    };
    const on = (eventName, handler) => {
      const unsubscribe = bridge.on(eventName, handler);
      unsubscribes.push(unsubscribe);
    };
    const refreshTasks = async () => {
      try {
        const nextTasks = await listTasksFromApi({}, taskApi);
        if (active) setTasks(nextTasks);
      } catch (err) {
        if (active) setError(String(err?.message || err || "Failed to load tasks"));
      }
    };
    const refreshWorkflows = async () => {
      try {
        const payload = await requestJson("/api/workflows/templates");
        const nextWorkflows = Array.isArray(payload) ? payload : Array.isArray(payload?.templates) ? payload.templates : [];
        if (active) setWorkflows(nextWorkflows);
      } catch {
        if (active) setWorkflows([]);
      }
    };

    on("connect", () => {
      setConnected(true);
      setEverConnected(true);
      setConnectionState("connected");
      setConnectionSetupOpen(false);
      setConnectionSetupReason("");
      setError(null);
      resetRefreshCountdown();
      void refreshTasks().catch(() => {});
      void refreshWorkflows().catch(() => {});
    });
    on("disconnect", () => {
      setConnected(false);
      setConnectionState("reconnecting");
    });
    on("reconnecting", () => {
      setConnected(false);
      setConnectionState("reconnecting");
    });
    on("connection:state", (payload) => {
      if (payload?.state) {
        setConnectionState(payload.state);
      }
    });
    on("error", (err) => {
      const message = err?.message || String(err || "Unknown websocket error");
      setError(message);
      if (!everConnected && isRemoteAttachTarget(connectionTarget)) {
        setConnectionSetupReason(message);
        setConnectionSetupOpen(true);
      }
      if (message.includes("Max reconnection attempts")) {
        setConnectionState("offline");
      }
    });
    on("monitor:stats", (data) => {
      setStats(data || null);
      resetRefreshCountdown();
    });
    on("stats", (data) => {
      setStats(data || null);
      resetRefreshCountdown();
    });
    on("sessions:update", (payload) => {
      const nextSessions = normalizeSessionsUpdatePayload(payload);
      setSessions(nextSessions);
    });
    on("session:start", (session) => {
      setSessions((previous) => upsertById(previous, session));
    });
    on("session:update", (session) => {
      setSessions((previous) => upsertById(previous, session));
    });
    on("session:end", (session) => {
      setSessions((previous) => previous.filter((candidate) => candidate.id !== session?.id));
    });
    on("tasks:update", () => {
      void refreshTasks().catch(() => {});
    });
    on("workflow:status", (event) => {
      setWorkflowEvents((previous) => [event, ...previous].slice(0, 25));
    });
    on("task:update", (task) => {
      setTasks((previous) => upsertById(previous, task));
    });
    on("task:create", (task) => {
      setTasks((previous) => upsertById(previous, task));
    });
    on("task:delete", (taskId) => {
      setTasks((previous) => previous.filter((task) => task.id !== taskId));
    });
    on("logs:stream", (entry) => {
      const logEntry = {
        ...entry,
        source: entry?.source ?? entry?.logType,
        ts: entry?.ts ?? entry?.timestamp,
        message: entry?.message ?? entry?.line ?? entry?.raw,
      };

      setLogs((previous) => appendLogEntry(previous, logEntry));
      setLogsFilterState((previous) => {
        let next = ensureLogSource(previous, logEntry.source, true);
        if (logEntry.sessionId) {
          next = ensureLogSource(next, `session:${logEntry.sessionId}`, true);
        }
        return next;
      });
    });
    on("retry:update", (retryQueue) => {
      setStats((previous) => ({ ...(previous || {}), retryQueue }));
    });
    on("retry-queue-updated", (retryQueue) => {
      setStats((previous) => ({ ...(previous || {}), retryQueue }));
    });

    if (typeof bridge.connect === "function") {
      bridge.connect();
    }
    void refreshTasks().catch(() => {});
    void refreshWorkflows().catch(() => {});

    return () => {
      active = false;
      unsubscribes.forEach((unsubscribe) => {
        if (typeof unsubscribe === "function") unsubscribe();
      });
      if (typeof bridge.disconnect === "function") {
        bridge.disconnect();
      }
    };
  }, [bridge, connectionTarget, effectiveRefreshMs, everConnected, requestJson, taskApi]);

  useEffect(() => {
    if (helpOpen) {
      setFooterHints(getFooterHints(screen, { helpOpen: true }));
      return;
    }
    setFooterHints(getFooterHints(screen));
  }, [screen, helpOpen]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setRefreshCountdownSec((previous) => Math.max(0, previous - 1));
    }, 1000);
    return () => clearInterval(intervalId);
  }, []);

  const paletteActions = useMemo(
    () => buildCommandPaletteActions({
      sessions,
      tasks,
      workflows,
      currentScreen: screen,
      recentActionIds,
    }),
    [recentActionIds, screen, sessions, tasks, workflows],
  );

  const executePaletteAction = useCallback(async (action) => {
    try {
      if (action.type === "navigation") {
        setScreen(action.payload.screen);
      } else if (action.type === "session") {
        await requestJson(buildCanonicalSessionApiPath(action.payload.sessionId, action.command, { workspace: "all" }), {
          method: "POST",
        });
      } else if (action.type === "task") {
        if (action.command === "create") {
          await requestJson("/api/tasks/create", {
            method: "POST",
            body: { title: "New task from palette" },
          });
        } else if (action.command === "update") {
          await requestJson("/api/tasks/update", {
            method: "POST",
            body: { id: action.payload.taskId, status: "inprogress" },
          });
        } else if (action.command === "delete") {
          await requestJson(`/api/tasks/${encodeURIComponent(action.payload.taskId)}`, { method: "DELETE" });
        }
      } else if (action.type === "workflow") {
        await requestJson(`/api/workflows/${encodeURIComponent(action.payload.workflowId)}/execute`, {
          method: "POST",
          body: {},
        });
      } else if (action.type === "config" && action.id.startsWith("config:refresh:")) {
        const nextSeconds = Number(action.id.split(":").at(-1) || 2);
        const nextRefreshMs = nextSeconds * 1000;
        setEffectiveRefreshMs(nextRefreshMs);
        setRefreshCountdownSec(nextSeconds);
      }
      const nextRecent = await resolvedHistory.save({ actionId: action.id, recentActionIds });
      setRecentActionIds(nextRecent);
      setPaletteOpen(false);
      setError(null);
    } catch (err) {
      setError(String(err?.message || err || "Command failed"));
      setPaletteOpen(false);
    }
  }, [recentActionIds, requestJson, resolvedHistory]);

  const helpRows = Math.max(6, (stdout?.rows || 24) - 5);
  const helpRowCount = CLI_SHORTCUT_GROUPS.reduce((totalRows, group, index, groups) => {
    if (index % 2 === 1) return totalRows;
    const right = groups[index + 1];
    const pairHeight = 1 + Math.max(group.items.length, right?.items?.length || 0);
    return totalRows + pairHeight;
  }, 0);
  const maxHelpScrollOffset = Math.max(0, helpRowCount - helpRows);

  const handleInput = useCallback((input, key) => {
    if (isPaletteShortcut(input, key)) {
      setPaletteOpen(true);
      return;
    }
    if (input === "?") {
      setHelpOpen((current) => {
        const opening = !current;
        if (opening) {
          setHelpScrollOffset(0);
          setFooterHints(getFooterHints(screen, { helpOpen: true }));
        } else {
          setFooterHints(getFooterHints(screen));
        }
        return opening;
      });
      return;
    }
    if (helpOpen) {
      if (key?.escape) {
        setHelpOpen(false);
        setHelpScrollOffset(0);
        setFooterHints(getFooterHints(screen));
        return;
      }
      if (key?.upArrow) {
        setHelpScrollOffset((current) => Math.max(0, current - 1));
        return;
      }
      if (key?.downArrow) {
        setHelpScrollOffset((current) => Math.min(maxHelpScrollOffset, current + 1));
        return;
      }
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    setScreen((current) => getNextScreenForInput(current, input));
  }, [exit, helpOpen, maxHelpScrollOffset, screen]);

  useInput((input, key) => {
    if (connectionSetupOpen) return;
    if (paletteOpen) return;
    if (screenInputLocked && !helpOpen) {
      if (isCtrlPaletteShortcut(input, key)) {
        setPaletteOpen(true);
        return;
      }
      if (input !== "?") return;
    }
    handleInput(input, key);
  });

  const ScreenComponent = SCREENS[screen] || StatusScreen;
  const screenStats = stats;
  const handleConnectionTargetConnect = useCallback((target) => {
    setEverConnected(false);
    setConnected(false);
    setConnectionState("reconnecting");
    setConnectionSetupOpen(false);
    setConnectionSetupReason("");
    setError(null);
    setConnectionTarget((current) => ({
      ...current,
      ...target,
    }));
  }, []);
  const handleUseLocalConnection = useCallback(async () => {
    const localTarget = resolveLocalTuiConnectionTarget({
      configDir: resolvedConfigDir || bridge?.configDir,
      config,
      env: process.env,
    });
    handleConnectionTargetConnect(localTarget);
  }, [bridge?.configDir, config, handleConnectionTargetConnect, resolvedConfigDir]);
  const handleLaunchLocalConnection = useCallback(async () => {
    const result = await ensureLocalBosunBackendRunning({
      configDir: resolvedConfigDir || bridge?.configDir,
      config,
      env: process.env,
      timeoutMs: 20000,
    });
    if (!result?.ok || !result?.target) {
      throw new Error(result?.error || "Local backend did not start");
    }
    handleConnectionTargetConnect(result.target);
    return result.target;
  }, [bridge?.configDir, config, handleConnectionTargetConnect, resolvedConfigDir]);
  const connectionConfigSnapshot = useMemo(
    () => readRemoteConnectionConfig(resolvedConfigDir || bridge?.configDir),
    [bridge?.configDir, connectionTarget.endpoint, connectionTarget.source, resolvedApiKey, resolvedConfigDir],
  );
  const settingsState = {
    configDir: resolvedConfigDir || bridge?.configDir,
    host: resolvedHost,
    port: resolvedPort,
    protocol: bridge?.protocol || resolvedProtocol,
    apiKey: resolvedApiKey,
    refreshMs,
    projectLabel: headerConfig.projectLabel,
    configuredProviders: headerConfig.configuredProviders,
    connectionState,
    connectionSource: connectionTarget.source,
    connectionEndpoint: connectionTarget.endpoint,
    authMode: resolvedApiKey ? "api-key" : "local-token",
    activeConnectionId: connectionConfigSnapshot.activeConnectionId,
    remoteConnections: connectionConfigSnapshot.connections,
    localConnection: connectionConfigSnapshot.localConnection,
  };
  const footerText = (footerHints || []).map(([keysLabel, description]) => `${keysLabel} ${description}`).join("  |  ");

  return html`
    <${Box} flexDirection="column" minHeight=${0}>
      ${paletteOpen
        ? html`<${CommandPalette}
            visible=${paletteOpen}
            actions=${paletteActions}
            onClose=${() => setPaletteOpen(false)}
            onExecute=${executePaletteAction}
          />`
        : null}
      <${StatusHeader}
        stats=${stats}
        connected=${connected}
        connectionState=${connectionState}
        projectLabel=${headerConfig.projectLabel}
        configuredProviders=${headerConfig.configuredProviders}
        refreshCountdownSec=${refreshCountdownSec}
        connectionSource=${connectionTarget.source}
        connectionEndpoint=${connectionTarget.endpoint}
        authMode=${settingsState.authMode}
      />
      <${ScreenTabs} screen=${screen} />
      <${Box} flexDirection="column" flexGrow=${1}>
        ${error
          ? html`
              <${Box} paddingX=${1}>
                <${Text} color="red" bold>Error: ${error}<//>
              <//>
            `
          : null}
        ${connectionSetupOpen
          ? html`
              <${ConnectionSetupScreen}
                configDir=${resolvedConfigDir || bridge?.configDir}
                initialEndpoint=${connectionTarget.endpoint || ""}
                initialApiKey=${resolvedApiKey}
                initialError=${connectionSetupReason}
                onConnect=${handleConnectionTargetConnect}
                onLaunchLocal=${handleLaunchLocalConnection}
                onUseLocal=${handleUseLocalConnection}
                onInputCaptureChange=${setScreenInputLocked}
              />
            `
          : html`
              <${ScreenComponent}
                stats=${screenStats}
                sessions=${sessions}
                tasks=${tasks}
                logs=${logs}
                workflowEvents=${workflowEvents}
                workflowsState=${workflowsState}
                settingsState=${settingsState}
                logsFilterState=${logsFilterState}
                wsBridge=${bridge}
                host=${resolvedHost}
                port=${resolvedPort}
                requestJson=${requestJson}
                connectOnly=${connectOnly}
          refreshMs=${effectiveRefreshMs}
          onTasksChange=${setTasks}
          onLogsFilterStateChange=${setLogsFilterState}
          onInputCaptureChange=${setScreenInputLocked}
          onFooterHintsChange=${setFooterHints}
          onOpenConnectionManager=${() => {
            setConnectionSetupReason("");
            setConnectionSetupOpen(true);
          }}
        />
            `}
        ${helpOpen && !connectionSetupOpen
          ? html`
              <${Box} flexDirection="column" marginTop=${1}>
                <${HelpScreen}
                  scrollOffset=${helpScrollOffset}
                  maxRows=${helpRows}
                  groups=${CLI_SHORTCUT_GROUPS}
                />
              <//>
            `
          : null}
      <//>
      <${Box} paddingX=${1}>
        <${Text} dimColor>${footerText}<//>
      <//>
    <//>
  `;
}
