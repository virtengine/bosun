/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Command Palette
 *  Global fuzzy search palette (Cmd+K / Ctrl+K)
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "preact/hooks";
import htm from "htm";
import {
  Dialog,
  TextField,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Typography,
  Box,
  Chip,
} from "@mui/material";

const html = htm.bind(h);

import { ICONS } from "../modules/icons.js";
import { navigateTo, TAB_CONFIG, activeTab } from "../modules/router.js";
import { sendCommandToChat } from "../modules/api.js";
import { executorData, refreshTab } from "../modules/state.js";

/* ═══════════════════════════════════════════════
 *  Palette Items
 * ═══════════════════════════════════════════════ */

const TAB_DESCRIPTIONS = {
  dashboard: "Overview, status, and metrics",
  tasks: "View and manage tasks",
  agents: "Monitor running agents",
  logs: "Application and agent logs",
  control: "Executor and system controls",
  settings: "Preferences and configuration",
  infra: "Infrastructure and worktrees",
};

function buildNavigationItems() {
  return TAB_CONFIG.map((tab, i) => ({
    id: `nav-${tab.id}`,
    category: "Navigation",
    title: tab.label,
    description: TAB_DESCRIPTIONS[tab.id] || "",
    hint: String(i + 1),
    icon: tab.icon,
    action: () => navigateTo(tab.id),
  }));
}

const COMMAND_ITEMS = [
  {
    id: "cmd-status",
    category: "Commands",
    title: "/status",
    description: "Check orchestrator status",
    action: () => sendCommandToChat("/status"),
  },
  {
    id: "cmd-health",
    category: "Commands",
    title: "/health",
    description: "Health check",
    action: () => sendCommandToChat("/health"),
  },
  {
    id: "cmd-plan",
    category: "Commands",
    title: "/plan",
    description: "Generate plan",
    action: () => sendCommandToChat("/plan"),
  },
  {
    id: "cmd-logs",
    category: "Commands",
    title: "/logs 50",
    description: "View recent logs",
    action: () => sendCommandToChat("/logs 50"),
  },
  {
    id: "cmd-menu",
    category: "Commands",
    title: "/menu",
    description: "Show menu",
    action: () => sendCommandToChat("/menu"),
  },
  {
    id: "cmd-helpfull",
    category: "Commands",
    title: "/helpfull",
    description: "Full help",
    action: () => sendCommandToChat("/helpfull"),
  },
];

function buildQuickActions() {
  const paused = executorData.value?.paused;
  return [
    {
      id: "qa-new-task",
      category: "Quick Actions",
      title: "Create Task",
      description: "Open task creation",
      action: () => {
        navigateTo("tasks");
        // Dispatch event for task creation UI
        globalThis.dispatchEvent(new CustomEvent("ve:create-task"));
      },
    },
    {
      id: "qa-toggle-executor",
      category: "Quick Actions",
      title: paused ? "Resume Executor" : "Pause Executor",
      description: paused
        ? "Resume task processing"
        : "Stop processing new tasks",
      action: () => {
        const cmd = paused ? "/resume" : "/pause";
        sendCommandToChat(cmd);
      },
    },
    {
      id: "qa-refresh",
      category: "Quick Actions",
      title: "Refresh Data",
      description: "Force refresh current tab",
      action: () => refreshTab(activeTab.value),
    },
  ];
}

/* ═══════════════════════════════════════════════
 *  Fuzzy Matching
 * ═══════════════════════════════════════════════ */

/** Build an array [0, 1, …, n-1]. */
function rangeIndices(n) {
  return Array.from({ length: n }, (_, i) => i);
}

/** Try matching query chars against the start of each word in text. */
function wordStartMatch(q, t) {
  const words = t.split(/[\s/\-_]+/);
  const matched = [];
  let wordPos = 0;
  let qi = 0;
  for (const word of words) {
    const startIdx = t.indexOf(word, wordPos);
    if (qi < q.length && word.startsWith(q[qi])) {
      let wi = 0;
      while (qi < q.length && wi < word.length && word[wi] === q[qi]) {
        matched.push(startIdx + wi);
        qi++;
        wi++;
      }
    }
    wordPos = startIdx + word.length;
  }
  return qi === q.length ? matched : null;
}

/** Try fuzzy character-by-character match. */
function charByCharMatch(q, t) {
  const indices = [];
  let ti = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    indices.push(found);
    ti = found + 1;
  }
  return indices;
}

/**
 * Score a query against text. Higher = better match.
 * Returns { score, indices } or null if no match.
 */
function fuzzyMatch(query, text) {
  if (!query) return { score: 0, indices: [] };

  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact prefix match — highest score
  if (t.startsWith(q)) return { score: 100, indices: rangeIndices(q.length) };

  // Word-start match
  const wsIndices = wordStartMatch(q, t);
  if (wsIndices) return { score: 75, indices: wsIndices };

  // Substring match
  const subIdx = t.indexOf(q);
  if (subIdx !== -1) {
    return { score: 50, indices: rangeIndices(q.length).map((i) => subIdx + i) };
  }

  // Fuzzy character-by-character match
  const cbcIndices = charByCharMatch(q, t);
  return cbcIndices ? { score: 25, indices: cbcIndices } : null;
}

