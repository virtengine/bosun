import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);
const TOASTUI_SCRIPT_SRC = "/assets/toastui-editor-all.min.js";
const TOASTUI_STYLE_HREFS = Object.freeze([
  "/styles/toastui-editor.css",
  "/styles/toastui-editor-viewer.css",
  "/styles/toastui-editor-dark.css",
]);

let toastUiLoaderPromise = null;

function ensureToastUiStyles() {
  if (typeof document === "undefined") return;
  for (const href of TOASTUI_STYLE_HREFS) {
    if (document.querySelector(`link[data-toastui-asset="${href}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.toastuiAsset = href;
    document.head.appendChild(link);
  }
}

function resolveToastUiTheme() {
  if (typeof document === "undefined") return "";
  const explicit = String(
    document.documentElement.getAttribute("data-theme")
    || document.body?.dataset?.theme
    || "",
  ).trim().toLowerCase();
  if (explicit) return explicit === "light" ? "" : "dark";
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches
      ? "dark"
      : "";
  } catch {
    return "";
  }
}

function resolvePreviewStyle() {
  try {
    return globalThis.innerWidth >= 960 ? "vertical" : "tab";
  } catch {
    return "vertical";
  }
}

function loadToastUi() {
  if (globalThis.toastui?.Editor) {
    ensureToastUiStyles();
    return Promise.resolve(globalThis.toastui);
  }
  if (toastUiLoaderPromise) return toastUiLoaderPromise;
  ensureToastUiStyles();
  toastUiLoaderPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-toastui-asset="${TOASTUI_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(globalThis.toastui), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load TOAST UI Editor")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = TOASTUI_SCRIPT_SRC;
    script.async = true;
    script.dataset.toastuiAsset = TOASTUI_SCRIPT_SRC;
    script.onload = () => {
      if (globalThis.toastui?.Editor) resolve(globalThis.toastui);
      else reject(new Error("TOAST UI Editor global not found after load"));
    };
    script.onerror = () => reject(new Error(`Failed to load ${TOASTUI_SCRIPT_SRC}`));
    document.head.appendChild(script);
  }).catch((error) => {
    toastUiLoaderPromise = null;
    throw error;
  });
  return toastUiLoaderPromise;
}

function createToastUiInstance(options = {}) {
  const EditorCtor = globalThis.toastui?.Editor;
  if (!EditorCtor) throw new Error("TOAST UI Editor is not loaded");
  return typeof EditorCtor.factory === "function"
    ? EditorCtor.factory(options)
    : new EditorCtor(options);
}

export function MarkdownTaskEditor({
  value = "",
  onChange = null,
  placeholder = "Add a task description...",
  minHeight = 320,
  className = "",
  disabled = false,
}) {
  const hostRef = useRef(null);
  const instanceRef = useRef(null);
  const lastValueRef = useRef(String(value || ""));
  const onChangeRef = useRef(onChange);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;
    loadToastUi()
      .then(() => {
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML = "";
        const instance = createToastUiInstance({
          el: hostRef.current,
          height: "auto",
          minHeight: `${Math.max(220, Number(minHeight) || 320)}px`,
          initialEditType: "markdown",
          initialValue: String(value || ""),
          placeholder,
          previewStyle: resolvePreviewStyle(),
          toolbarItems: [
            ["heading", "bold", "italic", "strike"],
            ["hr", "quote"],
            ["ul", "ol", "task", "indent", "outdent"],
            ["table", "link"],
            ["code", "codeblock"],
          ],
          theme: resolveToastUiTheme(),
          usageStatistics: false,
        });
        instanceRef.current = instance;
        lastValueRef.current = String(value || "");
        instance.on("change", () => {
          const next = String(instance.getMarkdown?.() || "");
          if (next === lastValueRef.current) return;
          lastValueRef.current = next;
          onChangeRef.current?.(next);
        });
        if (!cancelled) setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      try {
        instanceRef.current?.destroy?.();
      } catch { /* noop */ }
      instanceRef.current = null;
      if (hostRef.current) hostRef.current.innerHTML = "";
    };
  }, []);

  useEffect(() => {
    const instance = instanceRef.current;
    const next = String(value || "");
    if (!instance || next === lastValueRef.current) return;
    const current = String(instance.getMarkdown?.() || "");
    if (current === next) {
      lastValueRef.current = next;
      return;
    }
    lastValueRef.current = next;
    instance.setMarkdown?.(next, false);
  }, [value]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance?.setPlaceholder) return;
    instance.setPlaceholder(placeholder || "");
  }, [placeholder]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance?.setMinHeight) return;
    instance.setMinHeight(`${Math.max(220, Number(minHeight) || 320)}px`);
  }, [minHeight]);

  if (failed) {
    return html`
      <textarea
        class=${`task-markdown-fallback ${className}`.trim()}
        value=${value}
        placeholder=${placeholder}
        rows=${8}
        disabled=${disabled}
        onInput=${(event) => onChange?.(event.target.value)}
      ></textarea>
    `;
  }

  return html`
    <div class=${`task-markdown-editor-shell ${className}`.trim()} data-disabled=${disabled ? "true" : "false"}>
      ${loading ? html`<div class="task-markdown-loading">Loading editor...</div>` : null}
      <div class="task-markdown-host" ref=${hostRef}></div>
      ${disabled ? html`<div class="task-markdown-disabled-shield" aria-hidden="true"></div>` : null}
    </div>
  `;
}

export function MarkdownTaskViewer({
  value = "",
  className = "",
  emptyText = "No description provided yet.",
  maxHeight = "",
}) {
  const hostRef = useRef(null);
  const instanceRef = useRef(null);
  const lastValueRef = useRef(String(value || ""));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadToastUi()
      .then(() => {
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML = "";
        const instance = createToastUiInstance({
          el: hostRef.current,
          initialValue: String(value || ""),
          theme: resolveToastUiTheme(),
          usageStatistics: false,
          viewer: true,
        });
        instanceRef.current = instance;
        lastValueRef.current = String(value || "");
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
      });
    return () => {
      cancelled = true;
      try {
        instanceRef.current?.destroy?.();
      } catch { /* noop */ }
      instanceRef.current = null;
      if (hostRef.current) hostRef.current.innerHTML = "";
    };
  }, []);

  useEffect(() => {
    const instance = instanceRef.current;
    const next = String(value || "");
    if (!instance || next === lastValueRef.current) return;
    lastValueRef.current = next;
    instance.setMarkdown?.(next);
  }, [value]);

  if (!String(value || "").trim()) {
    return html`<div class=${`task-markdown-empty ${className}`.trim()}>${emptyText}</div>`;
  }

  if (failed) {
    return html`
      <div class=${`task-markdown-viewer task-markdown-viewer-fallback ${className}`.trim()} style=${maxHeight ? { maxHeight, overflowY: "auto" } : null}>
        <pre>${value}</pre>
      </div>
    `;
  }

  return html`
    <div class=${`task-markdown-viewer ${className}`.trim()} style=${maxHeight ? { maxHeight, overflowY: "auto" } : null}>
      <div class="task-markdown-host" ref=${hostRef}></div>
    </div>
  `;
}
