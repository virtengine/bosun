import * as ReactModule from "react";
import htm from "htm";
import * as ink from "ink";

import {
  listRemoteConnections,
  readRemoteConnectionConfig,
  saveRemoteConnectionConfig,
  setActiveRemoteConnection,
  testConnectionTarget,
  upsertRemoteConnection,
} from "../lib/connection-target.mjs";

const React = ReactModule.default ?? ReactModule;
const useMemo = ReactModule.useMemo ?? React.useMemo;
const useState = ReactModule.useState ?? React.useState;
const useEffect = ReactModule.useEffect ?? React.useEffect;
const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useInput = ink.useInput ?? ink.default?.useInput;

const html = htm.bind(React.createElement);

const FOCUS_ORDER = ["endpoint", "apiKey", "test", "save", "launch", "local"];

function clampIndex(value) {
  if (value < 0) return FOCUS_ORDER.length - 1;
  if (value >= FOCUS_ORDER.length) return 0;
  return value;
}

function appendInput(value, input) {
  return `${String(value || "")}${input}`;
}

function removeLastCharacter(value) {
  return String(value || "").slice(0, -1);
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "(empty)";
  if (text.length <= 4) return "*".repeat(text.length);
  return `${"*".repeat(Math.max(0, text.length - 4))}${text.slice(-4)}`;
}

function ActionButton({ label, selected, color }) {
  return html`
    <${Box} marginRight=${1}>
      <${Text} inverse=${selected} color=${color || undefined}> ${label} <//>
    <//>
  `;
}