/**
 * Highlight matched characters in text by wrapping them in <mark>.
 */
function HighlightedText({ text, indices }) {
  if (!indices || indices.length === 0) return html`<span>${text}</span>`;

  const set = new Set(indices);
  const parts = [];
  let buf = "";
  let inMatch = false;

  for (let i = 0; i < text.length; i++) {
    const match = set.has(i);
    if (match !== inMatch) {
      if (buf) {
        parts.push(
          inMatch
            ? html`<mark class="cp-highlight">${buf}</mark>`
            : html`<span>${buf}</span>`,
        );
      }
      buf = "";
      inMatch = match;
    }
    buf += text[i];
  }
  if (buf) {
    parts.push(
      inMatch
        ? html`<mark class="cp-highlight">${buf}</mark>`
        : html`<span>${buf}</span>`,
    );
  }
  return html`<span>${parts}</span>`;
}

/* ═══════════════════════════════════════════════
 *  Minimal custom styles (highlight + keyboard nav)
 * ═══════════════════════════════════════════════ */

const CP_MINIMAL_STYLES = `
  .cp-highlight {
    background: rgba(99,102,241,0.35);
    color: inherit;
    border-radius: 2px;
  }
`;

/* ═══════════════════════════════════════════════
 *  Search icon SVG (inline for no-build env)
 * ═══════════════════════════════════════════════ */
const SearchIcon = () => html`
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round">
    <circle cx="11" cy="11" r="8"/>
    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
`;

/* ═══════════════════════════════════════════════
 *  CommandPalette Component
 * ═══════════════════════════════════════════════ */

