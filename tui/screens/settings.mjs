import React from "react";
import htm from "htm";
import * as ink from "ink";
import TextInput from "ink-text-input";

import {
  buildFooterHints,
  cycleEnumValue,
  flattenSettingsRows,
  formatRenderedValue,
  formatSourceLabel,
  getSelectableSettingRows,
  toggleBooleanValue,
} from "./settings-screen-helpers.mjs";
import { buildTuiHttpUrl } from "../lib/ws-bridge.mjs";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useInput = ink.useInput ?? ink.default?.useInput;
const useStdout = ink.useStdout ?? ink.default?.useStdout;

const html = htm.bind(React.createElement);

function truncateText(value, width) {
  const text = String(value || "");
  if (!width || width < 6 || text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}

function createSettingsService(wsBridge, settingsState = {}) {
  const buildFallbackUrl = (path) => buildTuiHttpUrl({
    host: settingsState.host || "127.0.0.1",
    port: settingsState.port || 3080,
    path,
    protocol: settingsState.protocol || "ws",
  });
  const buildFallbackHeaders = (headers = {}) => {
    const next = { ...headers };
    if (settingsState.apiKey && !next["x-api-key"] && !next["X-API-Key"]) {
      next["x-api-key"] = settingsState.apiKey;
    }
    return next;
  };
  return {
    async load() {
      if (typeof wsBridge?.getConfigTree === "function") {
        return wsBridge.getConfigTree();
      }
      if (typeof wsBridge?.requestJson === "function") {
        return wsBridge.requestJson("/api/tui/config");
      }
      const response = await fetch(buildFallbackUrl("/api/tui/config"), {
        headers: buildFallbackHeaders(),
      });
      return response.json();
    },
    async save(path, value) {
      if (typeof wsBridge?.saveConfigField === "function") {
        return wsBridge.saveConfigField(path, value);
      }
      if (typeof wsBridge?.requestJson === "function") {
        return wsBridge.requestJson("/api/tui/config", {
          method: "POST",
          body: { path, value },
        });
      }
      const response = await fetch(buildFallbackUrl("/api/tui/config"), {
        method: "POST",
        headers: buildFallbackHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ path, value }),
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || "Config update failed");
      }
      return payload;
    },
  };
}

function getSelectedField(selectableRows, selectedPath) {
  return selectableRows.find((row) => row.path === selectedPath) || selectableRows[0] || null;
}

function sliceVisibleRows(rows, selectedPath, maxRows = 24) {
  if (rows.length <= maxRows) return rows;
  const selectedIndex = Math.max(0, rows.findIndex((row) => row.path === selectedPath));
  const windowStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxRows / 2),
      rows.length - maxRows,
    ),
  );
  return rows.slice(windowStart, windowStart + maxRows);
}

function renderFieldLine(field, selected, availableWidth, unmaskedPaths) {
  const indent = "  ".repeat(Math.max(0, Number(field.depth || 0)));
  const lock = field.readOnly ? "🔒 " : "";
  const valueText = formatRenderedValue(field, unmaskedPaths);
  const sourceText = `[${formatSourceLabel(field)}]`;
  const body = `${indent}${lock}${field.label}: ${valueText} ${sourceText}`;
  return truncateText(body, availableWidth);
}

