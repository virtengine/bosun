import React, { useEffect, useMemo, useState } from "react";
import htm from "htm";
import * as ink from "ink";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useInput = ink.useInput ?? ink.default?.useInput;
const useStdout = ink.useStdout ?? ink.default?.useStdout;

import {
  LOG_LEVEL_FILTERS,
  buildSearchMatches,
  cycleLogLevelFilter,
  exportVisibleLogs,
  filterLogEntries,
  formatLogTimestamp,
  formatVisibleLogLine,
  getLogSourceOptions,
  getSearchResultNavigation,
  toggleLogSource,
  wrapLogEntryRows,
} from "../../ui/tui/logs-screen-helpers.js";

const html = htm.bind(React.createElement);

const LEVEL_COLORS = {
  debug: "gray",
  info: "green",
  warn: "yellow",
  warning: "yellow",
  error: "red",
};

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function pad(text, width) {
  return String(text || "").padEnd(width, " ");
}

function levelLabel(levelMode) {
  if (levelMode === LOG_LEVEL_FILTERS.INFO_PLUS) return "INFO+";
  if (levelMode === LOG_LEVEL_FILTERS.WARN_PLUS) return "WARN+";
  if (levelMode === LOG_LEVEL_FILTERS.ERRORS_ONLY) return "ERRORS ONLY";
  return "ALL";
}

function renderHighlightedText(line, searchText) {
  const matches = buildSearchMatches(line, searchText);
  if (!matches.length) return html`<${Text}>${line}<//>`;
  const segments = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.start > cursor) {
      segments.push(html`<${Text} key=${`plain-${index}`}>${line.slice(cursor, match.start)}<//>`);
    }
    segments.push(html`<${Text} key=${`match-${index}`} backgroundColor="yellow" color="black">${line.slice(match.start, match.end)}<//>`);
    cursor = match.end;
  });
  if (cursor < line.length) {
    segments.push(html`<${Text} key="tail">${line.slice(cursor)}<//>`);
  }
  return segments;
}

function renderRow(row, searchText, activeSearchEntryId) {
  const isSearchHit = row.matchCount > 0;
  const isActiveHit = activeSearchEntryId && row.entryId === activeSearchEntryId;
  return html`
    <${Box} key=${row.id}>
      <${Text} dimColor>${row.prefix}<//>
      <${Text} backgroundColor=${isActiveHit ? "blue" : undefined}>
        ${isSearchHit ? renderHighlightedText(row.line, searchText) : row.line}
      <//>
    <//>
  `;
}

