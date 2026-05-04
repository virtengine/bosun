import React, { useMemo, useState } from "react";
import htm from "htm";
import * as ink from "ink";
import TextInput from "ink-text-input";
import Ajv2020 from "ajv/dist/2020.js";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { ANSI_COLORS, GLYPHS } from "./constants.js";
import { emitConfigReload } from "./config-events.js";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useInput = ink.useInput ?? ink.default?.useInput;

const html = htm.bind(React.createElement);
const SCHEMA_PATH = new URL("../../bosun.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateConfig = ajv.compile(schema);

const GROUPS = Object.freeze([
  {
    label: "General",
    matchers: [
      "$schema",
      "projectName",
      "mode",
      "orchestrator",
      "log",
      "watch",
      "echoLogs",
      "autoFixEnabled",
      "activeWorkspace",
      "voice",
      "telegramUi",
      "cloudflare",
    ],
  },
  {
    label: "Agents",
    matchers: [
      "primaryAgent",
      "interactiveShellEnabled",
      "shellEnabled",
      "codexEnabled",
      "agent",
      "executor",
      "scheduler",
    ],
  },
  { label: "Workflows", matchers: ["workflow", "worktreeBootstrap"] },
  { label: "Kanban", matchers: ["kanban", "jira", "linear"] },
  {
    label: "Integrations",
    matchers: [
      "telegram",
      "github",
      "githubProjectSync",
      "cloudflareApiToken",
      "cloudflareZoneId",
      "cloudflareAccountId",
      "cloudflareTunnelName",
      "cloudflareTunnelId",
      "cloudflareDns",
      "openai",
    ],
  },
  { label: "Cost Rates", matchers: ["costRates"] },
]);

const ENV_PATHS = Object.freeze({
  "kanban.backend": "KANBAN_BACKEND",
  telegramUiPort: "TELEGRAM_UI_PORT",
  telegramBotToken: "TELEGRAM_BOT_TOKEN",
  "githubProjectSync.webhookSecret": "GITHUB_WEBHOOK_SECRET",
  "linear.apiKey": "LINEAR_API_KEY",
  cloudflareApiToken: "CLOUDFLARE_API_TOKEN",
  "costRates.inputPer1M": "COST_RATES_INPUT_PER_1M",
  "costRates.outputPer1M": "COST_RATES_OUTPUT_PER_1M",
});

const SECRET_HINTS = ["token", "secret", "key", "password", "credential"];
const POINTER = GLYPHS.pointer || ">";
const LOCK = "🔒";

function isSecretField(path) {
  const lower = String(path || "").toLowerCase();
  return SECRET_HINTS.some((hint) => lower.includes(hint));
}

function isPrimitiveSchema(node) {
  return Boolean(
    node
      && (node.enum
        || node.type === "string"
        || node.type === "number"
        || node.type === "integer"
        || node.type === "boolean"),
  );
}

function schemaType(node) {
  if (node?.enum) return "enum";
  if (Array.isArray(node?.type)) return node.type[0];
  if (node?.type) return node.type;
  if (node?.oneOf) return "oneOf";
  return "unknown";
}

function flattenSchema(node, prefix = "") {
  const entries = [];
  const properties = node?.properties || {};
  for (const [key, property] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (property?.type === "array") {
      entries.push({ path, key, schema: property, type: "array" });
      continue;
    }
    if (isPrimitiveSchema(property)) {
      entries.push({ path, key, schema: property, type: schemaType(property) });
      continue;
    }
    if (property?.properties) {
      entries.push(...flattenSchema(property, path));
      continue;
    }
    if (property?.type === "object" || property?.additionalProperties) {
      entries.push({ path, key, schema: property, type: "object" });
      continue;
    }
    entries.push({ path, key, schema: property, type: schemaType(property) });
  }
  return entries;
}

const FLAT_FIELDS = flattenSchema(schema);
const ORDERED_FIELDS = GROUPS.flatMap((group) => FLAT_FIELDS.filter((field) => getGroup(field.path) === group.label));

function getAtPath(object, path) {
  return String(path || "")
    .split(".")
    .reduce((current, key) => (current == null ? undefined : current[key]), object);
}

function setAtPath(object, path, value) {
  const clone = structuredClone(object || {});
  const parts = String(path || "").split(".");
  let current = clone;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
  return clone;
}

function getGroup(path) {
  return GROUPS.find((group) => group.matchers.some((matcher) => path === matcher || path.startsWith(`${matcher}.`)))?.label || "General";
}

function getDefaultValue(path) {
  return FLAT_FIELDS.find((entry) => entry.path === path)?.schema?.default;
}

function getSource(path, config) {
  const envKey = ENV_PATHS[path];
  if (envKey && String(process.env[envKey] || "").trim()) {
    return { label: "from env", readOnly: true, value: process.env[envKey] };
  }
  const value = getAtPath(config, path);
  if (value !== undefined) {
    return { label: "from config", readOnly: false, value };
  }
  return { label: "default", readOnly: false, value: getDefaultValue(path) };
}

function formatValue(path, value, showSecrets) {
  if (value == null || value === "") return "-";
  if (isSecretField(path) && !showSecrets) return "****";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function coerceValue(text, field) {
  const value = String(text ?? "").trim();
  if (field.schema?.enum?.includes(value)) return value;
  if (field.type === "number" || field.type === "integer") {
    if (value === "") return Number.NaN;
    return Number(value);
  }
  if (field.type === "boolean") return value === "true";
  if (field.type === "object" || field.type === "array") return JSON.parse(value);
  return value;
}

function atomicWriteJson(filePath, config) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    renameSync(tempPath, filePath);
  } catch (renameError) {
    try {
      rmSync(filePath, { force: true });
      renameSync(tempPath, filePath);
    } catch {
      try {
        copyFileSync(tempPath, filePath);
        unlinkSync(tempPath);
      } catch (copyError) {
        rmSync(tempPath, { force: true });
        throw copyError;
      }
    }
    if (existsSync(tempPath)) {
      rmSync(tempPath, { force: true });
    }
    if (!existsSync(filePath)) {
      throw renameError;
    }
  }
}