export function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      // Auto-focus with a small delay for the render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Build all items (nav items are static, quick actions are dynamic)
  const allItems = useMemo(() => {
    return [
      ...buildNavigationItems(),
      ...COMMAND_ITEMS,
      ...buildQuickActions(),
    ];
  }, [open, executorData.value]);

  // Filter and score
  const filtered = useMemo(() => {
    if (!query.trim()) return allItems;

    const results = [];
    const q = query.trim();
    for (const item of allItems) {
      const titleMatch = fuzzyMatch(q, item.title);
      const descMatch = fuzzyMatch(q, item.description);
      const bestScore = Math.max(
        titleMatch?.score ?? 0,
        (descMatch?.score ?? 0) * 0.8,
      );
      if (titleMatch || descMatch) {
        results.push({
          ...item,
          _score: bestScore,
          _titleIndices: titleMatch?.indices || [],
          _descIndices: descMatch?.indices || [],
        });
      }
    }
    results.sort((a, b) => b._score - a._score);
    return results;
  }, [query, allItems]);

  // Group results by category
  const grouped = useMemo(() => {
    const groups = new Map();
    for (const item of filtered) {
      if (!groups.has(item.category)) groups.set(item.category, []);
      groups.get(item.category).push(item);
    }
    return groups;
  }, [filtered]);

  // Flat list for keyboard navigation
  const flatList = useMemo(() => {
    const flat = [];
    for (const items of grouped.values()) flat.push(...items);
    return flat;
  }, [grouped]);

  // Clamp selection
  useEffect(() => {
    if (selectedIdx >= flatList.length) {
      setSelectedIdx(Math.max(0, flatList.length - 1));
    }
  }, [flatList.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(".Mui-selected");
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const execute = useCallback(
    (item) => {
      if (!item) return;
      onClose();
      // Defer action slightly so the palette closes first
      requestAnimationFrame(() => item.action());
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, flatList.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        execute(flatList[selectedIdx]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [flatList, selectedIdx, execute, onClose],
  );

  if (!open) return null;

  let itemIndex = 0;

  return html`
    <style>${CP_MINIMAL_STYLES}</style>
    <${Dialog}
      open=${open}
      onClose=${onClose}
      fullWidth
      maxWidth="sm"
      sx=${{
        "& .MuiDialog-container": {
          alignItems: "flex-start",
          pt: "min(20vh, 120px)",
        },
        "& .MuiBackdrop-root": {
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          backgroundColor: "rgba(0,0,0,0.5)",
        },
        "& .MuiPaper-root": {
          background: "var(--card-bg, rgba(30,30,46,0.95))",
          border: "1px solid var(--border, rgba(255,255,255,0.1))",
          borderRadius: "16px",
          boxShadow: "0 24px 64px rgba(0,0,0,0.4)",
          maxHeight: "70vh",
          overflow: "hidden",
          backgroundImage: "none",
        },
      }}
    >
      <${Box}
        onKeyDown=${handleKeyDown}
        sx=${{ display: "flex", flexDirection: "column", height: "100%" }}
      >
        <${TextField}
          inputRef=${inputRef}
          fullWidth
          placeholder="Search commands, tabs, actions…"
          value=${query}
          onChange=${(e) => {
            setQuery(e.target.value);
            setSelectedIdx(0);
          }}
          variant="standard"
          autoComplete="off"
          sx=${{
            px: 2.5,
            py: 2,
            borderBottom: "1px solid var(--border, rgba(255,255,255,0.08))",
            "& .MuiInput-underline:before": { display: "none" },
            "& .MuiInput-underline:after": { display: "none" },
            "& .MuiInputBase-input": {
              fontSize: "17px",
              color: "var(--text, #e0e0e0)",
              fontFamily: "inherit",
              "&::placeholder": {
                color: "var(--text-secondary, #666)",
                opacity: 1,
              },
            },
          }}
          InputProps=${{
            startAdornment: html`
              <${InputAdornment} position="start">
                <${Box} sx=${{ opacity: 0.5, color: "var(--text-secondary, #999)", display: "flex" }}>
                  <${SearchIcon} />
                <//>
              <//>
            `,
            endAdornment: html`
              <${InputAdornment} position="end">
                <${Chip}
                  label="esc"
                  size="small"
                  sx=${{
                    fontSize: "11px",
                    fontFamily: "monospace",
                    height: "22px",
                    bgcolor: "var(--bg-secondary, rgba(255,255,255,0.06))",
                    color: "var(--text-secondary, #888)",
                    "& .MuiChip-label": { px: "6px" },
                  }}
                />
              <//>
            `,
          }}
        />

        <${List}
          ref=${listRef}
          dense
          sx=${{
            overflowY: "auto",
            flex: 1,
            py: 1,
          }}
        >
          ${flatList.length === 0
            ? html`
                <${Box} sx=${{ textAlign: "center", py: 4, px: 2 }}>
                  <${Typography}
                    variant="body2"
                    sx=${{ color: "var(--text-secondary, #888)", fontSize: "14px" }}
                  >
                    No results for "${query}"
                  <//>
                <//>
              `
            : Array.from(grouped.entries()).map(
                ([category, items]) => html`
                  <li key=${category}>
                    <ul style=${{ padding: 0 }}>
                      <${ListSubheader}
                        sx=${{
                          fontSize: "11px",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          color: "var(--text-secondary, #888)",
                          bgcolor: "transparent",
                          lineHeight: "28px",
                          px: 1.5,
                        }}
                      >
                        ${category}
                      <//>
                      ${items.map((item) => {
                        const idx = itemIndex++;
                        const isSelected = idx === selectedIdx;
                        return html`
                          <${ListItem} key=${item.id} disablePadding
                            secondaryAction=${
                              item.hint
                                ? html`<${Chip}
                                    label=${item.hint}
                                    size="small"
                                    sx=${{
                                      fontSize: "11px",
                                      fontFamily: "monospace",
                                      height: "22px",
                                      bgcolor: "var(--bg-secondary, rgba(255,255,255,0.06))",
                                      color: "var(--text-secondary, #888)",
                                      "& .MuiChip-label": { px: "6px" },
                                    }}
                                  />`
                                : null
                            }
                          >
                            <${ListItemButton}
                              selected=${isSelected}
                              onClick=${() => execute(item)}
                              onMouseEnter=${() => setSelectedIdx(idx)}
                              sx=${{
                                borderRadius: "10px",
                                mx: 1,
                                py: 1,
                                "&.Mui-selected": {
                                  bgcolor: "var(--bg-hover, rgba(255,255,255,0.08))",
                                },
                                "&:hover": {
                                  bgcolor: "var(--bg-hover, rgba(255,255,255,0.08))",
                                },
                                "&.Mui-selected:hover": {
                                  bgcolor: "var(--bg-hover, rgba(255,255,255,0.08))",
                                },
                              }}
                            >
                              ${item.icon
                                ? html`
                                    <${ListItemIcon}
                                      sx=${{
                                        minWidth: 36,
                                        color: "var(--text-secondary, #aaa)",
                                        opacity: 0.7,
                                        "& svg": { width: 18, height: 18 },
                                      }}
                                    >
                                      ${ICONS[item.icon]}
                                    <//>`
                                : null}
                              <${ListItemText}
                                primary=${html`<${HighlightedText}
                                  text=${item.title}
                                  indices=${item._titleIndices || []}
                                />`}
                                secondary=${
                                  item.description
                                    ? html`<${HighlightedText}
                                        text=${item.description}
                                        indices=${item._descIndices || []}
                                      />`
                                    : null
                                }
                                primaryTypographyProps=${{
                                  sx: {
                                    fontSize: "14px",
                                    fontWeight: 500,
                                    color: "var(--text, #e0e0e0)",
                                  },
                                }}
                                secondaryTypographyProps=${{
                                  component: "span",
                                  sx: {
                                    fontSize: "12px",
                                    color: "var(--text-secondary, #888)",
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    display: "block",
                                  },
                                }}
                              />
                            <//>
                          <//>
                        `;
                      })}
                    </ul>
                  </li>
                `,
              )}
        <//>
      <//>
    <//>
  `;
}

/* ═══════════════════════════════════════════════
 *  useCommandPalette hook
 *  Manages open state and global Cmd+K listener
 * ═══════════════════════════════════════════════ */

export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const onClose = useCallback(() => setOpen(false), []);

  return { open, onClose, setOpen };
}
