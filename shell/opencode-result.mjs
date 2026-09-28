/**
 * Turn an OpenCode `session.prompt()` result into the text the caller asked for.
 *
 * The ordering here is the whole point. An agent failure arrives as a NON-TEXT
 * part (a "patch", a "step-finish") plus `info.error` — never as text. The
 * previous inline extraction ignored `info.error` entirely, so every provider
 * rejection came back as "(Agent completed with no text output)", a string that
 * reads as success. A completely non-functional executor therefore looked like a
 * working one that happened to be quiet.
 *
 * Text still wins over an error field: a turn can carry both, and the text is
 * the answer that was actually produced.
 */

/**
 * @param {any} result Raw SDK response: { data: { info, parts } }
 * @returns {string}
 */
export function formatOpencodeResult(result) {
  const info = result?.data?.info || result?.info || {};
  const parts =
    result?.data?.parts ||
    result?.parts ||
    (Array.isArray(info.parts) ? info.parts : []);

  const text = (Array.isArray(parts) ? parts : [])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n");

  if (text) return text;
  if (typeof info.content === "string" && info.content.trim()) {
    return info.content.trim();
  }
  if (info.error) {
    const message =
      info.error.data?.message || info.error.message || JSON.stringify(info.error);
    return `:close: OpenCode agent error: ${info.error.name || "Error"}: ${message}`;
  }
  return "(Agent completed with no text output)";
}

export default formatOpencodeResult;
