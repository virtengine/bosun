import { h } from "preact";
import { useState, useEffect, useCallback, useMemo, useRef } from "preact/hooks";
import htm from "htm";
import { apiFetch } from "../modules/api.js";
import { resolveIcon } from "../modules/icon-utils.js";
import { DiffViewer } from "./diff-viewer.js";
import {
  Typography,
  Chip,
  Box,
  Stack,
  Button,
  Skeleton,
  Paper,
  IconButton,
  Tooltip,
  Collapse,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@mui/material";

const html = htm.bind(h);

/* ─── Constants ─── */
const LANE_WIDTH = 24;
const DOT_RADIUS = 5;
const ROW_HEIGHT = 36;
const LANE_COLORS = [
  "#60a5fa", // blue
  "#34d399", // green
  "#f472b6", // pink
  "#fbbf24", // amber
  "#a78bfa", // purple
  "#fb923c", // orange
  "#2dd4bf", // teal
  "#f87171", // red
  "#818cf8", // indigo
  "#4ade80", // lime
];

/* ─── Graph layout engine ─── */

function buildGraphLayout(commits) {
  const lanes = []; // array of lane occupants (commit hashes)
  const layout = []; // per-commit layout info
  const hashToRow = new Map();
  commits.forEach((c, i) => hashToRow.set(c.hash, i));

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    // Find which lane this commit is in (from a parent that reserved it)
    let lane = lanes.indexOf(commit.hash);
    if (lane === -1) {
      // New branch — find first free lane
      lane = lanes.indexOf(null);
      if (lane === -1) { lane = lanes.length; lanes.push(null); }
      lanes[lane] = commit.hash;
    }

    const color = LANE_COLORS[lane % LANE_COLORS.length];

    // Build connections to parents
    const connections = [];
    const parents = commit.parents || [];
    for (let p = 0; p < parents.length; p++) {
      const parentHash = parents[p];
      const parentRow = hashToRow.get(parentHash);
      if (parentRow === undefined) continue; // parent not in visible range

      if (p === 0) {
        // First parent — keep same lane
        const existingLane = lanes.indexOf(parentHash);
        if (existingLane === -1) {
          lanes[lane] = parentHash;
          connections.push({ fromLane: lane, toLane: lane, toRow: parentRow, color });
        } else {
          // Parent already has its lane (merge)
          lanes[lane] = null; // free current lane
          connections.push({ fromLane: lane, toLane: existingLane, toRow: parentRow, color });
        }
      } else {
        // Merge parent — find or create lane for it
        let parentLane = lanes.indexOf(parentHash);
        if (parentLane === -1) {
          parentLane = lanes.indexOf(null);
          if (parentLane === -1) { parentLane = lanes.length; lanes.push(null); }
          lanes[parentLane] = parentHash;
        }
        const mergeColor = LANE_COLORS[parentLane % LANE_COLORS.length];
        connections.push({ fromLane: lane, toLane: parentLane, toRow: parentRow, color: mergeColor });
      }
    }

    // If no parents claim this lane, free it
    if (parents.length === 0) {
      lanes[lane] = null;
    }

    layout.push({ lane, color, connections });
  }

  // Trim trailing null lanes
  const maxLane = layout.reduce((max, l) => Math.max(max, l.lane), 0);
  const totalLanes = Math.min(maxLane + 2, lanes.length);

  return { layout, totalLanes };
}

/* ─── SVG lane rendering ─── */

