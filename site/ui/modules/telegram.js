/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Telegram SDK Wrapper
 *  Enhanced Telegram Mini App SDK integration
 * ────────────────────────────────────────────────────────────── */

import { signal } from "@preact/signals";

/* ─── Core Accessor ─── */

/** Get the Telegram WebApp instance, or null outside Telegram */
export function getTg() {
  return globalThis.Telegram?.WebApp || null;
}

function parseVersion(version) {
  const raw = String(version || "0").trim();
  const [maj = "0", min = "0"] = raw.split(".");
  return {
    major: Number.parseInt(maj, 10) || 0,
    minor: Number.parseInt(min, 10) || 0,
  };
}

function isVersionAtLeast(version, requiredMajor, requiredMinor = 0) {
  const { major, minor } = parseVersion(version);
  if (major > requiredMajor) return true;
  if (major < requiredMajor) return false;
  return minor >= requiredMinor;
}

function canUse(feature) {
  const tg = getTg();
  if (!tg) return false;
  const version = tg.version || "0";
  const check = (major, minor = 0) => {
    if (typeof tg.isVersionAtLeast === "function") {
      try {
        return tg.isVersionAtLeast(`${major}.${minor}`);
      } catch {
        return isVersionAtLeast(version, major, minor);
      }
    }
    return isVersionAtLeast(version, major, minor);
  };
  switch (feature) {
    case "backButton": return check(6, 1);
    case "settingsButton": return check(6, 1);
    case "haptic": return check(6, 1);
    case "cloudStorage": return check(6, 9);
    case "verticalSwipes": return check(7, 7);
    case "closingConfirmation": return check(6, 2);
    case "showPopup": return check(6, 2);
    case "showConfirm": return check(6, 2);
    case "showAlert": return check(6, 2);
    case "headerColor": return check(6, 1);
    case "backgroundColor": return check(6, 1);
    case "bottomBarColor": return check(6, 1);
    default: return true;
  }
}

function safeInvoke(fn, fallback = undefined) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Whether the app is running inside a Telegram WebView */
export const isTelegramContext = !!getTg();

/** Reactive color scheme signal ('light' | 'dark') */
export const colorScheme = signal(getTg()?.colorScheme || "dark");

/* ─── Haptic Feedback ─── */

/**
 * Trigger haptic feedback.
 * @param {'light'|'medium'|'heavy'|'rigid'|'soft'} type
 */
export function haptic(type = "light") {
  if (!canUse("haptic")) return;
  safeInvoke(() => getTg()?.HapticFeedback?.impactOccurred(type));
}

/* ─── Initialization ─── */

/**
 * Full Telegram WebApp initialization – call once at app mount.
 * Expands the viewport, enables fullscreen, disables vertical swipes,
 * sets header/background/bottom-bar colors, etc.
 */
export function initTelegramApp() {
  const tg = getTg();
  if (!tg) return;

  safeInvoke(() => tg.ready());
  safeInvoke(() => tg.expand());

  // Bot API 8.0+ fullscreen — only on mobile (desktop Telegram doesn't need it)
  const platform = (tg.platform || "").toLowerCase();
  const isMobile = platform === "ios" || platform === "android" || platform === "android_x";
  if (isMobile) {
    safeInvoke(() => tg.requestFullscreen?.());
  }

  // Bot API 7.7+ disable vertical swipes for custom scroll
  if (canUse("verticalSwipes")) {
    safeInvoke(() => tg.disableVerticalSwipes?.());
  }

  // Closing confirmation
  if (canUse("closingConfirmation")) {
    safeInvoke(() => tg.enableClosingConfirmation?.());
  }

  // Apply colours
  if (canUse("headerColor")) {
    safeInvoke(() => tg.setHeaderColor?.("secondary_bg_color"));
  }
  if (canUse("backgroundColor")) {
    safeInvoke(() => tg.setBackgroundColor?.("bg_color"));
  }
  if (canUse("bottomBarColor")) {
    safeInvoke(() => tg.setBottomBarColor?.("secondary_bg_color"));
  }

  // Apply theme params to CSS custom properties
  applyTgTheme();
}