function normalizeInstancePath(instancePath = "") {
  return String(instancePath).replace(/^\//, "").replace(/\//g, ".");
}

function formatError(errorObject, field) {
  return `Validation error for ${field.path}: ${errorObject?.message || "invalid value"}`;
}

function findFieldError(field, errors = []) {
  return errors.find((entry) => normalizeInstancePath(entry.instancePath) === field.path)
    || errors.find((entry) => field.path.startsWith(normalizeInstancePath(entry.instancePath)))
    || errors[0];
}

export default function SettingsScreen({ configDir, config = {}, onConfigReload = null }) {
  const configPath = join(configDir, "bosun.config.json");
  const [draftConfig, setDraftConfig] = useState(() => (existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : structuredClone(config || {})));
  const [cursor, setCursor] = useState(0);
  const [editingPath, setEditingPath] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);

  const groupedEntries = useMemo(
    () => GROUPS
      .map((group) => [group.label, FLAT_FIELDS.filter((field) => getGroup(field.path) === group.label)])
      .filter(([, fields]) => fields.length > 0),
    [],
  );
  const orderedFields = useMemo(() => groupedEntries.flatMap(([, fields]) => fields), [groupedEntries]);
  const activeField = orderedFields[cursor] || null;

  const saveField = (field, rawInput) => {
    try {
      const nextValue = coerceValue(rawInput, field);
      const nextConfig = setAtPath(draftConfig, field.path, nextValue);
      const valid = validateConfig(nextConfig);
      if (!valid) {
        const fieldError = findFieldError(field, validateConfig.errors || []);
        setError(formatError(fieldError, field));
        return false;
      }
      atomicWriteJson(configPath, nextConfig);
      setDraftConfig(nextConfig);
      setError("");
      const payload = { configPath, config: nextConfig, reason: "settings-save" };
      emitConfigReload(payload);
      onConfigReload?.(payload);
      return true;
    } catch (saveError) {
      setError(`Validation error for ${field.path}: ${saveError?.message || saveError}`);
      return false;
    }
  };

  useInput((input, key) => {
    if (editingPath) {
      if (key.escape) {
        setEditingPath("");
        setInputValue("");
        setError("");
        return;
      }
      if (key.ctrl && String(input || "").toLowerCase() === "s") {
        const field = orderedFields.find((entry) => entry.path === editingPath);
        if (field && saveField(field, inputValue)) {
          setEditingPath("");
          setInputValue("");
        }
      }
      return;
    }

    if (input === "j" || key.downArrow) {
      setCursor((current) => Math.min(Math.max(0, orderedFields.length - 1), current + 1));
      return;
    }
    if (input === "k" || key.upArrow) {
      setCursor((current) => Math.max(0, current - 1));
      return;
    }
    if (String(input || "").toLowerCase() === "u") {
      setShowSecrets((current) => !current);
      return;
    }
    if (!activeField) return;

    const source = getSource(activeField.path, draftConfig);
    if (source.readOnly) return;

    if ((key.leftArrow || key.rightArrow) && Array.isArray(activeField.schema?.enum)) {
      const values = activeField.schema.enum;
      const currentIndex = Math.max(0, values.indexOf(source.value));
      const nextIndex = key.rightArrow
        ? (currentIndex + 1) % values.length
        : (currentIndex - 1 + values.length) % values.length;
      saveField(activeField, values[nextIndex]);
      return;
    }
    if ((key.return || input === "\r") && activeField.type !== "boolean" && !Array.isArray(activeField.schema?.enum)) {
      setEditingPath(activeField.path);
      setInputValue(source.value == null ? "" : typeof source.value === "string" ? source.value : JSON.stringify(source.value));
      setError("");
      return;
    }
    if (input === " " && activeField.type === "boolean") {
      saveField(activeField, !Boolean(source.value));
    }
  });

  return html`
    <${Box} flexDirection="column">
      <${Text} bold>Settings<//>
      <${Text} color=${ANSI_COLORS.muted}>Edit bosun.config.json inline. Enter edits, Ctrl+S saves, Esc cancels, Space toggles booleans, arrows cycle enums, U unmasks secrets.<//>
      ${groupedEntries.map(([group, groupFields]) => html`
        <${Box} key=${group} flexDirection="column" marginTop=${1}>
          <${Text} bold color=${ANSI_COLORS.accent}>${group}<//>
          ${groupFields.map((field) => {
            const index = orderedFields.findIndex((entry) => entry.path === field.path);
            const selected = index === cursor;
            const source = getSource(field.path, draftConfig);
            const isEditing = editingPath === field.path;
            return html`
              <${Box} key=${field.path}>
                <${Text} color=${selected ? ANSI_COLORS.accent : undefined}>${selected ? `${POINTER} ` : "  "}<//>
                <${Text} dimColor>${field.path}<//>
                <${Text}>: <//>
                ${isEditing
                  ? html`<${TextInput} value=${inputValue} onChange=${setInputValue} />`
                  : html`<${Text} color="white">${source.readOnly ? `${LOCK} ` : ""}${formatValue(field.path, source.value, showSecrets)}<//>`}
                <${Text} dimColor> (${source.label})<//>
              <//>
            `;
          })}
        <//>
      `)}
      ${error ? html`<${Text} color=${ANSI_COLORS.danger}>${error}<//>` : null}
    <//>
  `;
}

export {
  FLAT_FIELDS,
  GROUPS,
  ORDERED_FIELDS,
  atomicWriteJson,
  coerceValue,
  formatValue,
  getGroup,
  getSource,
  isSecretField,
};
