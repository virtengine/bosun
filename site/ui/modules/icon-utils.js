/* ─────────────────────────────────────────────────────────────
 *  Icon utilities
 *  - Maps emoji to line-style SVG icons
 *  - Helpers for rendering icon text consistently
 * ───────────────────────────────────────────────────────────── */

import { h as _h } from "preact";
import htm from "htm";
import { ICONS } from "./icons.js";

/* Guard: recover forwardRef objects that leak as element type */
function h(type, ...args) {
  if (type != null && typeof type === "object" && typeof type !== "function" && typeof type.render === "function") {
    return _h(type.render, ...args);
  }
  return _h(type, ...args);
}

const html = htm.bind(h);
const TOKEN_ICON_REGEX = /^:([a-zA-Z][a-zA-Z0-9_-]*):$/;
const INLINE_TOKEN_REGEX = /^:([a-zA-Z][a-zA-Z0-9_-]*):/;

export const EMOJI_ICON_MAP = {
  "\u{2705}": "check",
  "✓": "check",
  "✕": "close",
  "\u{2716}": "close",
  "✗": "close",
  "✘": "close",
  "\u{274c}": "close",
  "\u{2753}": "help",
  "\u{2795}": "plus",
  "➤": "arrowRight",
  "\u{1f30d}": "globe",
  "\u{1f310}": "globe",
  "\u{1f333}": "git",
  "\u{1f33f}": "git",
  "\u{1f389}": "star",
  "\u{1f39b}": "sliders",
  "\u{1f3a4}": "mic",
  "\u{1f3a8}": "palette",
  "\u{1f3af}": "target",
  "\u{1f3c1}": "flag",
  "\u{1f3e0}": "home",
  "\u{1f3e5}": "heart",
  "\u{1f3f7}": "tag",
  "\u{1f40d}": "file",
  "\u{1f419}": "git",
  "\u{1f41a}": "terminal",
  "\u{1f41b}": "bug",
  "\u{1f440}": "eye",
  "\u{1f441}": "eye",
  "\u{1f464}": "user",
  "\u{1f465}": "users",
  "\u{1f48e}": "diamond",
  "\u{1f493}": "heart",
  "\u{1f49a}": "heart",
  "\u{1f4a1}": "lightbulb",
  "\u{1f4a5}": "zap",
  "\u{1f4ac}": "chat",
  "\u{1f4bb}": "monitor",
  "\u{1f4be}": "save",
  "\u{1f4c1}": "folder",
  "\u{1f4c2}": "folder",
  "\u{1f4c4}": "file",
  "\u{1f4c8}": "chart",
  "\u{1f4ca}": "chart",
  "\u{1f4cb}": "clipboard",
  "\u{1f4cc}": "pin",
  "\u{1f4cf}": "ruler",
  "\u{1f4d0}": "ruler",
  "\u{1f4d6}": "file",
  "\u{1f4dc}": "file",
  "\u{1f4dd}": "edit",
  "\u{1f4e1}": "server",
  "\u{1f4e4}": "upload",
  "\u{1f4e5}": "download",
  "\u{1f4e6}": "box",
  "\u{1f4e8}": "mail",
  "\u{1f4ec}": "mail",
  "\u{1f4f1}": "phone",
  "\u{1f4f8}": "camera",
  "\u{1f500}": "git",
  "\u{1f501}": "repeat",
  "\u{1f504}": "refresh",
  "\u{1f50c}": "plug",
  "\u{1f50d}": "search",
  "\u{1f50e}": "search",
  "\u{1f510}": "lock",
  "\u{1f512}": "lock",
  "\u{1f513}": "unlock",
  "\u{1f514}": "bell",
  "\u{1f517}": "link",
  "\u{1f522}": "hash",
  "\u{1f523}": "terminal",
  "\u{1f525}": "zap",
  "\u{1f527}": "settings",
  "\u{1f528}": "hammer",
  "\u{1f534}": "dot",
  "\u{1f535}": "dot",
  "\u{26aa}": "dot",
  "\u{1f537}": "diamond",
  "\u{1f5a5}": "monitor",
  "\u{1f5c2}": "folder",
  "\u{1f5c3}": "archive",
  "\u{1f5d1}": "trash",
  "\u{1f5dc}": "filter",
  "\u{1f5fa}": "grid",
  "\u{1f648}": "eyeOff",
  "\u{1f680}": "rocket",
  "\u{1f6a6}": "alert",
  "\u{1f6a7}": "alert",
  "\u{1f6a8}": "alert",
  "\u{1f6ab}": "ban",
  "\u{1f6d1}": "close",
  "\u{1f6e1}": "shield",
  "\u{1f6f0}": "server",
  "\u{1f7e1}": "dot",
  "\u{1f7e2}": "dot",
  "\u{1f916}": "bot",
  "\u{1f980}": "file",
  "\u{1f9e0}": "cpu",
  "\u{1f9ea}": "beaker",
  "\u{1f9ed}": "compass",
  "\u{1f9f0}": "settings",
  "\u{1f9f5}": "link",
  "\u{1f9f9}": "trash",
  "\u{1fa9d}": "link",
  "\u{267b}": "repeat",
  "\u{267b}️": "repeat",
  "\u{2b07}": "download",
  "\u{2b07}️": "download",
  "\u{2b06}": "upload",
  "\u{2b06}️": "upload",
  "\u{2728}": "star",
  "\u{2b50}": "star",
  "\u{2699}": "settings",
  "\u{2699}️": "settings",
  "\u{26a0}": "alert",
  "\u{26a0}️": "alert",
  "\u{26a1}": "zap",
  "\u{23f1}": "clock",
  "\u{23f1}️": "clock",
  "\u{23f8}": "pause",
  "\u{23f8}️": "pause",
  "\u{23f9}": "stop",
  "\u{23f9}️": "stop",
  "\u{25b6}": "play",
  "\u{25b6}️": "play",
  "\u{23f3}": "clock",
  "\u{26d4}": "ban",
  "\u{2630}": "menu",
  "#️⃣": "hash",
  "\u{1f39b}️": "sliders",
  "\u{1f5fa}️": "grid",
  "\u{1f5a5}️": "monitor",
  "\u{1f3f7}️": "tag",
  "\u{1f6f0}️": "server",
  "\u{1f6e1}️": "shield",
  "\u{1f441}️": "eye",
};