/** Map Telegram themeParams to CSS custom properties on :root */
function applyTgTheme() {
  const tg = getTg();
  if (!tg?.themeParams) return;

  const tp = tg.themeParams;
  const root = document.documentElement;
  const explicitTheme = String(root.getAttribute("data-theme") || "").trim();
  const themeLock = String(root.getAttribute("data-theme-lock") || "").trim();
  const appThemeLocked = Boolean(themeLock === "custom" || (explicitTheme && explicitTheme !== "system"));

  if (appThemeLocked) {
    root.removeAttribute("data-tg-theme");
    return;
  }

  root.setAttribute("data-tg-theme", "true");

  if (tp.bg_color) root.style.setProperty("--bg-primary", tp.bg_color);
  if (tp.secondary_bg_color) {
    root.style.setProperty("--bg-secondary", tp.secondary_bg_color);
    root.style.setProperty("--bg-card", tp.secondary_bg_color);
  }
  if (tp.text_color) root.style.setProperty("--text-primary", tp.text_color);
  if (tp.hint_color) {
    root.style.setProperty("--text-secondary", tp.hint_color);
    root.style.setProperty("--text-hint", tp.hint_color);
  }
  if (tp.link_color) root.style.setProperty("--accent", tp.link_color);
  if (tp.button_color) root.style.setProperty("--accent", tp.button_color);
  if (tp.button_text_color)
    root.style.setProperty("--accent-text", tp.button_text_color);
}

/* ─── Event Listeners ─── */

/**
 * Subscribe to theme changes. Returns an unsubscribe function.
 * @param {() => void} callback
 * @returns {() => void}
 */
export function onThemeChange(callback) {
  const tg = getTg();
  if (!tg) return () => {};
  const handler = () => {
    applyTgTheme();
    callback();
  };
  safeInvoke(() => tg.onEvent("themeChanged", handler));
  return () => safeInvoke(() => tg.offEvent("themeChanged", handler));
}

/**
 * Subscribe to viewport changes. Returns an unsubscribe function.
 * @param {(event: {isStateStable: boolean}) => void} callback
 * @returns {() => void}
 */
export function onViewportChange(callback) {
  const tg = getTg();
  if (!tg) return () => {};
  safeInvoke(() => tg.onEvent("viewportChanged", callback));
  return () => safeInvoke(() => tg.offEvent("viewportChanged", callback));
}

/* ─── MainButton Helpers ─── */

/**
 * Show the Telegram MainButton with given text and handler.
 * @param {string} text
 * @param {() => void} onClick
 * @param {{color?: string, textColor?: string, progress?: boolean}} options
 */
export function showMainButton(text, onClick, options = {}) {
  const tg = getTg();
  if (!tg?.MainButton) return;
  tg.MainButton.setText(text);
  if (options.color) tg.MainButton.color = options.color;
  if (options.textColor) tg.MainButton.textColor = options.textColor;
  tg.MainButton.onClick(onClick);
  tg.MainButton.show();
  if (options.progress) tg.MainButton.showProgress();
}

/** Hide the Telegram MainButton and clear its handler. */
export function hideMainButton() {
  const tg = getTg();
  if (!tg?.MainButton) return;
  tg.MainButton.hide();
  tg.MainButton.hideProgress();
  try {
    tg.MainButton.offClick(tg.MainButton._callback);
  } catch {
    /* noop */
  }
}

/* ─── BackButton Helpers ─── */

/**
 * Show the Telegram BackButton with the given handler.
 * @param {() => void} onClick
 */
export function showBackButton(onClick) {
  const tg = getTg();
  if (!tg?.BackButton || !canUse("backButton")) return;
  safeInvoke(() => tg.BackButton.onClick(onClick));
  safeInvoke(() => tg.BackButton.show());
}

/** Hide the Telegram BackButton and clear its handler. */
export function hideBackButton() {
  const tg = getTg();
  if (!tg?.BackButton || !canUse("backButton")) return;
  safeInvoke(() => tg.BackButton.hide());
  safeInvoke(() => tg.BackButton.offClick(tg.BackButton._callback));
}

