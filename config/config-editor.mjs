import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

export const CONFIG_EDITOR_SECTIONS = Object.freeze([
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "workflows", label: "Workflows" },
  { id: "kanban", label: "Kanban" },
  { id: "integrations", label: "Integrations" },
  { id: "cost-rates", label: "Cost Rates" },
]);

const SECTION_BY_ID = new Map(CONFIG_EDITOR_SECTIONS.map((section) => [section.id, section]));
const SENSITIVE_PATH_PATTERN = /(token|secret|api[_-]?key|credential|access[_-]?token|private[_-]?key|password)/i;
let cachedSchema = null;
let cachedValidator = null;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getSchemaTypes(schema = {}) {
  if (Array.isArray(schema?.type)) return schema.type.filter(Boolean);
  if (schema?.type) return [schema.type];
  if (Array.isArray(schema?.enum)) return ["string"];
  if (Array.isArray(schema?.oneOf)) {
    const collected = [];
    for (const option of schema.oneOf) {
      collected.push(...getSchemaTypes(option));
    }
    return [...new Set(collected)];
  }
  if (schema?.properties) return ["object"];
  if (schema?.items) return ["array"];
  return ["string"];
}

function getEditorKind(schema = {}) {
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) return "enum";
  const types = getSchemaTypes(schema);
  if (types.includes("boolean")) return "boolean";
  if (types.includes("number") || types.includes("integer")) return "number";
  if (types.includes("object") || types.includes("array")) return "json";
  if (Array.isArray(schema?.oneOf) && !types.includes("string")) return "json";
  return "string";
}

function describeSchemaType(schema = {}) {
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) return "enum";
  const types = getSchemaTypes(schema);
  if (types.length === 1) return types[0];
  return types.join("|");
}

function isGroupSchema(schema = {}) {
  return isPlainObject(schema?.properties);
}

function shouldShowAsJsonText(schema = {}) {
  return getEditorKind(schema) === "json";
}

function determineSection(pathParts = []) {
  const [root] = pathParts;
  if (!root) return { sectionId: "general", subsection: null };
  if (root === "kanban") return { sectionId: "kanban", subsection: null };
  if (
    root.startsWith("workflow")
    || root === "workflows"
    || root === "worktreeBootstrap"
    || root === "plannerMode"
    || root === "triggerSystem"
  ) {
    return { sectionId: "workflows", subsection: null };
  }
  if (
    root.startsWith("telegram")
    || root.startsWith("cloudflare")
  ) {
    return { sectionId: "integrations", subsection: "Telegram" };
  }
  if (root === "voice") {
    return { sectionId: "integrations", subsection: "Voice" };
  }
  if (
    root === "prAutomation"
    || root === "gates"
  ) {
    return { sectionId: "integrations", subsection: "GitHub" };
  }
  if (
    root === "auth"
    || root === "internalExecutor"
    || root === "executors"
    || root === "failover"
    || root === "distribution"
    || root === "primaryAgent"
    || root === "profiles"
    || root === "envProfiles"
    || root === "agentPrompts"
    || root === "hookProfiles"
    || root === "agentHooks"
    || root === "markdownSafety"
    || root === "interactiveShellEnabled"
    || root === "shellEnabled"
    || root === "codexEnabled"
  ) {
    return { sectionId: "agents", subsection: null };
  }
  return { sectionId: "general", subsection: null };
}

function ensureSectionBucket(buckets, sectionId, subsection = null) {
  if (!buckets.has(sectionId)) {
    buckets.set(sectionId, {
      id: sectionId,
      label: SECTION_BY_ID.get(sectionId)?.label || sectionId,
      subsections: new Map(),
      items: [],
    });
  }
  const section = buckets.get(sectionId);
  if (!subsection) return section.items;
  if (!section.subsections.has(subsection)) {
    section.subsections.set(subsection, []);
  }
  return section.subsections.get(subsection);
}