const ICON_ALIAS_MAP = Object.freeze({
  ok: "check",
  success: "check",
  fail: "close",
  error: "close",
  warning: "alert",
  warn: "alert",
  info: "help",
  question: "help",
  sparkles: "star",
  brain: "cpu",
  tasks: "clipboard",
  log: "file",
  logs: "file",
  stopSign: "stop",
  playCircle: "play",
  pauseCircle: "pause",
});

const TOKEN_KEYWORD_ICON_RULES = Object.freeze([
  { icon: "alert", regex: /(alert|warn|warning|danger|error|fail|panic|critical|unsafe|incident|fatal|ban|blocked)/i },
  { icon: "check", regex: /(check|ok|good|pass|success|done|complete|approved|confirm)/i },
  { icon: "close", regex: /(close|cancel|deny|reject|stop|abort|remove|delete|x)/i },
  { icon: "refresh", regex: /(refresh|retry|reload|sync|repeat|again|loop)/i },
  { icon: "play", regex: /(play|start|run|launch|resume|go)/i },
  { icon: "pause", regex: /(pause|wait|hold|pending)/i },
  { icon: "clock", regex: /(clock|time|timer|schedule|later|soon|deadline)/i },
  { icon: "workflow", regex: /(workflow|flow|pipeline|process|orchestrate|route)/i },
  { icon: "clipboard", regex: /(task|todo|backlog|ticket|issue|plan|board|job)/i },
  { icon: "git", regex: /(git|repo|branch|commit|pr|pull|merge)/i },
  { icon: "settings", regex: /(setting|config|option|tune|gear)/i },
  { icon: "search", regex: /(search|find|lookup|scan|detect)/i },
  { icon: "file", regex: /(file|doc|note|readme|log|text|report)/i },
  { icon: "folder", regex: /(folder|dir|directory|path|workspace)/i },
  { icon: "user", regex: /(user|person|human|people|baby|child|kid|owner|assignee)/i },
  { icon: "users", regex: /(team|group|crew|everyone|all)/i },
  { icon: "bot", regex: /(bot|agent|assistant|ai)/i },
  { icon: "shield", regex: /(security|secure|shield|guard|protect|policy|mfa)/i },
  { icon: "lock", regex: /(lock|private|secret|key|auth)/i },
  { icon: "unlock", regex: /(unlock|public|open|access)/i },
  { icon: "server", regex: /(server|infra|cloud|host|runtime|deploy|k8s|cluster)/i },
  { icon: "globe", regex: /(globe|world|internet|network|web|lan|wan)/i },
  { icon: "link", regex: /(link|url|uri|connect|chain|bridge)/i },
  { icon: "mail", regex: /(mail|email|message|inbox)/i },
  { icon: "phone", regex: /(phone|call|telegram|mobile|sms|whatsapp)/i },
  { icon: "camera", regex: /(camera|photo|image|vision|video)/i },
  { icon: "chart", regex: /(chart|graph|metric|stats|usage|cost|telemetry|monitor)/i },
  { icon: "rocket", regex: /(rocket|ship|release|prod|production)/i },
  { icon: "star", regex: /(star|favorite|fav|priority|important|highlight)/i },
  { icon: "heart", regex: /(heart|love|health|healthy|wellness)/i },
  { icon: "hash", regex: /(hash|number|num|id)/i },
  { icon: "tag", regex: /(tag|label|category|type)/i },
  { icon: "menu", regex: /(menu|list|nav|navigation)/i },
  { icon: "dot", regex: /(dot|status|state|live|active|idle)/i },
]);

