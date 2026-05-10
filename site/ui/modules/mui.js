/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – MUI Material Design Wrapper
 *  Provides themed MUI components compatible with Preact + HTM.
 *  All MUI imports flow through this module for tree-shakeability.
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import htm from "htm";
import {
  Alert,
  AppBar,
  Avatar,
  Badge,
  BottomNavigationAction,
  BottomNavigation,
  Box,
  Button,
  Chip,
  CircularProgress,
  CssBaseline,
  createTheme as createMuiTheme,
  Divider,
  Drawer,
  Fab,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  Toolbar,
  Tooltip,
  Typography,
  ThemeProvider as MuiThemeProvider,
  SvgIcon as MuiSvgIcon,
} from "@mui/material";

const html = htm.bind(h);

const DEFAULT_THEME_TOKENS = {
  primary: "#da7756",
  primaryContrast: "#1e1d1a",
  secondary: "#3b82f6",
  error: "#e5534b",
  warning: "#f59e0b",
  success: "#22c55e",
  info: "#3b82f6",
  backgroundDefault: "#1f1e1c",
  backgroundPaper: "#2b2a27",
  backgroundSurface: "#23221f",
  textPrimary: "#e8e5de",
  textSecondary: "#b5b0a6",
  textHint: "#908b81",
  divider: "rgba(255, 255, 255, 0.08)",
  borderStrong: "rgba(255, 255, 255, 0.14)",
  actionHoverDark: "rgba(255, 255, 255, 0.05)",
  actionSelectedDark: "rgba(218, 119, 86, 0.18)",
  actionDisabledDark: "rgba(255, 255, 255, 0.26)",
  actionDisabledBackgroundDark: "rgba(255, 255, 255, 0.08)",
  actionHoverLight: "rgba(15, 23, 42, 0.06)",
  actionSelectedLight: "rgba(37, 99, 235, 0.12)",
  actionDisabledLight: "rgba(15, 23, 42, 0.32)",
  actionDisabledBackgroundLight: "rgba(15, 23, 42, 0.08)",
  selectedGlowDark: "rgba(218,119,86,0.15)",
  selectedGlowHoverDark: "rgba(218,119,86,0.22)",
  selectedGlowLight: "rgba(37,99,235,0.10)",
  selectedGlowHoverLight: "rgba(37,99,235,0.16)",
  skeletonDark: "rgba(255,255,255,0.06)",
  skeletonLight: "rgba(15,23,42,0.08)",
  scrollbarDark: "rgba(255,255,255,0.12)",
  scrollbarLight: "rgba(15,23,42,0.18)",
};

function readCssVar(styles, name, fallback) {
  if (!styles) return fallback;
  const value = styles.getPropertyValue(name)?.trim();
  return value || fallback;
}

function parseColorChannels(color) {
  const value = String(color || "").trim().toLowerCase();
  if (!value) return null;

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      return hex
        .slice(0, 3)
        .split("")
        .map((part) => Number.parseInt(part + part, 16));
    }
    if (hex.length === 6 || hex.length === 8) {
      return [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((part) => Number.parseInt(part, 16));
    }
    return null;
  }

  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/);
  if (!rgbMatch) return null;
  const channels = rgbMatch[1]
    .split(",")
    .slice(0, 3)
    .map((part) => Number.parseFloat(part.trim()));
  return channels.every((part) => Number.isFinite(part)) ? channels : null;
}

function isLightColor(color) {
  const channels = parseColorChannels(color);
  if (!channels) return false;
  const [red, green, blue] = channels;
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance > 0.62;
}