function GraphSvg({ layout, totalLanes, commits }) {
  const width = (totalLanes + 1) * LANE_WIDTH;
  const height = commits.length * ROW_HEIGHT;

  const elements = [];

  // Render connections (lines/curves)
  for (let i = 0; i < layout.length; i++) {
    const info = layout[i];
    for (const conn of info.connections) {
      const x1 = conn.fromLane * LANE_WIDTH + LANE_WIDTH / 2;
      const y1 = i * ROW_HEIGHT + ROW_HEIGHT / 2;
      const x2 = conn.toLane * LANE_WIDTH + LANE_WIDTH / 2;
      const y2 = conn.toRow * ROW_HEIGHT + ROW_HEIGHT / 2;

      if (x1 === x2) {
        // Straight vertical line
        elements.push(html`
          <line key=${`line-${i}-${conn.toLane}`}
            x1=${x1} y1=${y1} x2=${x2} y2=${y2}
            stroke=${conn.color} stroke-width="2" stroke-opacity="0.6" />
        `);
      } else {
        // Curved line for merge/branch
        const midY = y1 + (y2 - y1) * 0.4;
        elements.push(html`
          <path key=${`curve-${i}-${conn.toLane}`}
            d=${`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
            stroke=${conn.color} stroke-width="2" stroke-opacity="0.5"
            fill="none" />
        `);
      }
    }
  }

  // Render dots
  for (let i = 0; i < layout.length; i++) {
    const info = layout[i];
    const cx = info.lane * LANE_WIDTH + LANE_WIDTH / 2;
    const cy = i * ROW_HEIGHT + ROW_HEIGHT / 2;
    const isMerge = (commits[i].parents || []).length > 1;

    elements.push(html`
      <circle key=${`dot-${i}`}
        cx=${cx} cy=${cy} r=${isMerge ? DOT_RADIUS + 1 : DOT_RADIUS}
        fill=${info.color}
        stroke=${isMerge ? "#fff" : "rgba(15,23,42,0.8)"}
        stroke-width=${isMerge ? 2 : 1.5} />
    `);
  }

  return html`
    <svg width=${width} height=${height} style=${{ display: "block", flexShrink: 0 }}>
      ${elements}
    </svg>
  `;
}

/* ─── Time formatting ─── */

function formatRelativeTime(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/* ─── Ref badge ─── */

function RefBadge({ refName }) {
  const isHead = refName.includes("HEAD");
  const isBranch = refName.includes("origin/") || !refName.includes("/");
  const isTag = refName.startsWith("tag:");
  const color = isHead ? "#60a5fa" : isTag ? "#fbbf24" : isBranch ? "#34d399" : "#94a3b8";
  const bg = isHead ? "rgba(96,165,250,0.15)" : isTag ? "rgba(251,191,36,0.15)" : isBranch ? "rgba(52,211,153,0.15)" : "rgba(148,163,184,0.1)";

  return html`
    <span style=${{
      display: "inline-block",
      padding: "1px 6px",
      borderRadius: "4px",
      border: `1px solid ${color}40`,
      background: bg,
      color,
      fontSize: "10px",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontWeight: 600,
      lineHeight: "16px",
      whiteSpace: "nowrap",
      marginRight: "4px",
    }}>${refName.replace("HEAD -> ", "").trim()}</span>
  `;
}

/* ─── Commit Detail Panel ─── */

function CommitDetail({ commit, onClose, repoName }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const FILE_DISPLAY_LIMIT = 30;

  useEffect(() => {
    if (!commit?.hash) return;
    setLoading(true);
    setError(null);
    setShowAllFiles(false);
    const repoQ = repoName ? `?repo=${encodeURIComponent(repoName)}` : "";
    apiFetch(`/api/commit-detail/${commit.hash}${repoQ}`, { _silent: true })
      .then((res) => {
        setDetail(res?.data || null);
      })
      .catch((err) => setError(err?.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [commit?.hash, repoName]);

  if (!commit) return null;

  return html`
    <${Paper} variant="outlined" sx=${{
      mt: 1,
      borderRadius: "14px",
      borderColor: "rgba(148, 163, 184, 0.2)",
      background: "rgba(15, 23, 42, 0.65)",
      overflow: "hidden",
    }}>
      <!-- Header with commit metadata -->
      <div style=${{
        padding: "16px 20px",
        borderBottom: "1px solid rgba(148,163,184,0.12)",
        display: "flex",
        alignItems: "flex-start",
        gap: "12px",
      }}>
        <div style=${{ flex: 1 }}>
          <${Typography} variant="subtitle1" sx=${{ fontWeight: 700, lineHeight: 1.3 }}>
            ${commit.message || commit.subject || ""}
          <//>
          ${detail?.body && html`
            <${Typography} variant="body2" color="text.secondary" sx=${{ mt: 0.5, whiteSpace: "pre-wrap" }}>
              ${detail.body}
            <//>
          `}
          <${Stack} direction="row" spacing=${1} sx=${{ mt: 1 }} alignItems="center" flexWrap="wrap" useFlexGap>
            <${Chip} label=${commit.shortHash || commit.hash?.slice(0, 7)} size="small" variant="outlined"
              sx=${{ fontFamily: "monospace", fontWeight: 600 }} />
            <${Typography} variant="caption" color="text.secondary">
              ${commit.author || ""}${commit.author && commit.date ? " · " : ""}${formatRelativeTime(commit.date)}
            <//>
            ${(commit.refs || []).map((r) => html`<${RefBadge} key=${r} refName=${r} />`)}
          <//>
        </div>
        <${IconButton} size="small" onClick=${onClose} sx=${{ color: "text.secondary" }}>✕<//>
      </div>

      <!-- Files changed -->
      ${loading && html`
        <${Box} sx=${{ p: 2 }}>
          <${Skeleton} variant="rectangular" height=${120} sx=${{ borderRadius: 2 }} />
        <//>
      `}
      ${error && html`
        <${Box} sx=${{ p: 2, textAlign: "center" }}>
          <${Typography} variant="body2" color="error">${error}<//>
        <//>
      `}
      ${detail && !loading && html`
        <div style=${{ padding: "12px 16px" }}>
          <${Stack} direction="row" spacing=${1} alignItems="center" sx=${{ mb: 1.5 }}>
            <${Typography} variant="body2" sx=${{ fontWeight: 600 }}>
              ${detail.files?.length || 0} file${(detail.files?.length || 0) === 1 ? "" : "s"} changed
            <//>
            ${detail.totalAdditions > 0 && html`<${Chip} label=${`+${detail.totalAdditions}`} size="small" color="success" variant="outlined" />`}
            ${detail.totalDeletions > 0 && html`<${Chip} label=${`-${detail.totalDeletions}`} size="small" color="error" variant="outlined" />`}
          <//>
          <!-- File list with inline diffs -->
          <div style=${{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "500px", overflowY: "auto", overflowX: "hidden" }}>
            ${(() => {
              const allFiles = detail.files || [];
              const visibleFiles = showAllFiles || allFiles.length <= FILE_DISPLAY_LIMIT
                ? allFiles
                : allFiles.slice(0, FILE_DISPLAY_LIMIT);
              return html`
                ${visibleFiles.map((file, index) => html`
                  <${CommitFileEntry} key=${file.filename} file=${file} defaultExpanded=${index < 3 && allFiles.length < 15} />
                `)}
                ${!showAllFiles && allFiles.length > FILE_DISPLAY_LIMIT && html`
                  <${Button} size="small" variant="outlined" sx=${{ alignSelf: "center", mt: 1 }}
                    onClick=${() => setShowAllFiles(true)}>
                    Show remaining ${allFiles.length - FILE_DISPLAY_LIMIT} files
                  <//>
                `}
              `;
            })()}
          </div>
        </div>
      `}
    <//>
  `;
}

/* ─── Individual file entry in commit detail ─── */

function CommitFileEntry({ file, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasPatch = Array.isArray(file.hunks) && file.hunks.length > 0;
  const totalLines = (file.hunks || []).reduce((s, h) => s + (h.lines?.length || 0), 0);
  const isLarge = totalLines > 500;
  const [loaded, setLoaded] = useState(!isLarge);

  const statusColor = file.status === "added" ? "#4ade80" : file.status === "deleted" ? "#f87171" : file.status === "renamed" ? "#fbbf24" : "#60a5fa";

  return html`
    <div style=${{
      border: "1px solid rgba(148,163,184,0.12)",
      borderRadius: "10px",
      overflow: "hidden",
      background: "rgba(15,23,42,0.4)",
    }}>
      <div
        style=${{
          padding: "8px 12px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          cursor: hasPatch ? "pointer" : "default",
          userSelect: "none",
          ":hover": { background: "rgba(148,163,184,0.06)" },
        }}
        onClick=${() => hasPatch && setExpanded(!expanded)}
      >
        ${hasPatch && html`
          <span style=${{ color: "var(--text-hint)", fontSize: "12px", width: "16px", textAlign: "center", transition: "transform 0.15s", transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>▸</span>
        `}
        <span style=${{ width: "6px", height: "6px", borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
        <${Typography} variant="body2" sx=${{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: "12px",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>${file.filename}<//>
        ${file.additions > 0 && html`<span style=${{ color: "#4ade80", fontSize: "11px", fontFamily: "monospace" }}>+${file.additions}</span>`}
        ${file.deletions > 0 && html`<span style=${{ color: "#f87171", fontSize: "11px", fontFamily: "monospace" }}>-${file.deletions}</span>`}
      </div>
      ${expanded && hasPatch && html`
        <div style=${{ borderTop: "1px solid rgba(148,163,184,0.1)", maxHeight: "400px", overflowY: "auto", overflowX: "hidden" }}>
          ${isLarge && !loaded
            ? html`
                <div style=${{ padding: "16px", textAlign: "center" }}>
                  <${Typography} variant="body2" color="text.secondary">${totalLines} lines — <//>
                  <${Button} size="small" variant="outlined" onClick=${(e) => { e.stopPropagation(); setLoaded(true); }}>Load diff<//>
                </div>
              `
            : html`
                <div style=${{ padding: "8px" }}>
                  ${(file.hunks || []).map((hunk, i) => html`<${InlineHunk} key=${i} hunk=${hunk} />`)}
                </div>
              `}
        </div>
      `}
    </div>
  `;
}

/* ─── Inline hunk renderer (lightweight for commit detail) ─── */

function InlineHunk({ hunk }) {
  const lines = Array.isArray(hunk?.lines) ? hunk.lines : [];
  return html`
    <div style=${{
      border: "1px solid rgba(148,163,184,0.1)",
      borderRadius: "8px",
      overflow: "hidden",
      marginBottom: "8px",
      background: "rgba(15,23,42,0.3)",
    }}>
      ${hunk.header && html`
        <div style=${{
          padding: "4px 10px",
          fontSize: "11px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          color: "#93c5fd",
          background: "rgba(59,130,246,0.06)",
          borderBottom: "1px solid rgba(59,130,246,0.1)",
        }}>${hunk.header}</div>
      `}
      <table style=${{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          ${lines.map((line, i) => {
            const bg = line.type === "addition" ? "rgba(34,197,94,0.1)"
              : line.type === "deletion" ? "rgba(239,68,68,0.09)"
              : "transparent";
            const markerColor = line.type === "addition" ? "#4ade80"
              : line.type === "deletion" ? "#f87171"
              : "rgba(148,163,184,0.4)";
            return html`
              <tr key=${i}>
                <td style=${{ width: "44px", padding: "0 6px", textAlign: "right", color: "var(--text-hint)", fontSize: "11px", fontFamily: "monospace", userSelect: "none", background: bg, borderRight: "1px solid rgba(148,163,184,0.08)" }}>${line.oldNumber != null ? line.oldNumber : ""}</td>
                <td style=${{ width: "44px", padding: "0 6px", textAlign: "right", color: "var(--text-hint)", fontSize: "11px", fontFamily: "monospace", userSelect: "none", background: bg, borderRight: "1px solid rgba(148,163,184,0.08)" }}>${line.newNumber != null ? line.newNumber : ""}</td>
                <td style=${{ padding: 0, background: bg }}>
                  <pre style=${{ margin: 0, padding: "0 8px", whiteSpace: "pre", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "11px", lineHeight: "18px", color: "var(--text-primary)", display: "flex", alignItems: "center" }}>
                    <span style=${{ width: "16px", color: markerColor, flexShrink: 0, textAlign: "center" }}>${line.marker || " "}</span>${line.content || " "}
                  </pre>
                </td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    </div>
  `;
}

/* ─── Commit Row ─── */

function CommitRow({ commit, graphInfo, selected, onClick }) {
  const { color } = graphInfo;

  return html`
    <div
      style=${{
        display: "flex",
        alignItems: "center",
        height: `${ROW_HEIGHT}px`,
        cursor: "pointer",
        padding: "0 12px 0 0",
        background: selected ? "rgba(96,165,250,0.08)" : "transparent",
        borderLeft: selected ? `3px solid ${color}` : "3px solid transparent",
        transition: "background 0.12s",
      }}
      onClick=${onClick}
      onMouseEnter=${(e) => { if (!selected) e.currentTarget.style.background = "rgba(148,163,184,0.04)"; }}
      onMouseLeave=${(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      <!-- Message + refs -->
      <div style=${{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: "6px", overflow: "hidden" }}>
        ${(commit.refs || []).length > 0 && html`
          <span style=${{ display: "inline-flex", gap: "3px", flexShrink: 0 }}>
            ${commit.refs.map((r) => html`<${RefBadge} key=${r} refName=${r} />`)}
          </span>
        `}
        <span style=${{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: "12px",
          color: "var(--text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          ${commit.message || ""}
        </span>
      </div>
      <!-- Hash -->
      <span style=${{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "11px",
        color: color,
        width: "60px",
        textAlign: "right",
        flexShrink: 0,
      }}>${commit.shortHash || commit.hash?.slice(0, 7)}</span>
      <!-- Author -->
      <span style=${{
        fontSize: "11px",
        color: "var(--text-secondary)",
        width: "100px",
        textAlign: "right",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        flexShrink: 0,
        marginLeft: "8px",
      }}>${commit.author || ""}</span>
      <!-- Time -->
      <span style=${{
        fontSize: "11px",
        color: "var(--text-hint)",
        width: "64px",
        textAlign: "right",
        flexShrink: 0,
        marginLeft: "8px",
      }}>${formatRelativeTime(commit.date)}</span>
    </div>
  `;
}

/* ─── Main CommitGraph component ─── */

export function CommitGraph({ maxCommits = 40, compact = false }) {
  const [repos, setRepos] = useState([]);
  const [activeRepo, setActiveRepo] = useState("");
  const [commits, setCommits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedHash, setSelectedHash] = useState(null);
  const containerRef = useRef(null);

  // Load available repos on mount
  useEffect(() => {
    apiFetch("/api/git/repos", { _silent: true })
      .then((res) => {
        const list = res?.data || [];
        setRepos(list);
        if (list.length > 0 && !activeRepo) setActiveRepo(list[0].name);
      })
      .catch(() => {
        // Fallback: just use current repo
        setRepos([{ name: "bosun", path: "" }]);
        if (!activeRepo) setActiveRepo("bosun");
      });
  }, []);

  const loadCommits = useCallback(() => {
    setLoading(true);
    setError(null);
    setSelectedHash(null);
    const repoQ = activeRepo ? `&repo=${encodeURIComponent(activeRepo)}` : "";
    apiFetch(`/api/recent-commits?count=${maxCommits}${repoQ}`, { _silent: true })
      .then((res) => {
        setCommits(res?.data || []);
      })
      .catch(() => setError("Failed to load commits"))
      .finally(() => setLoading(false));
  }, [maxCommits, activeRepo]);

  useEffect(() => { if (activeRepo) loadCommits(); }, [loadCommits, activeRepo]);

  const { layout, totalLanes } = useMemo(() => {
    if (!commits.length) return { layout: [], totalLanes: 0 };
    return buildGraphLayout(commits);
  }, [commits]);

  const selectedCommit = useMemo(
    () => selectedHash ? commits.find((c) => c.hash === selectedHash) : null,
    [selectedHash, commits],
  );

  const graphWidth = (totalLanes + 1) * LANE_WIDTH;

  return html`
    <div ref=${containerRef} style=${{ display: "flex", flexDirection: "column" }}>
      <!-- Header with repo tabs -->
      <div style=${{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px 0 12px", borderBottom: "1px solid rgba(148,163,184,0.1)" }}>
        ${repos.length > 1 ? html`
          <div style=${{ display: "flex", gap: 0, overflow: "hidden", flex: 1, minWidth: 0 }}>
            ${repos.map((repo) => html`
              <button key=${repo.name}
                onClick=${() => setActiveRepo(repo.name)}
                style=${{
                  padding: "6px 14px",
                  fontSize: "12px",
                  fontWeight: activeRepo === repo.name ? 700 : 400,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  background: activeRepo === repo.name ? "rgba(96,165,250,0.12)" : "transparent",
                  color: activeRepo === repo.name ? "#60a5fa" : "var(--text-secondary)",
                  border: "none",
                  borderBottom: activeRepo === repo.name ? "2px solid #60a5fa" : "2px solid transparent",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  transition: "all 0.15s",
                }} >
                ${repo.name}
              </button>
            `)}
          </div>
        ` : html`
          <${Typography} variant="body2" sx=${{ fontWeight: 600, flex: 1 }}>
            ${activeRepo || "Git Graph"}
          <//>
        `}
        <${Chip} label=${`${commits.length} commits`} size="small" sx=${{ height: 20, fontSize: 11, flexShrink: 0 }} />
        <${Tooltip} title="Refresh">
          <${IconButton} size="small" onClick=${loadCommits} sx=${{ color: "text.secondary", flexShrink: 0 }}>↻<//>
        <//>
      </div>

      ${loading ? html`
        <div style=${{ padding: "16px" }}>
          ${[...Array(6)].map((_, i) => html`
            <${Skeleton} key=${i} variant="rectangular" height=${28} sx=${{ borderRadius: 1, mb: 1 }} />
          `)}
        </div>
      ` : error || !commits.length ? html`
        <${Box} sx=${{ display: "flex", flexDirection: "column", alignItems: "center", py: 4, gap: 1 }}>
          <${Typography} variant="body2" color="text.secondary">${error || "No commits found"}<//>
          <${Button} variant="outlined" size="small" onClick=${loadCommits}>Retry<//>
        <//>
      ` : html`
        <!-- Graph + commit list -->
        <div style=${{
          display: "flex",
          maxHeight: compact ? "360px" : "520px",
          overflowY: "auto",
          overflowX: "hidden",
        }}>
          <!-- SVG branch graph -->
          <div style=${{ flexShrink: 0, width: `${graphWidth}px` }}>
            <${GraphSvg} layout=${layout} totalLanes=${totalLanes} commits=${commits} />
          </div>
          <!-- Commit rows -->
          <div style=${{ flex: 1, minWidth: 0 }}>
            ${commits.map((commit, i) => html`
              <${CommitRow}
                key=${commit.hash}
                commit=${commit}
                graphInfo=${layout[i]}
                selected=${selectedHash === commit.hash}
                onClick=${() => setSelectedHash(selectedHash === commit.hash ? null : commit.hash)}
              />
            `)}
          </div>
        </div>

        <!-- Selected commit detail -->
        ${selectedCommit && html`
          <${CommitDetail}
            commit=${selectedCommit}
            onClose=${() => setSelectedHash(null)}
            repoName=${activeRepo}
          />
        `}
      `}
    </div>
  `;
}