export default function LogsScreen({ logs = [], logsFilterState, onLogsFilterStateChange, onInputCaptureChange }) {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || process.stdout.columns || 120;
  const terminalHeight = stdout?.rows || process.stdout.rows || 30;
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filterCursor, setFilterCursor] = useState(0);
  const [statusLine, setStatusLine] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);

  const filteredEntries = useMemo(
    () => filterLogEntries(logs, logsFilterState),
    [logs, logsFilterState],
  );
  const sourceOptions = useMemo(
    () => getLogSourceOptions(logsFilterState, logs),
    [logs, logsFilterState],
  );
  const rows = useMemo(
    () => wrapLogEntryRows(filteredEntries, { terminalWidth }),
    [filteredEntries, terminalWidth],
  );
  const viewportHeight = Math.max(6, terminalHeight - 12);
  const maxOffset = Math.max(0, rows.length - viewportHeight);
  const effectiveOffset = autoScroll ? maxOffset : clamp(scrollOffset, 0, maxOffset);
  const visibleRows = rows.slice(effectiveOffset, effectiveOffset + viewportHeight);
  const searchNav = useMemo(
    () => getSearchResultNavigation(filteredEntries, logsFilterState?.searchText),
    [filteredEntries, logsFilterState?.searchText],
  );
  const activeMatch = searchNav.matches[activeMatchIndex] || null;
  const activeSearchEntryId = activeMatch?.entryId || null;

  useEffect(() => {
    if (typeof onInputCaptureChange === "function") {
      onInputCaptureChange(Boolean(logsFilterState?.searchOpen || logsFilterState?.filterBarOpen));
    }
    return () => {
      if (typeof onInputCaptureChange === "function") onInputCaptureChange(false);
    };
  }, [logsFilterState?.filterBarOpen, logsFilterState?.searchOpen, onInputCaptureChange]);

  useEffect(() => {
    setFilterCursor((current) => clamp(current, 0, Math.max(0, sourceOptions.length - 1)));
  }, [sourceOptions.length]);

  useEffect(() => {
    if (!searchNav.matches.length) {
      setActiveMatchIndex(0);
      return;
    }
    setActiveMatchIndex((current) => clamp(current, 0, searchNav.matches.length - 1));
  }, [searchNav.matches.length]);

  useEffect(() => {
    if (autoScroll) {
      setScrollOffset(maxOffset);
    }
  }, [autoScroll, maxOffset, rows.length]);

  useEffect(() => {
    if (!activeMatch) return;
    const rowIndex = rows.findIndex((row) => row.entryId === activeMatch.entryId);
    if (rowIndex === -1) return;
    const nextOffset = clamp(rowIndex, 0, Math.max(0, rows.length - viewportHeight));
    setScrollOffset(nextOffset);
    setAutoScroll(false);
  }, [activeMatch, rows, viewportHeight]);

  const setFilterState = (updater) => {
    if (typeof onLogsFilterStateChange !== "function") return;
    onLogsFilterStateChange(typeof updater === "function" ? updater(logsFilterState) : updater);
  };

  const moveScroll = (delta) => {
    setAutoScroll(false);
    setScrollOffset((current) => clamp(current + delta, 0, maxOffset));
  };

  useInput((input, key) => {
    if (logsFilterState?.searchOpen) {
      if (key.escape) {
        setFilterState((current) => ({ ...current, searchOpen: false, searchText: "" }));
        setActiveMatchIndex(0);
        return;
      }
      if (key.backspace || key.delete) {
        setFilterState((current) => ({ ...current, searchText: current.searchText.slice(0, -1) }));
        setActiveMatchIndex(0);
        return;
      }
      if (key.return) {
        setFilterState((current) => ({ ...current, searchOpen: false }));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFilterState((current) => ({ ...current, searchText: `${current.searchText || ""}${input}` }));
        setActiveMatchIndex(0);
      }
      return;
    }

    if (logsFilterState?.filterBarOpen) {
      if (key.escape || input === "f" || input === "F") {
        setFilterState((current) => ({ ...current, filterBarOpen: false }));
        return;
      }
      if (key.leftArrow) {
        setFilterCursor((current) => clamp(current - 1, 0, Math.max(0, sourceOptions.length - 1)));
        return;
      }
      if (key.rightArrow) {
        setFilterCursor((current) => clamp(current + 1, 0, Math.max(0, sourceOptions.length - 1)));
        return;
      }
      if (input === " " || key.return) {
        const option = sourceOptions[filterCursor];
        if (option) setFilterState((current) => toggleLogSource(current, option.key));
      }
      return;
    }

    if (input === "/") {
      setFilterState((current) => ({ ...current, searchOpen: true }));
      return;
    }
    if (key.escape && logsFilterState?.searchText) {
      setFilterState((current) => ({ ...current, searchText: "", searchOpen: false }));
      setActiveMatchIndex(0);
      return;
    }
    if (input === "f" || input === "F") {
      setFilterState((current) => ({ ...current, filterBarOpen: !current.filterBarOpen }));
      return;
    }
    if (input === "l" || input === "L") {
      setFilterState((current) => ({ ...current, levelMode: cycleLogLevelFilter(current.levelMode) }));
      return;
    }
    if (input === "g" || input === "G") {
      setAutoScroll(true);
      setScrollOffset(maxOffset);
      return;
    }
    if (input === "n" && searchNav.matches.length) {
      setActiveMatchIndex((current) => (current + 1) % searchNav.matches.length);
      return;
    }
    if (input === "N" && searchNav.matches.length) {
      setActiveMatchIndex((current) => (current - 1 + searchNav.matches.length) % searchNav.matches.length);
      return;
    }
    if (input === "e" || input === "E") {
      const renderedEntries = filteredEntries.map((entry) => formatVisibleLogLine(entry));
      const result = exportVisibleLogs({ entries: renderedEntries });
      setStatusLine(`Saved to ${result.relativePath}`);
      return;
    }

    if (key.upArrow) {
      moveScroll(-1);
      return;
    }
    if (key.downArrow) {
      moveScroll(1);
      return;
    }
    if (key.pageUp) {
      moveScroll(-viewportHeight);
      return;
    }
    if (key.pageDown) {
      moveScroll(viewportHeight);
    }
  });

  return html`
    <${Box} flexDirection="column" paddingX=${1}>
      <${Box} justifyContent="space-between">
        <${Text} bold>Logs<//>
        <${Text} dimColor>[F] Sources  [/] Search  [N] Next  [L] Level  [G] Bottom  [E] Export<//>
      <//>

      <${Box} justifyContent="space-between" marginTop=${1}>
        <${Text} dimColor>Level: ${levelLabel(logsFilterState?.levelMode)} · Auto-scroll: ${autoScroll ? "ON" : "OFF"} · Visible: ${filteredEntries.length}/${logs.length}<//>
        <${Text} dimColor>Matches: ${searchNav.matches.length ? `${activeMatchIndex + 1}/${searchNav.matches.length}` : "0/0"}<//>
      <//>

      ${logsFilterState?.filterBarOpen
        ? html`
            <${Box} marginTop=${1} flexWrap="wrap">
              ${sourceOptions.map((option, index) => html`
                <${Box} key=${option.key} marginRight=${1}>
                  <${Text} inverse=${index === filterCursor} color=${option.enabled ? "green" : "gray"}>
                    [${option.enabled ? "x" : " "}] ${option.label}
                  <//>
                <//>
              `)}
            <//>
          `
        : null}

      ${logsFilterState?.searchOpen || logsFilterState?.searchText
        ? html`
            <${Box} marginTop=${1}>
              <${Text} color=${logsFilterState?.searchOpen ? "cyan" : "yellow"}>
                /${logsFilterState?.searchText || ""}${logsFilterState?.searchOpen ? "█" : ""}
              <//>
            <//>
          `
        : null}

      <${Box} marginTop=${1} flexDirection="column" borderStyle="round" paddingX=${1} flexGrow=${1}>
        ${visibleRows.length
          ? visibleRows.map((row) => renderRow(row, logsFilterState?.searchText, activeSearchEntryId))
          : html`<${Text} dimColor>No log lines streamed yet.<//>`}
      <//>

      <${Box} marginTop=${1}>
        <${Text} dimColor>Showing rows ${visibleRows.length ? `${effectiveOffset + 1}-${effectiveOffset + visibleRows.length}` : "0"} of ${rows.length}<//>
      <//>

      ${statusLine
        ? html`
            <${Box} marginTop=${1}>
              <${Text} color="green">${statusLine}<//>
            <//>
          `
        : null}

      ${filteredEntries.length
        ? html`
            <${Box} marginTop=${1}>
              <${Text} dimColor>Latest: <//>
              <${Text} dimColor>${formatLogTimestamp(filteredEntries.at(-1)?.ts)} | <//>
              <${Text} color=${LEVEL_COLORS[String(filteredEntries.at(-1)?.level || "info").toLowerCase()] || "green"}>
                ${pad(String(filteredEntries.at(-1)?.level || "info").toUpperCase(), 5)}
              <//>
              <${Text} dimColor> | ${filteredEntries.at(-1)?.source || "monitor"}<//>
            <//>
          `
        : null}
    <//>
  `;
}