function resolveThemeTokens() {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return {
      ...DEFAULT_THEME_TOKENS,
      mode: "dark",
      actionHover: DEFAULT_THEME_TOKENS.actionHoverDark,
      actionSelected: DEFAULT_THEME_TOKENS.actionSelectedDark,
      actionDisabled: DEFAULT_THEME_TOKENS.actionDisabledDark,
      actionDisabledBackground: DEFAULT_THEME_TOKENS.actionDisabledBackgroundDark,
      selectedGlow: DEFAULT_THEME_TOKENS.selectedGlowDark,
      selectedGlowHover: DEFAULT_THEME_TOKENS.selectedGlowHoverDark,
      skeleton: DEFAULT_THEME_TOKENS.skeletonDark,
      scrollbar: DEFAULT_THEME_TOKENS.scrollbarDark,
    };
  }

  const styles = getComputedStyle(document.documentElement);
  const backgroundDefault = readCssVar(styles, "--bg-primary", DEFAULT_THEME_TOKENS.backgroundDefault);
  const computedScheme = styles.colorScheme?.includes("light")
    ? "light"
    : styles.colorScheme?.includes("dark")
      ? "dark"
      : "";
  const mode = computedScheme || (isLightColor(backgroundDefault) ? "light" : "dark");
  const isLight = mode === "light";

  return {
    ...DEFAULT_THEME_TOKENS,
    mode,
    primary: readCssVar(styles, "--accent", DEFAULT_THEME_TOKENS.primary),
    primaryContrast: readCssVar(styles, "--accent-text", DEFAULT_THEME_TOKENS.primaryContrast),
    backgroundDefault,
    backgroundPaper: readCssVar(styles, "--bg-card", DEFAULT_THEME_TOKENS.backgroundPaper),
    backgroundSurface: readCssVar(styles, "--bg-surface", DEFAULT_THEME_TOKENS.backgroundSurface),
    textPrimary: readCssVar(styles, "--text-primary", DEFAULT_THEME_TOKENS.textPrimary),
    textSecondary: readCssVar(styles, "--text-secondary", DEFAULT_THEME_TOKENS.textSecondary),
    textHint: readCssVar(styles, "--text-hint", DEFAULT_THEME_TOKENS.textHint),
    divider: readCssVar(styles, "--border", DEFAULT_THEME_TOKENS.divider),
    borderStrong: readCssVar(styles, "--border-strong", DEFAULT_THEME_TOKENS.borderStrong),
    actionHover: isLight ? DEFAULT_THEME_TOKENS.actionHoverLight : DEFAULT_THEME_TOKENS.actionHoverDark,
    actionSelected: isLight ? DEFAULT_THEME_TOKENS.actionSelectedLight : DEFAULT_THEME_TOKENS.actionSelectedDark,
    actionDisabled: isLight ? DEFAULT_THEME_TOKENS.actionDisabledLight : DEFAULT_THEME_TOKENS.actionDisabledDark,
    actionDisabledBackground: isLight ? DEFAULT_THEME_TOKENS.actionDisabledBackgroundLight : DEFAULT_THEME_TOKENS.actionDisabledBackgroundDark,
    selectedGlow: isLight ? DEFAULT_THEME_TOKENS.selectedGlowLight : DEFAULT_THEME_TOKENS.selectedGlowDark,
    selectedGlowHover: isLight ? DEFAULT_THEME_TOKENS.selectedGlowHoverLight : DEFAULT_THEME_TOKENS.selectedGlowHoverDark,
    skeleton: isLight ? DEFAULT_THEME_TOKENS.skeletonLight : DEFAULT_THEME_TOKENS.skeletonDark,
    scrollbar: isLight ? DEFAULT_THEME_TOKENS.scrollbarLight : DEFAULT_THEME_TOKENS.scrollbarDark,
  };
}

