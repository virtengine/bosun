import { h } from "preact";
import { useState, useEffect, useCallback, useMemo } from "preact/hooks";
import htm from "htm";
import { apiFetch } from "../modules/api.js";
import { resolveIcon } from "../modules/icon-utils.js";
import { buildSessionApiPath } from "../modules/session-api.js";
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Typography,
  Chip,
  Box,
  Stack,
  Button,
  Skeleton,
  Paper,
  IconButton,
  Tooltip,
} from "@mui/material";

const html = htm.bind(h);

function buildDiffApiPath({
  sessionId = "",
  taskId = "",
  workspace = "active",
  turnId = "",
  turnIndex = null,
} = {}) {
  if (taskId) {
    const params = new URLSearchParams({ taskId: String(taskId).trim() });
    const normalizedWorkspace = String(workspace || "").trim();
    if (normalizedWorkspace) params.set("workspace", normalizedWorkspace);
    return `/api/tasks/diff?${params.toString()}`;
  }
  const normalizedTurnId = String(turnId || "").trim();
  const normalizedTurnIndex = Number.isFinite(Number(turnIndex)) ? Number(turnIndex) : null;
  const params = { workspace };
  if (normalizedTurnId) params.turnId = normalizedTurnId;
  if (normalizedTurnIndex != null) params.turnIndex = normalizedTurnIndex;
  return buildSessionApiPath(sessionId, "diff", params) || "";
}

function buildDiffRequest({ diffPath = "", taskSnapshot = null, taskId = "" } = {}) {
  if (!diffPath) return null;
  if (taskId && taskSnapshot && typeof taskSnapshot === "object") {
    return {
      path: diffPath,
      options: {
        method: "POST",
        body: JSON.stringify({ task: taskSnapshot }),
        _silent: true,
      },
    };
  }
  return {
    path: diffPath,
    options: { _silent: true },
  };
}

const EXT_ICONS = {
  js: "terminal", mjs: "terminal", cjs: "terminal",
  ts: "terminal", tsx: "terminal",
  json: "file", yaml: "file", yml: "file", toml: "file",
  css: "palette", scss: "palette", less: "palette",
  html: "globe", htm: "globe",
  md: "edit", txt: "file",
  py: "terminal", rb: "terminal", go: "terminal", rs: "terminal",
  sh: "terminal", bash: "terminal", ps1: "terminal",
  sql: "archive", graphql: "archive",
};

function fileIcon(filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  return resolveIcon(EXT_ICONS[ext] || "file") || EXT_ICONS[ext] || "file";
}

function normalizeFile(file = {}) {
  const filename = file.filename || file.file || file.newFilename || file.oldFilename || "unknown";
  return {
    ...file,
    filename,
    file: file.file || filename,
    oldFilename: file.oldFilename || filename,
    newFilename: file.newFilename || filename,
    status: file.status || "modified",
    additions: Number(file.additions || 0),
    deletions: Number(file.deletions || 0),
    binary: Boolean(file.binary),
    patch: String(file.patch || file.diff || ""),
    hunks: Array.isArray(file.hunks) ? file.hunks : [],
  };
}

function normalizeFiles(diffData, activitySummary) {
  const files = Array.isArray(diffData?.files) ? diffData.files.map(normalizeFile) : [];
  if (files.length) return { files, usingActivityFallback: false };
  const fallbackFiles = Array.isArray(activitySummary?.files) ? activitySummary.files : [];
  return {
    files: fallbackFiles.map((entry) => normalizeFile({
      filename: entry.path,
      status: "modified",
      additions: Number(entry.edits || 0),
      deletions: 0,
      patch: "",
      hunks: [],
    })),
    usingActivityFallback: fallbackFiles.length > 0,
  };
}

function statusChipProps(status) {
  if (status === "added") return { label: "added", color: "success" };
  if (status === "removed" || status === "deleted") return { label: "deleted", color: "error" };
  if (status === "renamed") return { label: "renamed", color: "warning" };
  if (status === "copied") return { label: "copied", color: "secondary" };
  return { label: "modified", color: "info" };
}