function resolveTokenFallbackIcon(token) {
  const normalized = String(token || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return ICONS.help ? "help" : null;
  if (ICONS[normalized]) return normalized;
  for (const rule of TOKEN_KEYWORD_ICON_RULES) {
    if (rule.regex.test(normalized) && ICONS[rule.icon]) {
      return rule.icon;
    }
  }
  if (ICONS.help) return "help";
  if (ICONS.tag) return "tag";
  return null;
}

function normalizeIconInput(icon) {
  return String(icon || "").replace(/[\uFE0E\uFE0F]/g, "");
}

function resolveIconName(icon) {
  if (!icon) return null;
  const normalizedRaw = normalizeIconInput(icon);
  if (!normalizedRaw) return null;

  const tokenMatch = normalizedRaw.match(TOKEN_ICON_REGEX);
  const isToken = Boolean(tokenMatch);
  const tokenName = tokenMatch ? tokenMatch[1] : normalizedRaw;
  const normalized = normalizeIconInput(tokenName).trim();
  if (!normalized) return null;

  if (ICONS[normalized]) return normalized;
  const lowered = normalized.toLowerCase();
  if (ICONS[lowered]) return lowered;
  const aliased = ICON_ALIAS_MAP[lowered];
  if (aliased && ICONS[aliased]) return aliased;
  const mapped = EMOJI_ICON_MAP[icon] || EMOJI_ICON_MAP[normalizedRaw] || EMOJI_ICON_MAP[normalized];
  if (mapped && ICONS[mapped]) return mapped;
  if (isToken) return resolveTokenFallbackIcon(lowered);
  return null;
}

function appendIconPart(parts, iconName) {
  parts.push(html`<span class="icon-inline" aria-hidden="true">${ICONS[iconName]}</span>`);
}

export function resolveIcon(icon) {
  const iconName = resolveIconName(icon);
  return iconName ? ICONS[iconName] : null;
}

export function iconText(text, { className = "" } = {}) {
  if (text == null) return text;
  const str = String(text);
  let hasIcon = false;
  const parts = [];
  let buffer = "";

  for (let i = 0; i < str.length; ) {
    const tokenMatch = str.slice(i).match(INLINE_TOKEN_REGEX);
    if (tokenMatch) {
      const fullMatch = tokenMatch[0];
      const iconName = resolveIconName(tokenMatch[1]);
      if (iconName) {
        if (buffer) {
          parts.push(buffer);
          buffer = "";
        }
        appendIconPart(parts, iconName);
        hasIcon = true;
        i += fullMatch.length;
        continue;
      }
    }

    const codePoint = str.codePointAt(i);
    if (typeof codePoint !== "number") break;
    const ch = String.fromCodePoint(codePoint);
    i += ch.length;

    if (ch === "\uFE0E" || ch === "\uFE0F") continue;
    const iconName = resolveIconName(ch);
    if (iconName) {
      if (buffer) {
        parts.push(buffer);
        buffer = "";
      }
      appendIconPart(parts, iconName);
      hasIcon = true;
    } else {
      buffer += ch;
    }
  }

  if (buffer) parts.push(buffer);
  if (!hasIcon) return str;

  return html`<span class="icon-text ${className}">${parts}</span>`;
}