function buildThemeOptions(tokens = resolveThemeTokens()) {
  return {
    palette: {
      mode: tokens.mode,
      primary: {
        main: tokens.primary,
        light: tokens.primary,
        dark: tokens.primary,
        contrastText: tokens.primaryContrast,
      },
      secondary: {
        main: tokens.secondary,
        light: tokens.secondary,
        dark: tokens.secondary,
      },
      error: { main: tokens.error },
      warning: { main: tokens.warning },
      success: { main: tokens.success },
      info: { main: tokens.info },
      background: {
        default: tokens.backgroundDefault,
        paper: tokens.backgroundPaper,
      },
      text: {
        primary: tokens.textPrimary,
        secondary: tokens.textSecondary,
        disabled: tokens.textHint,
      },
      divider: tokens.divider,
      action: {
        active: tokens.textSecondary,
        hover: tokens.actionHover,
        selected: tokens.actionSelected,
        disabled: tokens.actionDisabled,
        disabledBackground: tokens.actionDisabledBackground,
      },
    },
    typography: {
      fontFamily:
        '"Instrument Sans", "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "IBM Plex Sans", "Segoe UI", sans-serif',
      fontSize: 13,
      h1: { fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em" },
      h2: { fontSize: "1.4rem", fontWeight: 700, letterSpacing: "-0.02em" },
      h3: { fontSize: "1.15rem", fontWeight: 600, letterSpacing: "-0.01em" },
      h4: { fontSize: "1rem", fontWeight: 600 },
      h5: { fontSize: "0.9rem", fontWeight: 600 },
      h6: { fontSize: "0.8rem", fontWeight: 600 },
      body1: { fontSize: "0.875rem", lineHeight: 1.6 },
      body2: { fontSize: "0.8125rem", lineHeight: 1.5 },
      caption: { fontSize: "0.75rem", color: tokens.textHint },
      button: { textTransform: "none", fontWeight: 500 },
      overline: { fontSize: "0.65rem", fontWeight: 600, letterSpacing: "0.05em" },
    },
    shape: {
      borderRadius: 6,
    },
    shadows: [
      "none",
      "0 1px 2px rgba(5,10,18,0.35)",
      "0 2px 4px rgba(5,10,18,0.3)",
      "0 4px 8px rgba(5,10,18,0.28)",
      "0 6px 16px rgba(5,10,18,0.28)",
      "0 8px 20px rgba(5,10,18,0.3)",
      "0 12px 28px rgba(5,10,18,0.32)",
      "0 14px 32px rgba(5,10,18,0.32)",
      "0 16px 36px rgba(5,10,18,0.34)",
      "0 18px 40px rgba(5,10,18,0.34)",
      "0 20px 48px rgba(5,10,18,0.38)",
      ...Array(14).fill("0 20px 48px rgba(5,10,18,0.38)"),
    ],
    zIndex: {
      modal: 11000,
      snackbar: 11050,
      tooltip: 11100,
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            scrollbarColor: `${tokens.scrollbar} transparent`,
            "&::-webkit-scrollbar": { width: 6 },
            "&::-webkit-scrollbar-thumb": {
              background: tokens.scrollbar,
              borderRadius: 3,
            },
          },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true, size: "small" },
        styleOverrides: {
          root: {
            borderRadius: 6,
            textTransform: "none",
            fontWeight: 500,
            fontSize: "0.8125rem",
            lineHeight: 1.4,
            padding: "6px 14px",
          },
          sizeSmall: { padding: "4px 10px", fontSize: "0.75rem" },
          containedPrimary: {
            color: tokens.primaryContrast,
            backgroundColor: tokens.primary,
            "&:hover": { backgroundColor: tokens.primary },
          },
          outlined: {
            borderColor: tokens.borderStrong,
            color: tokens.textPrimary,
          },
        },
      },
      MuiIconButton: {
        defaultProps: { size: "small" },
        styleOverrides: {
          root: { borderRadius: 6, color: tokens.textSecondary },
          sizeSmall: { padding: 4 },
        },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            backgroundImage: "none",
            backgroundColor: tokens.backgroundPaper,
            color: tokens.textPrimary,
            border: `1px solid ${tokens.divider}`,
          },
        },
      },
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            backgroundImage: "none",
            backgroundColor: tokens.backgroundPaper,
            color: tokens.textPrimary,
            border: `1px solid ${tokens.divider}`,
            borderRadius: 8,
          },
        },
      },
      MuiChip: {
        defaultProps: { size: "small" },
        styleOverrides: {
          root: {
            fontWeight: 500,
            fontSize: "0.7rem",
            height: 22,
            color: tokens.textSecondary,
            backgroundColor: tokens.backgroundPaper,
            borderColor: tokens.divider,
          },
          sizeSmall: { height: 20 },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            backgroundImage: "none",
            backgroundColor: tokens.backgroundPaper,
            borderRadius: 12,
            color: tokens.textPrimary,
            border: `1px solid ${tokens.borderStrong}`,
          },
        },
      },
      MuiTooltip: {
        defaultProps: { arrow: true, enterDelay: 400 },
        styleOverrides: {
          tooltip: {
            backgroundColor: tokens.backgroundDefault,
            color: tokens.textPrimary,
            border: `1px solid ${tokens.borderStrong}`,
            fontSize: "0.75rem",
          },
          arrow: { color: tokens.backgroundDefault },
        },
      },
      MuiTextField: {
        defaultProps: { size: "small", variant: "outlined" },
        styleOverrides: {
          root: {
            "& .MuiOutlinedInput-root": {
              fontSize: "0.8125rem",
              borderRadius: 6,
              color: tokens.textPrimary,
              "& fieldset": {
                borderColor: tokens.borderStrong,
              },
              "&:hover fieldset": {
                borderColor: tokens.textSecondary,
              },
            },
          },
        },
      },
      MuiSelect: {
        defaultProps: { size: "small" },
      },
      MuiSwitch: {
        defaultProps: { size: "small" },
      },
      MuiAccordion: {
        defaultProps: { disableGutters: true, elevation: 0 },
        styleOverrides: {
          root: {
            backgroundColor: "transparent",
            border: `1px solid ${tokens.divider}`,
            borderRadius: "6px !important",
            "&:before": { display: "none" },
            "&.Mui-expanded": { margin: 0 },
          },
        },
      },
      MuiAccordionSummary: {
        styleOverrides: {
          root: {
            minHeight: 40,
            padding: "0 12px",
            fontSize: "0.8125rem",
            fontWeight: 500,
            color: tokens.textPrimary,
            "&.Mui-expanded": { minHeight: 40 },
          },
          content: { margin: "8px 0", "&.Mui-expanded": { margin: "8px 0" } },
        },
      },
      MuiAccordionDetails: {
        styleOverrides: {
          root: { padding: "4px 12px 12px", color: tokens.textSecondary },
        },
      },
      MuiList: {
        styleOverrides: {
          root: { padding: 0 },
        },
      },
      MuiListItem: {
        styleOverrides: {
          root: { padding: "4px 12px" },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 6,
            padding: "6px 12px",
            color: tokens.textPrimary,
            "&.Mui-selected": {
              backgroundColor: tokens.selectedGlow,
              "&:hover": { backgroundColor: tokens.selectedGlowHover },
            },
          },
        },
      },
      MuiDivider: {
        styleOverrides: {
          root: { borderColor: tokens.divider },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 8, fontSize: "0.8125rem" },
        },
      },
      MuiSnackbar: {
        defaultProps: {
          anchorOrigin: { vertical: "bottom", horizontal: "center" },
          autoHideDuration: 4000,
        },
      },
      MuiSkeleton: {
        defaultProps: { animation: "wave" },
        styleOverrides: {
          root: { backgroundColor: tokens.skeleton },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            textTransform: "none",
            fontWeight: 500,
            fontSize: "0.8125rem",
            minHeight: 40,
            padding: "8px 14px",
            color: tokens.textPrimary,
            opacity: 0.95,
            flexDirection: "row",
            gap: 8,
            "&.Mui-selected": {
              color: tokens.primary,
              opacity: 1,
            },
            "&:hover": {
              opacity: 1,
            },
            "& .MuiTab-iconWrapper": { marginBottom: "0 !important", marginRight: 0 },
          },
          iconWrapper: {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            width: 20,
            height: 20,
            "& svg": { width: "100%", height: "100%" },
          },
        },
      },
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 40 },
          indicator: {
            backgroundColor: tokens.primary,
            height: 2,
          },
        },
      },
      MuiBottomNavigation: {
        styleOverrides: {
          root: {
            backgroundColor: tokens.backgroundSurface,
            borderTop: `1px solid ${tokens.divider}`,
          },
        },
      },
      MuiBottomNavigationAction: {
        styleOverrides: {
          root: {
            color: tokens.textHint,
            minWidth: 64,
            paddingTop: 8,
            paddingBottom: 8,
            transition: "color 0.18s ease, transform 0.18s ease",
            "&.Mui-selected": {
              color: tokens.primary,
            },
            "& svg": { width: 24, height: 24, flexShrink: 0 },
          },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            backgroundColor: tokens.backgroundSurface,
            border: `1px solid ${tokens.borderStrong}`,
            borderRadius: 10,
            color: tokens.textPrimary,
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            fontSize: "0.8125rem",
            borderRadius: 6,
            margin: "2px 4px",
            padding: "6px 12px",
            color: tokens.textPrimary,
          },
        },
      },
      MuiLinearProgress: {
        styleOverrides: {
          root: { borderRadius: 4, height: 6 },
          bar: { borderRadius: 4 },
        },
      },
      MuiCircularProgress: {
        defaultProps: { size: 20, thickness: 3 },
      },
      MuiAvatar: {
        styleOverrides: {
          root: {
            fontSize: "0.8125rem",
            fontWeight: 600,
            backgroundColor: tokens.primary,
            color: tokens.primaryContrast,
          },
        },
      },
      MuiBadge: {
        styleOverrides: {
          badge: { fontSize: "0.65rem", fontWeight: 600 },
        },
      },
      MuiFab: {
        defaultProps: { size: "small" },
        styleOverrides: {
          root: { boxShadow: "0 4px 12px rgba(0,0,0,0.3)" },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: tokens.backgroundDefault,
            color: tokens.textPrimary,
            borderColor: tokens.divider,
          },
        },
      },
      MuiAppBar: {
        defaultProps: { elevation: 0, color: "inherit" },
        styleOverrides: {
          root: {
            backgroundColor: tokens.backgroundDefault,
            color: tokens.textPrimary,
            borderBottom: `1px solid ${tokens.divider}`,
          },
        },
      },
    },
  };
}

