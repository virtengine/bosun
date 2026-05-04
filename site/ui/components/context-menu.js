import { h } from "preact";
import { useCallback, useState } from "preact/hooks";
import htm from "htm";
import { Divider, ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { resolveIcon } from "../modules/icon-utils.js";

const html = htm.bind(h);

function buildAnchorPosition(event, offsets = {}) {
  const offsetX = Number.isFinite(Number(offsets.x)) ? Number(offsets.x) : 2;
  const offsetY = Number.isFinite(Number(offsets.y)) ? Number(offsets.y) : -6;
  return {
    mouseX: Math.max(0, Math.round(Number(event?.clientX || 0) + offsetX)),
    mouseY: Math.max(0, Math.round(Number(event?.clientY || 0) + offsetY)),
  };
}

export function useContextMenuState() {
  const [contextMenu, setContextMenu] = useState(null);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const openContextMenu = useCallback((payload = {}, event = null, offsets = {}) => {
    if (event?.preventDefault) event.preventDefault();
    if (event?.stopPropagation) event.stopPropagation();
    setContextMenu({
      ...buildAnchorPosition(event, offsets),
      ...(payload && typeof payload === "object" ? payload : {}),
    });
  }, []);

  return {
    contextMenu,
    setContextMenu,
    openContextMenu,
    closeContextMenu,
  };
}

export function AppContextMenu({
  menu = null,
  onClose,
  items = [],
}) {
  const visibleItems = (Array.isArray(items) ? items : []).filter((item) => item && item.hidden !== true);

  const handleItemClick = useCallback(async (item) => {
    if (!item || item.disabled) return;
    if (item.closeOnSelect !== false) {
      onClose?.();
    }
    await item.onClick?.(menu, item);
  }, [menu, onClose]);

  return html`
    <${Menu}
      open=${Boolean(menu)}
      onClose=${onClose}
      anchorReference="anchorPosition"
      anchorPosition=${menu ? { top: menu.mouseY, left: menu.mouseX } : undefined}
    >
      ${visibleItems.map((item, index) => {
        if (item.kind === "divider") {
          return html`<${Divider} key=${item.key || `divider-${index}`} />`;
        }
        const icon = item.icon ? resolveIcon(item.icon) : null;
        return html`
          <${MenuItem}
            key=${item.key || item.id || item.label || `item-${index}`}
            onClick=${() => handleItemClick(item)}
            disabled=${item.disabled === true}
            sx=${item.danger ? { color: "error.main" } : undefined}
          >
            ${icon
              ? html`
                  <${ListItemIcon} sx=${{ minWidth: "30px !important" }}>
                    ${icon}
                  </${ListItemIcon}>
                `
              : null}
            <${ListItemText}>${item.label || ""}</${ListItemText}>
          </${MenuItem}>
        `;
      })}
    </${Menu}>
  `;
}