export default function ConnectionSetupScreen({
  configDir,
  initialEndpoint = "",
  initialApiKey = "",
  initialError = "",
  onConnect,
  onLaunchLocal,
  onUseLocal,
  onInputCaptureChange,
}) {
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [activeIndex, setActiveIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const [errorLine, setErrorLine] = useState(initialError);
  const [lastProbeOk, setLastProbeOk] = useState(false);
  const [savedConfig, setSavedConfig] = useState(() => readRemoteConnectionConfig(configDir));
  const [selectedConnectionIndex, setSelectedConnectionIndex] = useState(0);

  useEffect(() => {
    if (typeof onInputCaptureChange === "function") {
      onInputCaptureChange(true);
    }
    return () => {
      if (typeof onInputCaptureChange === "function") {
        onInputCaptureChange(false);
      }
    };
  }, [onInputCaptureChange]);

  const activeField = FOCUS_ORDER[activeIndex] || "endpoint";
  const canSubmit = useMemo(() => String(endpoint || "").trim().length > 0 && !busy, [busy, endpoint]);
  const savedConnections = useMemo(() => listRemoteConnections(savedConfig), [savedConfig]);
  const selectedConnection = savedConnections[selectedConnectionIndex] || null;
  const localConnection = savedConfig.localConnection || null;

  useEffect(() => {
    setSavedConfig(readRemoteConnectionConfig(configDir));
  }, [configDir]);

  useEffect(() => {
    setSelectedConnectionIndex((current) => {
      if (!savedConnections.length) return 0;
      return Math.min(current, savedConnections.length - 1);
    });
  }, [savedConnections.length]);

  async function runProbe() {
    if (busy) return null;
    setBusy(true);
    setErrorLine("");
    setStatusLine("Testing remote connection...");
    try {
      const result = await testConnectionTarget(endpoint, apiKey);
      if (result.ok) {
        setLastProbeOk(true);
        setStatusLine(`Connected to ${result.target.endpoint}`);
        return result;
      }
      setLastProbeOk(false);
      setErrorLine(result.error || "Connection failed");
      setStatusLine("");
      return result;
    } finally {
      setBusy(false);
    }
  }

  async function saveAndConnect() {
    if (!canSubmit) return;
    const result = await runProbe();
    if (!result?.ok || !result?.target) return;
    const nextConfig = upsertRemoteConnection(readRemoteConnectionConfig(configDir), {
      id: selectedConnection?.id || "",
      name: selectedConnection?.name || result.target.endpoint,
      endpoint: result.target.endpoint,
      apiKey,
      enabled: true,
    });
    const saved = saveRemoteConnectionConfig(nextConfig, configDir);
    setSavedConfig(saved);
    setStatusLine(`Saved ${result.target.endpoint}. Connecting...`);
    if (typeof onConnect === "function") {
      onConnect({
        ...result.target,
        apiKey: String(apiKey || "").trim(),
        source: "saved-remote",
      });
    }
  }

  async function switchToSelectedConnection() {
    if (!selectedConnection || busy) return;
    setBusy(true);
    setErrorLine("");
    setStatusLine(`Testing ${selectedConnection.name}...`);
    try {
      const result = await testConnectionTarget(selectedConnection.endpoint, selectedConnection.apiKey);
      if (!result.ok) {
        setLastProbeOk(false);
        setErrorLine(result.error || "Connection failed");
        setStatusLine("");
        return;
      }
      const nextConfig = setActiveRemoteConnection(readRemoteConnectionConfig(configDir), selectedConnection.id);
      const saved = saveRemoteConnectionConfig(nextConfig, configDir);
      setSavedConfig(saved);
      setLastProbeOk(true);
      setEndpoint(selectedConnection.endpoint);
      setApiKey(selectedConnection.apiKey || "");
      setStatusLine(`Switched to ${selectedConnection.name}. Connecting...`);
      if (typeof onConnect === "function") {
        onConnect({
          ...result.target,
          apiKey: selectedConnection.apiKey || "",
          source: "saved-remote",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function useLocalFallback() {
    if (busy) return;
    const currentConfig = readRemoteConnectionConfig(configDir);
    const nextConfig = saveRemoteConnectionConfig({
      ...currentConfig,
      enabled: false,
    }, configDir);
    setSavedConfig(nextConfig);
    setStatusLine("Switching to local attach...");
    setErrorLine("");
    if (typeof onUseLocal === "function") {
      await onUseLocal();
    }
  }

  async function launchLocalBackend() {
    if (busy || typeof onLaunchLocal !== "function") return;
    setBusy(true);
    setErrorLine("");
    setStatusLine("Launching local backend...");
    try {
      const target = await onLaunchLocal();
      if (target?.endpoint) {
        setStatusLine(`Local backend ready at ${target.endpoint}`);
      }
    } catch (error) {
      setErrorLine(String(error?.message || "Failed to launch local backend"));
      setStatusLine("");
    } finally {
      setBusy(false);
    }
  }

  useInput((input, key) => {
    if (busy) return;

    if ((key.tab && key.shift) || key.upArrow) {
      setActiveIndex((current) => clampIndex(current - 1));
      return;
    }
    if (key.tab || key.downArrow) {
      setActiveIndex((current) => clampIndex(current + 1));
      return;
    }
    if (key.ctrl && input?.toLowerCase() === "t") {
      void runProbe();
      return;
    }
    if (key.ctrl && input?.toLowerCase() === "s") {
      void saveAndConnect();
      return;
    }
    if (key.ctrl && input?.toLowerCase() === "l") {
      void launchLocalBackend();
      return;
    }
    if (key.ctrl && input?.toLowerCase() === "u") {
      void useLocalFallback();
      return;
    }
    if (key.leftArrow && savedConnections.length > 0) {
      setSelectedConnectionIndex((current) => (current <= 0 ? savedConnections.length - 1 : current - 1));
      return;
    }
    if (key.rightArrow && savedConnections.length > 0) {
      setSelectedConnectionIndex((current) => (current >= savedConnections.length - 1 ? 0 : current + 1));
      return;
    }
    if (key.ctrl && input?.toLowerCase() === "w") {
      void switchToSelectedConnection();
      return;
    }

    if (activeField === "endpoint" || activeField === "apiKey") {
      if (key.return) {
        setActiveIndex((current) => clampIndex(current + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (activeField === "endpoint") setEndpoint((current) => removeLastCharacter(current));
        else setApiKey((current) => removeLastCharacter(current));
        setLastProbeOk(false);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (activeField === "endpoint") setEndpoint((current) => appendInput(current, input));
        else setApiKey((current) => appendInput(current, input));
        setLastProbeOk(false);
      }
      return;
    }

    if (key.return || input === " ") {
      if (activeField === "test") {
        void runProbe();
        return;
      }
      if (activeField === "save") {
        void saveAndConnect();
        return;
      }
      if (activeField === "launch") {
        void launchLocalBackend();
        return;
      }
      if (activeField === "local") {
        void useLocalFallback();
        return;
      }
    }
  });

  return html`
    <${Box} flexDirection="column" paddingX=${1} paddingY=${1} borderStyle="double">
      <${Text} bold color="yellow">Remote Connection Setup<//>
      <${Text} dimColor>
        Bosun could not connect to the configured instance. Update the endpoint, test it, then save to attach.
      <//>
      <${Text} dimColor>
        [Tab] next  [Ctrl+T] test  [Ctrl+S] save & connect  [Ctrl+W] switch saved  [Ctrl+L] launch local  [Ctrl+U] use local
      <//>

      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Saved Connections (${savedConnections.length})<//>
        ${savedConnections.length
          ? savedConnections.map((connection, index) => html`
              <${Text} key=${connection.id} inverse=${index === selectedConnectionIndex}>
                ${index === selectedConnectionIndex ? "> " : "  "}${connection.name}
                ${connection.id === savedConfig.activeConnectionId ? " [active]" : ""}
                {" -> "}${connection.endpoint}
              <//>
            `)
          : html`<${Text} dimColor>No saved remote connections yet.<//>`}
        <${Text} dimColor>[Left/Right] select saved connection<//>
      <//>

      ${localConnection?.endpoint
        ? html`
            <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
              <${Text} bold>Local Backend<//>
              <${Text}>${localConnection.endpoint}<//>
            <//>
          `
        : null}

      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold inverse=${activeField === "endpoint"}>Endpoint<//>
        <${Text} color=${activeField === "endpoint" ? "cyan" : undefined}>
          ${endpoint || (activeField === "endpoint" ? "█" : "https://host:port")}
        <//>
      <//>

      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold inverse=${activeField === "apiKey"}>API Key<//>
        <${Text} color=${activeField === "apiKey" ? "cyan" : undefined}>
          ${activeField === "apiKey" ? (apiKey || "█") : maskSecret(apiKey)}
        <//>
      <//>

      <${Box} marginTop=${1}>
        <${ActionButton} label="Test Connection" selected=${activeField === "test"} color="cyan" />
        <${ActionButton} label="Save & Connect" selected=${activeField === "save"} color=${canSubmit ? "green" : "gray"} />
        <${ActionButton} label="Switch Saved" selected=${false} color=${selectedConnection ? "magenta" : "gray"} />
        <${ActionButton} label="Launch Local Backend" selected=${activeField === "launch"} color="blue" />
        <${ActionButton} label="Use Local" selected=${activeField === "local"} color="yellow" />
      <//>

      ${busy ? html`
        <${Box} marginTop=${1}>
          <${Text} color="yellow">Working...<//>
        <//>
      ` : null}
      ${statusLine ? html`
        <${Box} marginTop=${1}>
          <${Text} color=${lastProbeOk ? "green" : "yellow"}>${statusLine}<//>
        <//>
      ` : null}
      ${errorLine ? html`
        <${Box} marginTop=${1}>
          <${Text} color="red">${errorLine}<//>
        <//>
      ` : null}
    <//>
  `;
}