/* ─── SettingsButton ─── */

/**
 * Show the Telegram SettingsButton (header gear icon).
 * @param {() => void} onClick
 */
export function showSettingsButton(onClick) {
  const tg = getTg();
  if (!tg?.SettingsButton || !canUse("settingsButton")) return;
  safeInvoke(() => tg.SettingsButton.onClick(onClick));
  safeInvoke(() => tg.SettingsButton.show());
}

/* ─── Cloud Storage ─── */

/**
 * Read a value from Telegram Cloud Storage.
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function cloudStorageGet(key) {
  const tg = getTg();
  if (!tg?.CloudStorage || !canUse("cloudStorage")) return null;
  return new Promise((resolve) => {
    const ok = safeInvoke(() => {
      tg.CloudStorage.getItem(key, (err, val) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(val ?? null);
      });
      return true;
    }, false);
    if (!ok) resolve(null);
  });
}

/**
 * Write a value to Telegram Cloud Storage.
 * @param {string} key
 * @param {string} value
 * @returns {Promise<boolean>}
 */
export async function cloudStorageSet(key, value) {
  const tg = getTg();
  if (!tg?.CloudStorage || !canUse("cloudStorage")) return false;
  return new Promise((resolve) => {
    const ok = safeInvoke(() => {
      tg.CloudStorage.setItem(key, value, (err) => {
        resolve(!err);
      });
      return true;
    }, false);
    if (!ok) resolve(false);
  });
}

/**
 * Remove a key from Telegram Cloud Storage.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function cloudStorageRemove(key) {
  const tg = getTg();
  if (!tg?.CloudStorage || !canUse("cloudStorage")) return false;
  return new Promise((resolve) => {
    const ok = safeInvoke(() => {
      tg.CloudStorage.removeItem(key, (err) => {
        resolve(!err);
      });
      return true;
    }, false);
    if (!ok) resolve(false);
  });
}

/* ─── Auth / User ─── */

/** Get the raw initData string for server-side validation. */
export function getInitData() {
  return getTg()?.initData || "";
}

/** Get the current Telegram user object, or null. */
export function getTelegramUser() {
  return getTg()?.initDataUnsafe?.user || null;
}

/* ─── Native Dialogs ─── */

/**
 * Show a native Telegram confirm dialog (falls back to window.confirm).
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function showConfirm(message) {
  return new Promise((resolve) => {
    const tg = getTg();
    if (!tg?.showConfirm || !canUse("showConfirm")) {
      resolve(window.confirm(message));
      return;
    }
    const ok = safeInvoke(() => {
      tg.showConfirm(message, resolve);
      return true;
    }, false);
    if (!ok) resolve(window.confirm(message));
  });
}

/**
 * Show a native Telegram alert dialog (falls back to window.alert).
 * @param {string} message
 * @returns {Promise<void>}
 */
export function showAlert(message) {
  return new Promise((resolve) => {
    const tg = getTg();
    if (!tg?.showAlert || !canUse("showAlert")) {
      window.alert(message);
      resolve();
      return;
    }
    const ok = safeInvoke(() => {
      tg.showAlert(message, resolve);
      return true;
    }, false);
    if (!ok) {
      window.alert(message);
      resolve();
    }
  });
}

/* ─── External Links ─── */

/**
 * Open a URL in the external browser via Telegram, or fallback.
 * @param {string} url
 */
export function openLink(url) {
  const tg = getTg();
  if (tg?.openLink) {
    const ok = safeInvoke(() => {
      tg.openLink(url);
      return true;
    }, false);
    if (ok) return;
  }
  window.open(url, "_blank");
}

export function supportsTelegramFeature(feature) {
  return canUse(feature);
}

export function getTelegramVersion() {
  return getTg()?.version || "0";
}

/* ─── Platform ─── */

/** Return the current Telegram platform string (e.g. 'android', 'ios', 'tdesktop'). */
export function getPlatform() {
  return getTg()?.platform || "unknown";
}