const DARK_THEME_TOKENS = {
  ...DEFAULT_THEME_TOKENS,
  mode: "dark",
  actionHover: DEFAULT_THEME_TOKENS.actionHoverDark,
  actionSelected: DEFAULT_THEME_TOKENS.actionSelectedDark,
  actionDisabled: DEFAULT_THEME_TOKENS.actionDisabledDark,
  actionDisabledBackground: DEFAULT_THEME_TOKENS.actionDisabledBackgroundDark,
  selectedGlow: DEFAULT_THEME_TOKENS.selectedGlowDark,
  selectedGlowHover: DEFAULT_THEME_TOKENS.selectedGlowHoverDark,
  skeleton: DEFAULT_THEME_TOKENS.skeletonDark,
  scrollbar: DEFAULT_THEME_TOKENS.scrollbarDark,
};

// Re-export everything apps need from @mui/material
export {
  Alert,
  AppBar,
  Avatar,
  Badge,
  BottomNavigation,
  BottomNavigationAction,
  Box,
  Button,
  Chip,
  CircularProgress,
  CssBaseline,
  Divider,
  Drawer,
  Fab,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  Toolbar,
  Tooltip,
  Typography,
};
export {
  ThemeProvider,
  createTheme,
  styled,
  useTheme,
  alpha,
  Container,
  Grid,
  ButtonGroup,
  TextField,
  Select,
  Checkbox,
  Radio,
  RadioGroup,
  FormControl,
  FormControlLabel,
  FormLabel,
  FormGroup,
  FormHelperText,
  InputLabel,
  InputAdornment,
  OutlinedInput,
  Switch,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Autocomplete,
  Rating,
  AvatarGroup,
  List,
  ListItem,
  ListItemAvatar,
  ListItemButton,
  ListItemIcon,
  ListItemSecondaryAction,
  ListItemText,
  ListSubheader,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  AlertTitle,
  Backdrop,
  LinearProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Skeleton,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  AccordionActions,
  Card,
  CardHeader,
  CardContent,
  CardActions,
  CardActionArea,
  CardMedia,
  Breadcrumbs,
  Link,
  Collapse,
  Pagination,
  SpeedDial,
  SpeedDialAction,
  SpeedDialIcon,
  Step,
  StepLabel,
  Stepper,
  ClickAwayListener,
  Modal,
  Popover,
  Popper,
  Portal,
  Fade,
  Grow,
  Slide,
  Zoom,
  SvgIcon,
  colors,
} from "@mui/material";

