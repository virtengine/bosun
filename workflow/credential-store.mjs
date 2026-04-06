/**
 * credential-store.mjs — Unified Credential & Secret Management
 *
 * Provides a centralised store for API keys, tokens, and environment variable
 * references that workflow nodes can consume without hard-coding secrets.
 *
 * Credential types:
 *   - "static"  — value stored directly (encrypted at rest with AES-256-GCM)
 *   - "env"     — reference to an environment variable resolved at runtime
 *   - "config"  — reference to a bosun.config.json field
 *
 * Storage: {configDir}/.bosun/credentials.json
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TAG = "[credential-store]";
const ALGO = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = "sha512";
const SALT = "bosun-credential-store-v2";
const STORE_VERSION = 2;
const STATIC_TYPES = new Set(["static", "env", "config"]);
const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function hasValue(value) {
  if (Array.isArray(value)) return value.some(hasValue);
  if (value && typeof value === "object") return Object.values(value).some(hasValue);
  return toTrimmedString(value) !== "";
}

function normalizeStringArray(values, fallback = []) {
  const list = Array.isArray(values) ? values : fallback;
  return [...new Set(list.map((entry) => toTrimmedString(entry)).filter(Boolean))];
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
    );
  }
  return value;
}

function getNestedValue(source, path) {
  const segments = String(path || "")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;
  let current = source;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function normalizeTemplateValue(value) {
  if (Array.isArray(value)) return value.map((entry) => normalizeTemplateValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeTemplateValue(entry)]),
    );
  }
  return typeof value === "string" ? value : value ?? null;
}

function normalizeCredentialValidation(validation = {}) {
  if (!validation || typeof validation !== "object") return null;
  const normalized = {
    required: validation.required !== false,
    message: toTrimmedString(validation.message) || null,
    prefix: toTrimmedString(validation.prefix) || null,
    pattern: toTrimmedString(validation.pattern) || null,
    minLength: Number.isFinite(Number(validation.minLength)) ? Number(validation.minLength) : null,
    expiresAt: toTrimmedString(validation.expiresAt || validation.expiry || "") || null,
  };
  return normalized;
}

function normalizeCredentialLifecycle(lifecycle = {}) {
  if (!lifecycle || typeof lifecycle !== "object") return null;
  const normalized = {
    authMode: toTrimmedString(lifecycle.authMode || lifecycle.mode || "") || null,
    refreshable: lifecycle.refreshable === true,
    managed: lifecycle.managed !== false,
    source: toTrimmedString(lifecycle.source || "") || null,
    accountId: toTrimmedString(lifecycle.accountId || "") || null,
    missingMessage: toTrimmedString(lifecycle.missingMessage || "") || null,
    lastValidatedAt: toTrimmedString(lifecycle.lastValidatedAt || "") || null,
  };
  return normalized;
}

function normalizeCredentialRefresh(refresh = {}) {
  if (!refresh || typeof refresh !== "object") return null;
  const normalized = {
    url: toTrimmedString(refresh.url || refresh.tokenUrl || "") || null,
    method: toTrimmedString(refresh.method || "POST").toUpperCase() || "POST",
    headers: normalizeTemplateValue(refresh.headers || {}),
    query: normalizeTemplateValue(refresh.query || {}),
    body: normalizeTemplateValue(refresh.body || {}),
  };
  return normalized;
}

function normalizeCredentialTemplates(templates = {}) {
  if (!templates || typeof templates !== "object") return null;
  return {
    headers: normalizeTemplateValue(templates.headers || {}),
    query: normalizeTemplateValue(templates.query || {}),
    body: normalizeTemplateValue(templates.body || {}),
  };
}

function buildTemplateScopes(context = {}) {
  const credential = context.credential && typeof context.credential === "object"
    ? context.credential
    : {};
  const provider = context.provider && typeof context.provider === "object"
    ? context.provider
    : {};
  const env = context.env && typeof context.env === "object" ? context.env : process.env;
  const config = context.config && typeof context.config === "object" ? context.config : {};
  const runtime = context.runtime && typeof context.runtime === "object"
    ? context.runtime
    : {};
  return {
    credential,
    provider,
    env,
    config,
    context: runtime,
    now: {
      iso: new Date().toISOString(),
      epochMs: Date.now(),
    },
  };
}

export function resolveCredentialTemplateValue(template, context = {}) {
  const scopes = buildTemplateScopes(context);
  if (Array.isArray(template)) {
    return template.map((entry) => resolveCredentialTemplateValue(entry, context));
  }
  if (template && typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [
        key,
        resolveCredentialTemplateValue(value, context),
      ]),
    );
  }
  if (typeof template !== "string") return template ?? null;

  const exactMatch = template.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (exactMatch) {
    const resolved = getNestedValue(scopes, exactMatch[1]);
    return resolved === undefined ? "" : resolved;
  }

  return template.replace(TEMPLATE_PATTERN, (_match, rawPath) => {
    const resolved = getNestedValue(scopes, rawPath);
    if (resolved == null) return "";
    if (typeof resolved === "object") return JSON.stringify(resolved);
    return String(resolved);
  });
}

function deriveKey(secret) {
  return pbkdf2Sync(secret, SALT, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

function normalizeCredentialEntry(name, entry = {}) {
  const scopes = normalizeStringArray(entry.scopes, ["*"]);
  const validation = normalizeCredentialValidation(entry.validation);
  const lifecycle = normalizeCredentialLifecycle(entry.lifecycle);
  const refresh = normalizeCredentialRefresh(entry.refresh);
  const templates = normalizeCredentialTemplates(entry.templates);
  return {
    type: STATIC_TYPES.has(entry.type) ? entry.type : "static",
    value: entry.value,
    iv: entry.iv || null,
    tag: entry.tag || null,
    label: toTrimmedString(entry.label || "") || name,
    provider: toTrimmedString(entry.provider || "") || null,
    scopes: scopes.length > 0 ? scopes : ["*"],
    createdAt: toTrimmedString(entry.createdAt || "") || new Date().toISOString(),
    updatedAt: toTrimmedString(entry.updatedAt || "") || new Date().toISOString(),
    validation,
    lifecycle,
    refresh,
    templates,
    metadata: entry.metadata && typeof entry.metadata === "object" ? cloneValue(entry.metadata) : null,
  };
}

export class CredentialStore {
  #storePath;
  #encryptionKey = null;
  #hasEncryption = false;
  #data = { _meta: { version: STORE_VERSION, createdAt: new Date().toISOString() }, credentials: {} };

  constructor({ configDir, secretKey } = {}) {
    if (!configDir) throw new Error("CredentialStore requires a configDir option");
    const bosunDir = resolve(configDir, ".bosun");
    this.#storePath = resolve(bosunDir, "credentials.json");

    const secret = secretKey || process.env.BOSUN_SECRET_KEY;
    if (secret) {
      this.#encryptionKey = deriveKey(secret);
      this.#hasEncryption = true;
    }
    this.#load();
  }

  get encrypted() { return this.#hasEncryption; }

  set(name, {
    type,
    value,
    label,
    provider,
    scopes,
    validation,
    lifecycle,
    refresh,
    templates,
    metadata,
  } = {}) {
    const n = toTrimmedString(name);
    if (!n) throw new Error("Credential name is required");
    if (!STATIC_TYPES.has(type)) {
      throw new Error(`Invalid credential type "${type}" — must be static, env, or config`);
    }
    if (typeof value !== "string" || !value) {
      throw new Error("Credential value is required");
    }

    const now = new Date().toISOString();
    const existing = this.#data.credentials[n];
    const next = normalizeCredentialEntry(n, {
      ...(existing || {}),
      type,
      label: label || existing?.label || n,
      provider: provider || existing?.provider || null,
      scopes: Array.isArray(scopes) ? scopes : (existing?.scopes || ["*"]),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      validation: validation || existing?.validation || null,
      lifecycle: lifecycle || existing?.lifecycle || null,
      refresh: refresh || existing?.refresh || null,
      templates: templates || existing?.templates || null,
      metadata: metadata || existing?.metadata || null,
    });

    if (type === "static") {
      if (this.#hasEncryption) {
        const { encrypted, iv, tag } = this.#encrypt(value);
        next.value = encrypted;
        next.iv = iv;
        next.tag = tag;
      } else {
        console.warn(`${TAG} BOSUN_SECRET_KEY not set — storing credential "${n}" unencrypted`);
        next.value = value;
        next.iv = null;
        next.tag = null;
      }
    } else {
      next.value = value;
      next.iv = null;
      next.tag = null;
    }

    this.#data.credentials[n] = next;
    this.#save();
    return { name: n, type };
  }

  resolve(name, { workflowId, env = process.env, config = null } = {}) {
    const resolved = this.resolveEntry(name, { workflowId, env, config, includeValue: true });
    return resolved?.value ?? null;
  }

  resolveEntry(name, { workflowId, env = process.env, config = null, includeValue = false } = {}) {
    const n = toTrimmedString(name);
    const entry = this.#data.credentials[n];
    if (!entry) return null;
    if (workflowId && !this.#checkScope(entry, workflowId)) return null;

    const value = this.#resolveEntryValue(entry, { env, config });
    const validation = this.validate(n, { workflowId, env, config });
    const meta = this.get(n);
    return {
      ...meta,
      available: hasValue(value),
      value: includeValue ? value : null,
      status: validation.status,
      validationErrors: validation.errors,
      lifecycle: cloneValue(entry.lifecycle),
      refresh: cloneValue(entry.refresh),
      templates: cloneValue(entry.templates),
      metadata: cloneValue(entry.metadata),
    };
  }

  resolveTemplates(name, templates = null, options = {}) {
    const entry = this.resolveEntry(name, { ...options, includeValue: true });
    if (!entry) {
      return { headers: {}, query: {}, body: {} };
    }
    const templateSet = templates || entry.templates || {};
    const providerId = toTrimmedString(options.providerId || entry.provider || "");
    const context = {
      credential: {
        name: entry.name,
        label: entry.label,
        provider: entry.provider,
        type: entry.type,
        value: entry.value,
        encrypted: entry.encrypted,
        expiresAt: entry.lifecycle?.expiresAt || entry.validation?.expiresAt || null,
        metadata: entry.metadata || null,
      },
      provider: {
        id: providerId || entry.provider || null,
        authMode: entry.lifecycle?.authMode || null,
      },
      env: options.env || process.env,
      config: options.config || {},
      runtime: options.context || {},
    };
    return {
      headers: resolveCredentialTemplateValue(templateSet.headers || {}, context),
      query: resolveCredentialTemplateValue(templateSet.query || {}, context),
      body: resolveCredentialTemplateValue(templateSet.body || {}, context),
    };
  }

  validate(name, { workflowId, env = process.env, config = null } = {}) {
    const n = toTrimmedString(name);
    const entry = this.#data.credentials[n];
    if (!entry) {
      return { ok: false, status: "missing", errors: ["Credential not found"], value: null };
    }
    if (workflowId && !this.#checkScope(entry, workflowId)) {
      return { ok: false, status: "blocked", errors: [`Credential "${n}" is out of scope for workflow "${workflowId}"`], value: null };
    }

    const value = this.#resolveEntryValue(entry, { env, config });
    const validation = entry.validation || {};
    const lifecycle = entry.lifecycle || {};
    const errors = [];

    if (validation.required !== false && !hasValue(value)) {
      errors.push(validation.message || "Credential value is missing");
    }
    if (hasValue(value) && validation.prefix && !String(value).startsWith(validation.prefix)) {
      errors.push(validation.message || `Credential must start with "${validation.prefix}"`);
    }
    if (hasValue(value) && validation.minLength && String(value).length < validation.minLength) {
      errors.push(validation.message || `Credential must be at least ${validation.minLength} characters`);
    }
    if (hasValue(value) && validation.pattern) {
      try {
        const pattern = new RegExp(validation.pattern);
        if (!pattern.test(String(value))) {
          errors.push(validation.message || "Credential does not match the required format");
        }
      } catch {
        errors.push(`Credential validation pattern for "${n}" is invalid`);
      }
    }

    const expiresAt = toTrimmedString(validation.expiresAt || lifecycle.expiresAt || "");
    const expiryMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    const expired = Number.isFinite(expiryMs) && expiryMs <= Date.now();
    const expiringSoon = Number.isFinite(expiryMs) && expiryMs > Date.now() && expiryMs <= Date.now() + 15 * 60 * 1000;
    if (expired) errors.push(validation.message || "Credential has expired");

    const status = errors.length > 0
      ? (expired ? "expired" : (!hasValue(value) ? "missing" : "invalid"))
      : (expiringSoon ? "expiring" : "ready");

    return {
      ok: errors.length === 0,
      status,
      errors,
      value,
      expiresAt: expiresAt || null,
      expiringSoon,
      refreshable: lifecycle.refreshable === true || Boolean(entry.refresh?.url),
    };
  }

  get(name) {
    const n = toTrimmedString(name);
    const entry = this.#data.credentials[n];
    if (!entry) return null;
    return {
      name: n,
      type: entry.type,
      label: entry.label,
      provider: entry.provider,
      scopes: cloneValue(entry.scopes),
      encrypted: entry.type === "static" && !!entry.iv,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      validation: cloneValue(entry.validation),
      lifecycle: cloneValue(entry.lifecycle),
      refresh: cloneValue(entry.refresh),
      templates: cloneValue(entry.templates),
      metadata: cloneValue(entry.metadata),
    };
  }

  list() {
    return Object.keys(this.#data.credentials).map((n) => this.get(n));
  }

  listByProvider(providerId = "") {
    const normalizedProviderId = toTrimmedString(providerId).toLowerCase();
    if (!normalizedProviderId) return [];
    return this.list().filter((entry) => toTrimmedString(entry?.provider).toLowerCase() === normalizedProviderId);
  }

  delete(name) {
    const n = toTrimmedString(name);
    const existed = n in this.#data.credentials;
    if (existed) {
      delete this.#data.credentials[n];
      this.#save();
    }
    return existed;
  }

  has(name) {
    return toTrimmedString(name) in this.#data.credentials;
  }

  get size() {
    return Object.keys(this.#data.credentials).length;
  }

  setScopes(name, scopes) {
    const entry = this.#data.credentials[toTrimmedString(name)];
    if (!entry) return false;
    entry.scopes = normalizeStringArray(scopes, ["*"]);
    entry.updatedAt = new Date().toISOString();
    this.#save();
    return true;
  }

  #resolveEntryValue(entry, { env = process.env, config = null } = {}) {
    switch (entry.type) {
      case "static":
        if (entry.iv && entry.tag && this.#hasEncryption) {
          return this.#decrypt(entry.value, entry.iv, entry.tag);
        }
        return entry.value || null;
      case "env":
        return env?.[entry.value] || null;
      case "config":
        if (config && typeof config === "object") {
          const fromConfig = getNestedValue(config, entry.value);
          if (hasValue(fromConfig)) return fromConfig;
        }
        return env?.[entry.value] || null;
      default:
        return null;
    }
  }

  #checkScope(entry, workflowId) {
    if (!Array.isArray(entry.scopes) || entry.scopes.length === 0) return true;
    if (entry.scopes.includes("*")) return true;
    return entry.scopes.includes(workflowId);
  }

  #encrypt(plaintext) {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGO, this.#encryptionKey, iv);
    let encrypted = cipher.update(plaintext, "utf8", "base64");
    encrypted += cipher.final("base64");
    const tag = cipher.getAuthTag();
    return {
      encrypted,
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
    };
  }

  #decrypt(ciphertext, ivHex, tagHex) {
    try {
      const iv = Buffer.from(ivHex, "hex");
      const tag = Buffer.from(tagHex, "hex");
      const decipher = createDecipheriv(ALGO, this.#encryptionKey, iv);
      decipher.setAuthTag(tag);
      let dec = decipher.update(ciphertext, "base64", "utf8");
      dec += decipher.final("utf8");
      return dec;
    } catch (err) {
      console.warn(`${TAG} decryption failed: ${err?.message || err}`);
      return null;
    }
  }

  #load() {
    try {
      if (!existsSync(this.#storePath)) return;
      const raw = readFileSync(this.#storePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.credentials) return;
      this.#data = {
        _meta: {
          version: Number(parsed?._meta?.version || STORE_VERSION),
          createdAt: toTrimmedString(parsed?._meta?.createdAt || "") || new Date().toISOString(),
        },
        credentials: Object.fromEntries(
          Object.entries(parsed.credentials || {}).map(([name, entry]) => [
            name,
            normalizeCredentialEntry(name, entry),
          ]),
        ),
      };
    } catch (err) {
      console.warn(`${TAG} failed to load credential store: ${err?.message || err}`);
    }
  }

  #save() {
    try {
      const dir = dirname(this.#storePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.#storePath, JSON.stringify(this.#data, null, 2), "utf8");
    } catch (err) {
      console.warn(`${TAG} failed to save credential store: ${err?.message || err}`);
    }
  }
}

export default CredentialStore;
