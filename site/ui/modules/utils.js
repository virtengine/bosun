/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Utility Helpers
 *  Pure functions – no framework imports needed
 * ────────────────────────────────────────────────────────────── */

/**
 * Format a Date (or ISO string) to a locale-aware string.
 * @param {Date|string|number} d
 * @returns {string}
 */
export function formatDate(d) {
  if (!d) return "—";
  try {
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return String(d);
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(d);
  }
}

/**
 * Format a Date to a relative "Xm ago"/"Xh ago"/"Xd ago" string.
 * @param {Date|string|number} d
 * @returns {string}
 */
export function formatRelative(d) {
  if (d === null || d === undefined || d === "") return "—";
  try {
    let date;
    if (d instanceof Date) {
      date = d;
    } else if (typeof d === "number") {
      if (!Number.isFinite(d)) return "—";
      const normalized = Math.abs(d) < 1e12 ? d * 1000 : d;
      date = new Date(normalized);
    } else {
      date = new Date(d);
    }
    const timestamp = date.getTime();
    if (!Number.isFinite(timestamp)) return "—";
    const diffMs = Date.now() - timestamp;
    if (!Number.isFinite(diffMs)) return "—";
    if (diffMs < 0) return "just now";
    const seconds = Math.floor(diffMs / 1000);
    if (!Number.isFinite(seconds)) return "—";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (!Number.isFinite(minutes)) return "—";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (!Number.isFinite(hours)) return "—";
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (!Number.isFinite(days)) return "—";
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (!Number.isFinite(months)) return "—";
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(months / 12);
    if (!Number.isFinite(years)) return "—";
    return `${years}y ago`;
  } catch {
    return "—";
  }
}

/**
 * Format milliseconds to a human-readable duration: "Xm Ys" or "Xh Ym".
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms == null || isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m`;
}

/**
 * Truncate a string, appending "…" if it exceeds maxLen.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncate(str, maxLen = 60) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/**
 * Debounce a function.
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function debounce(fn, ms = 300) {
  let timer = null;
  const debounced = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}

/**
 * Deep clone a value via JSON round-trip. Returns null on failure.
 * Prefers structuredClone when available.
 * @param {*} v
 * @returns {*}
 */
export function cloneValue(v) {
  if (v === null || v === undefined) return v;
  try {
    if (typeof structuredClone === "function") return structuredClone(v);
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

/**
 * Format a byte count to a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  const idx = Math.min(i, units.length - 1);
  const value = bytes / Math.pow(k, idx);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[idx]}`;
}

/**
 * Pluralize a word based on count.
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string}
 */
export function pluralize(count, singular, plural) {
  const p = plural || `${singular}s`;
  return `${count} ${count === 1 ? singular : p}`;
}

/**
 * Generate a simple unique ID (not crypto-grade).
 * @returns {string}
 */
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Promisified setTimeout.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Conditional class name builder (similar to clsx / classnames).
 * Accepts strings, objects { className: boolean }, and arrays.
 * @param {...(string|object|Array|null|undefined|false)} args
 * @returns {string}
 */
export function classNames(...args) {
  const classes = [];
  for (const arg of args) {
    if (!arg) continue;
    if (typeof arg === "string") {
      classes.push(arg);
    } else if (Array.isArray(arg)) {
      const inner = classNames(...arg);
      if (inner) classes.push(inner);
    } else if (typeof arg === "object") {
      for (const [key, val] of Object.entries(arg)) {
        if (val) classes.push(key);
      }
    }
  }
  return classes.join(" ");
}

/**
 * Build a stable serialized representation for change detection.
 * Object keys are sorted to avoid order-related false positives.
 * @param {*} value
 * @returns {string}
 */
export function stableSerialize(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) {
    return `"${String(value)}"`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Count changed top-level fields between two plain objects.
 * Values are compared using stable serialization.
 * @param {Record<string, any>} initial
 * @param {Record<string, any>} current
 * @returns {number}
 */
export function countChangedFields(initial = {}, current = {}) {
  const base = initial && typeof initial === "object" ? initial : {};
  const next = current && typeof current === "object" ? current : {};
  const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
  let changed = 0;
  for (const key of keys) {
    if (stableSerialize(base[key]) !== stableSerialize(next[key])) {
      changed += 1;
    }
  }
  return changed;
}

/* ─── Data Export Utilities ─── */

/**
 * Trigger a file download from in-memory content.
 * @param {string} content
 * @param {string} filename
 * @param {string} [mimeType='text/plain']
 */
export function downloadFile(content, filename, mimeType = "text/plain") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Escape a value for CSV (RFC 4180).
 * @param {*} val
 * @returns {string}
 */
function csvEscape(val) {
  const str = val == null ? "" : String(val);
  if (/[",\n\r]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Export tabular data as a CSV file download.
 * Adds a UTF-8 BOM for Excel compatibility.
 * @param {string[]} headers
 * @param {Array<Array<*>>} rows
 * @param {string} filename
 */
export function exportAsCSV(headers, rows, filename) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  const csv = "\uFEFF" + lines.join("\r\n");
  downloadFile(csv, filename, "text/csv");
}

/**
 * Export data as a pretty-printed JSON file download.
 * @param {*} data
 * @param {string} filename
 */
export function exportAsJSON(data, filename) {
  const json = JSON.stringify(data, null, 2);
  downloadFile(json, filename, "application/json");
}