function lineStyleForType(type) {
  if (type === "addition") {
    return {
      background: "rgba(34, 197, 94, 0.12)",
      borderColor: "rgba(34, 197, 94, 0.18)",
      gutter: "rgba(34, 197, 94, 0.18)",
      marker: "#4ade80",
    };
  }
  if (type === "deletion") {
    return {
      background: "rgba(239, 68, 68, 0.11)",
      borderColor: "rgba(239, 68, 68, 0.18)",
      gutter: "rgba(239, 68, 68, 0.16)",
      marker: "#f87171",
    };
  }
  if (type === "meta") {
    return {
      background: "rgba(59, 130, 246, 0.08)",
      borderColor: "rgba(59, 130, 246, 0.12)",
      gutter: "rgba(59, 130, 246, 0.12)",
      marker: "#93c5fd",
    };
  }
  return {
    background: "rgba(148, 163, 184, 0.05)",
    borderColor: "rgba(148, 163, 184, 0.08)",
    gutter: "rgba(148, 163, 184, 0.1)",
    marker: "rgba(148, 163, 184, 0.6)",
  };
}

function renderLineNumber(value) {
  return value == null ? "" : String(value);
}

function DiffLineRow({ line }) {
  const palette = lineStyleForType(line.type);
  return html`
    <tr>
      <td style=${{
        width: "56px",
        minWidth: "56px",
        padding: "0 10px",
        textAlign: "right",
        color: "var(--text-hint)",
        borderRight: `1px solid ${palette.gutter}`,
        background: palette.background,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "12px",
        userSelect: "none",
      }}>${renderLineNumber(line.oldNumber)}</td>
      <td style=${{
        width: "56px",
        minWidth: "56px",
        padding: "0 10px",
        textAlign: "right",
        color: "var(--text-hint)",
        borderRight: `1px solid ${palette.gutter}`,
        background: palette.background,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "12px",
        userSelect: "none",
      }}>${renderLineNumber(line.newNumber)}</td>
      <td style=${{ padding: 0, background: palette.background }}>
        <div style=${{
          display: "flex",
          alignItems: "stretch",
          borderLeft: `3px solid ${palette.borderColor}`,
        }}>
          <span style=${{
            width: "24px",
            minWidth: "24px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: palette.marker,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: "12px",
            userSelect: "none",
          }}>${line.marker || " "}</span>
          <pre style=${{
            margin: 0,
            padding: "0 12px 0 0",
            whiteSpace: "pre",
            overflowX: "auto",
            color: "var(--text-primary)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: "12px",
            lineHeight: "20px",
            flex: 1,
          }}>${line.content || " "}</pre>
        </div>
      </td>
    </tr>
  `;
}

