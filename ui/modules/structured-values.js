export function isStructuredValue(value) {
  return value != null && typeof value === "object";
}

export function toEditableTextValue(value, options = {}) {
  const pretty = options.pretty !== false;
  const fallback = options.fallback ?? "";
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isStructuredValue(value)) {
    try {
      return JSON.stringify(value, null, pretty ? 2 : 0);
    } catch {
      return fallback || String(value);
    }
  }
  return String(value);
}

export function inferStructuredInputKind(spec = {}) {
  const normalizedType = String(spec.type || spec.inputKind || "").trim().toLowerCase();
  if (normalizedType === "json" || normalizedType === "object") return "json";
  if (normalizedType) return normalizedType;
  if (isStructuredValue(spec.value) || isStructuredValue(spec.defaultValue)) return "json";
  return "text";
}

export function formatStructuredValuePreview(value, options = {}) {
  const maxChars = Math.max(8, Number(options.maxChars || 44) || 44);
  const fallbackEmpty = options.fallbackEmpty || "empty";
  const text =
    typeof value === "string"
      ? value.trim()
      : toEditableTextValue(value, { pretty: false, fallback: "" }).trim();
  if (!text) return fallbackEmpty;
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

export function safeParseJsonText(text) {
  if (text == null) return null;
  const raw = typeof text === "string" ? text.trim() : toEditableTextValue(text, { pretty: false });
  if (!raw) return null;
  return JSON.parse(raw);
}
