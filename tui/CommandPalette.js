import React from "react";
import htm from "htm";
import * as ink from "ink";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useInput = ink.useInput ?? ink.default?.useInput;

import { rankCommandPaletteActions } from "./lib/command-palette.mjs";

const html = htm.bind(React.createElement);

function fit(text, width) {
  const value = String(text || "");
  if (value.length <= width) return value.padEnd(width, " ");
  if (width <= 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}

export default function CommandPalette({ actions = [], visible = false, onClose, onExecute }) {
  const [query, setQuery] = React.useState("");
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const ranked = React.useMemo(() => rankCommandPaletteActions(query, actions), [query, actions]);

  React.useEffect(() => {
    if (!visible) {
      setQuery("");
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex(0);
  }, [visible]);

  useInput((input, key) => {
    if (!visible) return;

    if (key.escape) {
      onClose?.();
      return;
    }
    if (key.return) {
      const selected = ranked[selectedIndex];
      if (selected) onExecute?.(selected);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(Math.max(0, ranked.length - 1), current + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((current) => `${current}${input}`);
    }
  }, { isActive: visible });

  if (!visible) return null;

  const rows = ranked.slice(0, 8);
  return html`
    <${Box} flexDirection="column" borderStyle="double" paddingX=${1} width="100%">
      <${Text} bold>Command Palette<//>
      <${Text}>> ${query || ""}<//>
      <${Text} dimColor>${query ? "Fuzzy match any action" : "Recent actions"}<//>
      ${rows.length
        ? rows.map((action, index) => {
            const selected = index === selectedIndex;
            return html`
              <${Box} key=${action.id}>
                <${Text} inverse=${selected}>${fit(action.icon || "•", 2)}<//>
                <${Text} inverse=${selected}> ${fit(action.label, 34)}<//>
                <${Text} inverse=${selected} color="cyan"> ${fit(action.shortcut || "", 8)}<//>
                <${Text} inverse=${selected} dimColor> ${fit(action.context || "", 24)}<//>
              <//>
            `;
          })
        : html`<${Text} dimColor>No matching actions.<//>`}
      <${Text} dimColor>[↑/↓] Select  [Enter] Run  [Esc] Close<//>
    <//>
  `;
}