function normalizeDisplayValue(schema, value) {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (shouldShowAsJsonText(schema)) return JSON.stringify(value);
  if (Array.isArray(schema?.enum) && schema.enum.includes(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (Array.isArray(value) || isPlainObject(value)) return JSON.stringify(value);
  return String(value);
}

export function getConfigValueAtPath(obj, pathParts = []) {
  let cursor = obj;
  for (const part of pathParts) {
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) return undefined;
    if (!hasOwn(cursor, part)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function setConfigValueAtPath(obj, pathParts = [], value) {
  let cursor = obj;
  for (let index = 0; index < pathParts.length; index += 1) {
    const part = pathParts[index];
    if (DANGEROUS_KEYS.has(part)) {
      console.warn(`[config-editor] setConfigValueAtPath: rejected dangerous key "${part}"`);
      return obj;
    }
    if (index === pathParts.length - 1) {
      Object.defineProperty(cursor, part, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return obj;
    }
    if (!isPlainObject(cursor[part])) {
      Object.defineProperty(cursor, part, {
        value: {},
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    cursor = cursor[part];
  }
  return obj;
}

export function getConfigSchemaProperty(schema, pathParts = []) {
  let cursor = schema;
  for (const part of pathParts) {
    if (!isPlainObject(cursor?.properties)) return null;
    cursor = cursor.properties[part];
  }
  return cursor || null;
}

export function isSensitiveConfigPath(pathParts = [], schema = {}) {
  if (schema?.sensitive === true) return true;
  return pathParts.some((part) => SENSITIVE_PATH_PATTERN.test(String(part || "")));
}

export function buildConfigEditorModel({
  schema,
  configData = {},
  envOverridesByPath = new Map(),
} = {}) {
  const buckets = new Map();
  const fieldIndex = new Map();

  const visit = (node, pathParts = [], depth = 0) => {
    if (!node) return;
    const { sectionId, subsection } = determineSection(pathParts);
    const items = ensureSectionBucket(buckets, sectionId, subsection);
    const path = pathParts.join(".");

    if (pathParts.length > 0 && isGroupSchema(node)) {
      items.push({
        kind: "group",
        id: `group:${path}`,
        path,
        depth,
        label: pathParts[pathParts.length - 1],
        description: node.description || "",
      });
    }

    if (isGroupSchema(node)) {
      const childDepth = pathParts.length > 0 ? depth + 1 : depth;
      for (const [childKey, childNode] of Object.entries(node.properties)) {
        visit(childNode, [...pathParts, childKey], childDepth);
      }
      return;
    }

    if (pathParts.length === 0) return;

    const envOverride = envOverridesByPath.get(path) || null;
    const hasConfigValue = getConfigValueAtPath(configData, pathParts) !== undefined;
    const configValue = getConfigValueAtPath(configData, pathParts);
    const hasDefault = hasOwn(node, "default");
    const source = envOverride
      ? "env"
      : hasConfigValue
        ? "config"
        : "default";
    const rawValue = envOverride
      ? envOverride.value
      : hasConfigValue
        ? configValue
        : hasDefault
          ? node.default
          : undefined;
    const field = {
      kind: "field",
      id: path,
      path,
      pathParts: [...pathParts],
      depth,
      label: pathParts[pathParts.length - 1],
      source,
      sourceLabel: source === "env" ? "from env" : source === "config" ? "from config" : "default",
      readOnly: Boolean(envOverride),
      envKey: envOverride?.envKey || null,
      masked: isSensitiveConfigPath(pathParts, node),
      editorKind: getEditorKind(node),
      schemaType: describeSchemaType(node),
      enumValues: Array.isArray(node.enum) ? [...node.enum] : [],
      description: node.description || "",
      rawValue,
      valueText: normalizeDisplayValue(node, rawValue),
    };
    items.push(field);
    fieldIndex.set(path, field);
  };

  visit(schema, [], 0);

  const sections = CONFIG_EDITOR_SECTIONS.map((section) => {
    const bucket = buckets.get(section.id);
    const items = [];
    if (bucket) {
      items.push(...bucket.items);
      for (const [subsection, subsectionItems] of bucket.subsections.entries()) {
        items.push({
          kind: "subsection",
          id: `subsection:${section.id}:${subsection}`,
          sectionId: section.id,
          label: subsection,
          depth: 0,
        });
        items.push(...subsectionItems);
      }
    }
    return {
      id: section.id,
      label: section.label,
      items,
    };
  });

  return {
    sections,
    fieldIndex,
  };
}

function parseStrictBoolean(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("Expected boolean value");
}

function parseNumericValue(value, { integer = false } = {}) {
  const numeric = Number(String(value ?? "").trim());
  if (!Number.isFinite(numeric)) {
    throw new Error(`Expected ${integer ? "integer" : "number"} value`);
  }
  if (integer && !Number.isInteger(numeric)) {
    throw new Error("Expected integer value");
  }
  return numeric;
}

export function parseConfigEditorInput(schema, rawValue) {
  const editorKind = getEditorKind(schema);

  if (editorKind === "boolean") {
    return parseStrictBoolean(rawValue);
  }
  if (editorKind === "number") {
    const integer = getSchemaTypes(schema).includes("integer");
    return parseNumericValue(rawValue, { integer });
  }
  if (editorKind === "enum") {
    const value = String(rawValue ?? "");
    if (!Array.isArray(schema?.enum) || schema.enum.includes(value)) return value;
    throw new Error(`Expected one of: ${schema.enum.join(", ")}`);
  }
  if (editorKind === "json") {
    if (Array.isArray(rawValue) || isPlainObject(rawValue)) return rawValue;
    const text = String(rawValue ?? "").trim();
    if (!text) throw new Error("Expected JSON value");
    if (Array.isArray(schema?.oneOf) && !text.startsWith("{") && !text.startsWith("[")) {
      return text;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }
  }
  return String(rawValue ?? "");
}

export function validateConfigDocument(schema, candidate) {
  if (!schema) return [];
  if (cachedSchema !== schema || typeof cachedValidator !== "function") {
    const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    cachedValidator = ajv.compile(schema);
    cachedSchema = schema;
  }
  const valid = cachedValidator(candidate);
  return valid ? [] : [...(cachedValidator.errors || [])];
}

function escapeJsonPointer(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function findConfigValidationMessage(errors = [], pathParts = []) {
  const targetPath = `/${pathParts.map(escapeJsonPointer).join("/")}`;
  const direct = errors.find((error) => String(error?.instancePath || "") === targetPath);
  if (direct) return direct.message || "Invalid value";

  const child = errors.find((error) => String(error?.instancePath || "").startsWith(`${targetPath}/`));
  if (child) return child.message || "Invalid value";

  const required = errors.find((error) => {
    if (error?.keyword !== "required") return false;
    const instancePath = String(error?.instancePath || "");
    const missingProperty = String(error?.params?.missingProperty || "");
    const fullPath = `${instancePath}/${escapeJsonPointer(missingProperty)}`;
    return fullPath === targetPath;
  });
  if (required) return `${pathParts[pathParts.length - 1]} is required`;

  return errors[0]?.message || "Config validation failed";
}

export function writeJsonFileAtomic(filePath, data) {
  const targetPath = resolve(filePath);
  const tempPath = resolve(
    dirname(targetPath),
    `.${basename(targetPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  try {
    writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export function cloneConfigDocument(configData = {}) {
  return cloneJson(configData);
}