export default function SettingsScreen({
  settingsState = {},
  wsBridge,
  onInputCaptureChange,
  onFooterHintsChange,
  settingsService,
  onOpenConnectionManager,
}) {
  const { stdout } = useStdout();
  const service = React.useMemo(
    () => settingsService || createSettingsService(wsBridge, settingsState),
    [settingsService, settingsState, wsBridge],
  );

  const [loading, setLoading] = React.useState(true);
  const [sections, setSections] = React.useState([]);
  const [meta, setMeta] = React.useState({});
  const [selectedPath, setSelectedPath] = React.useState("");
  const [statusMessage, setStatusMessage] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState("");
  const [editingPath, setEditingPath] = React.useState("");
  const [editValue, setEditValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [unmaskedPaths, setUnmaskedPaths] = React.useState(() => new Set());

  const rows = React.useMemo(() => flattenSettingsRows(sections), [sections]);
  const selectableRows = React.useMemo(() => getSelectableSettingRows(rows), [rows]);
  const selectedField = React.useMemo(
    () => getSelectedField(selectableRows, selectedPath),
    [selectableRows, selectedPath],
  );

  const loadModel = React.useCallback(async ({ keepStatus = false } = {}) => {
    setLoading(true);
    setErrorMessage("");
    try {
      const payload = await service.load();
      const nextSections = Array.isArray(payload?.sections) ? payload.sections : [];
      setSections(nextSections);
      setMeta(payload?.meta || {});
      setSelectedPath((current) => {
        if (current && getSelectableSettingRows(flattenSettingsRows(nextSections)).some((row) => row.path === current)) {
          return current;
        }
        return getSelectableSettingRows(flattenSettingsRows(nextSections))[0]?.path || "";
      });
      if (!keepStatus) {
        setStatusMessage(`Loaded ${getSelectableSettingRows(flattenSettingsRows(nextSections)).length} config fields`);
      }
    } catch (error) {
      setErrorMessage(error?.message || String(error));
    } finally {
      setLoading(false);
    }
  }, [service]);

  const saveField = React.useCallback(async (field, nextValue) => {
    if (!field?.path || field.readOnly) return;
    setSaving(true);
    setErrorMessage("");
    try {
      await service.save(field.path, nextValue);
      setStatusMessage(`Saved ${field.path}`);
      setEditingPath("");
      await loadModel({ keepStatus: true });
    } catch (error) {
      setErrorMessage(error?.message || String(error));
    } finally {
      setSaving(false);
    }
  }, [loadModel, service]);

  React.useEffect(() => {
    void loadModel();
  }, [loadModel]);

  React.useEffect(() => {
    if (typeof onInputCaptureChange === "function") {
      onInputCaptureChange(Boolean(editingPath));
    }
  }, [editingPath, onInputCaptureChange]);

  React.useEffect(() => {
    if (typeof onFooterHintsChange === "function") {
      onFooterHintsChange(buildFooterHints({
        editing: Boolean(editingPath),
        selectedField,
      }));
    }
  }, [editingPath, onFooterHintsChange, selectedField]);

  useInput((input, key) => {
    if (loading || saving) return;

    if (input?.toLowerCase() === "c") {
      if (typeof onOpenConnectionManager === "function") {
        onOpenConnectionManager();
      }
      return;
    }

    if (input?.toLowerCase() === "r") {
      void loadModel({ keepStatus: true });
      return;
    }

    if (!selectedField && !editingPath) return;

    if (editingPath) {
      if (key.escape) {
        setEditingPath("");
        setEditValue("");
        setErrorMessage("");
        return;
      }
      if (key.ctrl && input.toLowerCase() === "s") {
        void saveField(selectedField, editValue);
      }
      return;
    }

    if (key.upArrow || input === "k") {
      const currentIndex = Math.max(0, selectableRows.findIndex((row) => row.path === selectedField?.path));
      const nextIndex = Math.max(0, currentIndex - 1);
      setSelectedPath(selectableRows[nextIndex]?.path || selectedField?.path || "");
      return;
    }

    if (key.downArrow || input === "j") {
      const currentIndex = Math.max(0, selectableRows.findIndex((row) => row.path === selectedField?.path));
      const nextIndex = Math.min(selectableRows.length - 1, currentIndex + 1);
      setSelectedPath(selectableRows[nextIndex]?.path || selectedField?.path || "");
      return;
    }

    if ((key.return || input === "\r" || input === "\n") && selectedField) {
      if (selectedField.readOnly) {
        setStatusMessage(`${selectedField.path} is locked by ${selectedField.envKey}`);
        return;
      }
      setEditingPath(selectedField.path);
      setEditValue(selectedField.valueText || "");
      setErrorMessage("");
      return;
    }

    if (input.toLowerCase() === "u" && selectedField?.masked) {
      setUnmaskedPaths((current) => {
        const next = new Set(current);
        if (next.has(selectedField.path)) next.delete(selectedField.path);
        else next.add(selectedField.path);
        return next;
      });
      return;
    }

    if (input === " " && selectedField?.editorKind === "boolean" && !selectedField.readOnly) {
      void saveField(selectedField, toggleBooleanValue(selectedField));
      return;
    }

    if ((key.leftArrow || key.rightArrow) && selectedField?.editorKind === "enum" && !selectedField.readOnly) {
      const nextValue = cycleEnumValue(selectedField, key.rightArrow ? 1 : -1);
      if (nextValue != null) {
        void saveField(selectedField, nextValue);
      }
    }
  });

  const visibleRows = React.useMemo(
    () => sliceVisibleRows(rows, selectedField?.path || selectedPath, Math.max(10, (stdout?.rows || 30) - 11)),
    [rows, selectedField?.path, selectedPath, stdout?.rows],
  );

  const contentWidth = Math.max(40, (stdout?.columns || 120) - 4);
  const resolvedConnectionEndpoint = settingsState.connectionEndpoint || buildTuiHttpUrl({
    host: settingsState?.host || "127.0.0.1",
    port: settingsState?.port || 3080,
    path: "/",
    protocol: settingsState?.protocol || "ws",
  }).replace(/\/$/, "");

  return html`
    <${Box} flexDirection="column" paddingY=${1} paddingX=${1}>
      <${Box} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>bosun.config.json<//>
        <${Text} dimColor>${meta.configPath || settingsState.configDir || "-" }<//>
        <${Text} dimColor>Schema-backed inline editor. Env-sourced values are read-only.<//>
      <//>

      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Backend Connections<//>
        <${Text}>Endpoint: ${resolvedConnectionEndpoint}<//>
        <${Text}>Source: ${settingsState.connectionSource || "default-local"}<//>
        <${Text}>Auth: ${settingsState.authMode === "api-key" ? "API key" : "local token"}<//>
        <${Text}>State: ${settingsState.connectionState || "offline"}<//>
        ${settingsState.localConnection?.endpoint
          ? html`<${Text}>Local Default: ${settingsState.localConnection.endpoint}<//>`
          : null}
        <${Text}>Saved Targets: ${Array.isArray(settingsState.remoteConnections) ? settingsState.remoteConnections.length : 0}<//>
        ${Array.isArray(settingsState.remoteConnections) && settingsState.remoteConnections.length
          ? settingsState.remoteConnections.slice(0, 4).map((connection) => html`
              <${Text} key=${connection.id} dimColor=${connection.id !== settingsState.activeConnectionId}>
                ${connection.id === settingsState.activeConnectionId ? "> " : "  "}${connection.name} -> ${connection.endpoint}
              <//>
            `)
          : null}
        <${Text} dimColor>[C] Manage connections<//>
      <//>

      ${errorMessage
        ? html`
            <${Box} marginTop=${1}>
              <${Text} color="red">${errorMessage}<//>
            <//>
          `
        : null}

      ${statusMessage
        ? html`
            <${Box} marginTop=${1}>
              <${Text} color="green">${statusMessage}<//>
            <//>
          `
        : null}

      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        ${loading
          ? html`<${Text} dimColor>Loading config tree…<//>`
          : visibleRows.map((row) => {
              if (row.kind === "section") {
                return html`
                  <${Box} key=${row.id} marginTop=${1}>
                    <${Text} bold color="cyan">${row.label}<//>
                  <//>
                `;
              }
              if (row.kind === "subsection") {
                return html`
                  <${Box} key=${row.id}>
                    <${Text} bold color="yellow">${row.label}<//>
                  <//>
                `;
              }
              if (row.kind === "group") {
                return html`
                  <${Box} key=${row.id}>
                    <${Text} dimColor>${"  ".repeat(Math.max(0, row.depth || 0))}${row.label}<//>
                  <//>
                `;
              }
              const selected = row.path === selectedField?.path;
              return html`
                <${Box} key=${row.id}>
                  <${Text} inverse=${selected}>
                    ${selected ? "> " : "  "}${renderFieldLine(row, selected, contentWidth, unmaskedPaths)}
                  <//>
                <//>
              `;
            })}
      <//>

      ${selectedField
        ? html`
            <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
              <${Text} bold>${selectedField.path}<//>
              <${Text} dimColor>${selectedField.description || "No description in schema."}<//>
              ${selectedField.readOnly
                ? html`<${Text} color="yellow">🔒 Locked by ${selectedField.envKey}<//>`
                : html`<${Text} dimColor>Source: ${formatSourceLabel(selectedField)}<//>`}
              ${editingPath === selectedField.path
                ? html`
                    <${Box} marginTop=${1}>
                      <${Text} color="cyan">Edit<//>
                      <${Text}> <//>
                      <${TextInput}
                        value=${editValue}
                        onChange=${setEditValue}
                        onSubmit=${() => {}}
                      />
                    <//>
                  `
                : selectedField.editorKind === "enum" && selectedField.enumValues.length
                  ? html`<${Text} dimColor>Options: ${selectedField.enumValues.join(", ")}<//>`
                  : null}
            <//>
          `
        : null}
    <//>
  `;
}