function DiffHunk({ hunk }) {
  const lines = Array.isArray(hunk?.lines) ? hunk.lines : [];
  return html`
    <div style=${{
      border: "1px solid rgba(148, 163, 184, 0.14)",
      borderRadius: "12px",
      overflow: "hidden",
      marginBottom: "14px",
      background: "rgba(15, 23, 42, 0.38)",
    }}>
      <div style=${{
        padding: "8px 12px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "12px",
        color: "#93c5fd",
        background: "rgba(59, 130, 246, 0.08)",
        borderBottom: "1px solid rgba(59, 130, 246, 0.12)",
      }}>${hunk.header}</div>
      <div style=${{ overflowX: "auto" }}>
        <table style=${{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <tbody>
            ${lines.map((line, index) => html`<${DiffLineRow} key=${`${hunk.header}-${index}`} line=${line} />`)}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

const LARGE_HUNK_THRESHOLD = 200; // lines
const LARGE_FILE_THRESHOLD = 500; // total lines across hunks
const LARGE_PATCH_BYTES = 80_000; // ~80 KB patch text

function countHunkLines(hunks = []) {
  return hunks.reduce((sum, h) => sum + (Array.isArray(h?.lines) ? h.lines.length : 0), 0);
}

function DiffFile({ file, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [loaded, setLoaded] = useState(false);
  const chipProps = statusChipProps(file.status);
  const renameLabel = file.status === "renamed" && file.oldFilename && file.newFilename && file.oldFilename !== file.newFilename
    ? `${file.oldFilename} -> ${file.newFilename}`
    : null;
  const hasPatch = Array.isArray(file.hunks) && file.hunks.length > 0;
  const totalLines = countHunkLines(file.hunks);
  const patchBytes = (file.patch || "").length;
  const isLarge = totalLines > LARGE_FILE_THRESHOLD || patchBytes > LARGE_PATCH_BYTES;

  // Auto-load when not large or when user explicitly loads
  const shouldRenderHunks = hasPatch && (!isLarge || loaded);

  return html`
    <${Accordion}
      expanded=${expanded}
      onChange=${() => setExpanded(!expanded)}
      disableGutters
      sx=${{
        mb: 1.5,
        borderRadius: "14px",
        overflow: "hidden",
        border: "1px solid rgba(148, 163, 184, 0.14)",
        background: "rgba(15, 23, 42, 0.52)",
        "&:before": { display: "none" },
      }}
    >
      <${AccordionSummary}
        sx=${{
          px: 2,
          minHeight: "60px",
          "& .MuiAccordionSummary-content": { alignItems: "center", gap: 1.25 },
        }}
      >
        <span style=${{
          width: "28px",
          height: "28px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "8px",
          background: "rgba(59, 130, 246, 0.1)",
          color: "#93c5fd",
          flexShrink: 0,
        }}>${fileIcon(file.filename)}</span>
        <div style=${{ minWidth: 0, flex: 1 }}>
          <${Typography} variant="body2" sx=${{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontWeight: 600 }}>
            ${file.filename}
          <//>
          ${renameLabel && html`
            <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
              ${renameLabel}
            <//>
          `}
        </div>
        <${Chip} label=${chipProps.label} size="small" color=${chipProps.color} variant="outlined" sx=${{ mr: 0.5 }} />
        ${file.additions > 0 && html`<${Chip} label=${`+${file.additions}`} size="small" color="success" variant="outlined" />`}
        ${file.deletions > 0 && html`<${Chip} label=${`-${file.deletions}`} size="small" color="error" variant="outlined" />`}
        ${isLarge && html`<${Chip} label="large" size="small" variant="outlined" sx=${{ ml: 0.5, borderColor: "rgba(251,191,36,0.5)", color: "#fbbf24" }} />`}
      <//>
      <${AccordionDetails} sx=${{ p: 0, maxHeight: "none", overflow: "visible" }}>
        ${file.binary
          ? html`
              <div style=${{
                padding: "14px 16px",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: "12px",
                color: "var(--text-secondary)",
              }}>Binary file diff is not rendered inline.</div>
            `
          : shouldRenderHunks
            ? html`
                <div style=${{
                  padding: "14px",
                  maxHeight: "600px",
                  overflowY: "auto",
                  overflowX: "hidden",
                }}>
                  ${file.hunks.map((hunk, index) => html`<${DiffHunk} key=${`${file.filename}-${index}`} hunk=${hunk} />`)}
                </div>
              `
            : hasPatch && isLarge && !loaded
              ? html`
                  <div style=${{
                    padding: "24px 16px",
                    textAlign: "center",
                    background: "rgba(15, 23, 42, 0.38)",
                  }}>
                    <${Typography} variant="body2" color="text.secondary" sx=${{ mb: 1.5 }}>
                      Large diff — ${totalLines} lines across ${file.hunks.length} hunks
                    <//>
                    <${Button}
                      variant="outlined"
                      size="small"
                      onClick=${(e) => { e.stopPropagation(); setLoaded(true); }}
                    >Load diff<//>
                  </div>
                `
              : html`
                  <div style=${{
                    padding: "14px 16px",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    fontSize: "12px",
                    color: "var(--text-secondary)",
                  }}>
                    Patch body is not available for this file yet.
                  </div>
                `}
      <//>
    <//>
  `;
}

export function DiffViewer({
  sessionId = "",
  taskId = "",
  workspace = "active",
  activitySummary = null,
  title = "",
  taskSnapshot = null,
  turnId = "",
  turnIndex = null,
  embedded = false,
  hideSummary = false,
  defaultExpandedFiles = 2,
}) {
  const [diffData, setDiffData] = useState(null);
  const [sourceMeta, setSourceMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const diffPath = useMemo(
    () => buildDiffApiPath({ sessionId, taskId, workspace, turnId, turnIndex }),
    [sessionId, taskId, workspace, turnId, turnIndex],
  );
  const diffRequest = useMemo(
    () => buildDiffRequest({ diffPath, taskSnapshot, taskId }),
    [diffPath, taskSnapshot, taskId],
  );

  const loadDiff = useCallback(() => {
    if (!diffRequest?.path) {
      setDiffData(null);
      setSourceMeta(null);
      setLoading(false);
      setError("unavailable");
      return Promise.resolve();
    }
    setLoading(true);
    setError(null);
    return apiFetch(diffRequest.path, diffRequest.options)
      .then((res) => {
        setDiffData(res?.diff || null);
        setSourceMeta(res?.source || null);
      })
      .catch(() => {
        setError("unavailable");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [diffRequest]);

  useEffect(() => {
    let active = true;
    if (!diffRequest?.path) {
      setDiffData(null);
      setSourceMeta(null);
      setLoading(false);
      setError("unavailable");
      return () => {
        active = false;
      };
    }
    setLoading(true);
    setError(null);
    apiFetch(diffRequest.path, diffRequest.options)
      .then((res) => {
        if (!active) return;
        setDiffData(res?.diff || null);
        setSourceMeta(res?.source || null);
      })
      .catch(() => {
        if (active) setError("unavailable");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [diffRequest]);

  if (!sessionId && !taskId) {
    return html`
      <${Box} sx=${{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", py: 6, gap: 1 }}>
        <${Typography} variant="h6" color="text.secondary">${resolveIcon(":edit:")}<//>
        <${Typography} variant="body2" color="text.secondary">Select a task or session to review diffs<//>
      <//>
    `;
  }

  if (loading) {
    return html`
      <${Box} sx=${{ p: 2 }}>
        <${Skeleton} variant="rectangular" height=${220} sx=${{ borderRadius: 2 }} />
      <//>
    `;
  }

  if (error) {
    return html`
      <${Box} sx=${{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", py: 6, gap: 1 }}>
        <${Typography} variant="h6" color="text.secondary">${resolveIcon(":edit:")}<//>
        <${Typography} variant="body2" color="text.secondary">Diff not available<//>
        <${Button} variant="contained" size="small" onClick=${loadDiff}>Retry<//>
      <//>
    `;
  }

  const normalized = normalizeFiles(diffData, activitySummary);
  const renderedFiles = normalized.files;
  const usingActivityFallback = normalized.usingActivityFallback;
  const totalAdditions = renderedFiles.reduce((sum, file) => sum + Number(file.additions || 0), 0);
  const totalDeletions = renderedFiles.reduce((sum, file) => sum + Number(file.deletions || 0), 0);
  const summaryLabel = diffData?.sourceRange || sourceMeta?.label || title || "";

  return html`
    <div class=${embedded ? "diff-viewer diff-viewer-embedded" : "diff-viewer"}>
      ${!hideSummary && html`
        <${Paper} variant="outlined" sx=${{
          mb: 2,
          p: embedded ? 1.5 : 2,
          borderRadius: "16px",
          borderColor: "rgba(148, 163, 184, 0.14)",
          background: "rgba(15, 23, 42, 0.42)",
        }}>
          <${Stack} direction="row" spacing=${1} alignItems="center" useFlexGap flexWrap="wrap">
            <${Typography} variant="body2" sx=${{ fontWeight: 600 }}>
              ${renderedFiles.length
                ? `${renderedFiles.length} file${renderedFiles.length === 1 ? "" : "s"} ${usingActivityFallback ? "touched" : "changed"}`
                : "No changes yet"}
            <//>
            ${usingActivityFallback && html`<${Chip} label="activity fallback" size="small" color="warning" variant="outlined" />`}
            ${summaryLabel && html`<${Chip} label=${summaryLabel} size="small" variant="outlined" />`}
            ${sourceMeta?.kind && html`<${Chip} label=${sourceMeta.kind} size="small" color="info" variant="outlined" />`}
            ${totalAdditions > 0 && html`<${Chip} label=${`+${totalAdditions}`} size="small" color="success" variant="outlined" />`}
            ${totalDeletions > 0 && html`<${Chip} label=${`-${totalDeletions}`} size="small" color="error" variant="outlined" />`}
          <//>
          ${sourceMeta?.detail && html`
            <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block", mt: 1 }}>
              ${sourceMeta.detail}
            <//>
          `}
        <//>
      `}

      ${renderedFiles.length
        ? html`
            <div style=${{ display: "flex", flexDirection: "column", gap: "12px" }}>
              ${renderedFiles.map((file, index) => html`
                <${DiffFile}
                  key=${file.filename}
                  file=${file}
                  defaultExpanded=${index < defaultExpandedFiles}
                />
              `)}
            </div>
          `
        : html`
            <${Box} sx=${{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", py: 6, gap: 1 }}>
              <${Typography} variant="h6" color="text.secondary">${resolveIcon(":star:")}<//>
              <${Typography} variant="body2" color="text.secondary">No changes yet<//>
            <//>
          `}
    </div>
  `;
}