/**
 * VirtEngine base theme export for compatibility.
 * `VeTheme` resolves a live theme from the current CSS variables.
 */
export const veTheme = createMuiTheme(buildThemeOptions(DARK_THEME_TOKENS));

function useResolvedMuiTheme() {
  const [themeVersion, setThemeVersion] = useState(0);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;

    const root = document.documentElement;
    const refreshTheme = () => setThemeVersion((value) => value + 1);
    const observer = new MutationObserver(refreshTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-lock", "data-tg-theme", "style"],
    });

    let mediaQuery = null;
    const handleMediaChange = () => refreshTheme();
    if (typeof globalThis.matchMedia === "function") {
      mediaQuery = globalThis.matchMedia("(prefers-color-scheme: light)");
      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", handleMediaChange);
      } else if (typeof mediaQuery.addListener === "function") {
        mediaQuery.addListener(handleMediaChange);
      }
    }

    return () => {
      observer.disconnect();
      if (mediaQuery) {
        if (typeof mediaQuery.removeEventListener === "function") {
          mediaQuery.removeEventListener("change", handleMediaChange);
        } else if (typeof mediaQuery.removeListener === "function") {
          mediaQuery.removeListener(handleMediaChange);
        }
      }
    };
  }, []);

  return useMemo(() => createMuiTheme(buildThemeOptions(resolveThemeTokens())), [themeVersion]);
}

/**
 * Wrap content in the VirtEngine MUI theme.
 * Usage in htm: html`<${VeTheme}> ...children... </${VeTheme}>`
 */
export function VeTheme({ children }) {
  const theme = useResolvedMuiTheme();
  return html`<${MuiThemeProvider} theme=${theme}>${children}</${MuiThemeProvider}>`;
}

/**
 * Helper: MUI-styled icon wrapper for SVG icon elements.
 * Wraps an existing inline SVG in MUI SvgIcon for consistency.
 */
export function MuiIcon({ children, ...props }) {
  return html`<${MuiSvgIcon} ...${props} sx=${{ fontSize: "inherit", ...props.sx }}>${children}</${MuiSvgIcon}>`;
}
