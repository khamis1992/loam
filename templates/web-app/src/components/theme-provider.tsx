import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type Theme = "light" | "dark" | "system";
type Direction = "ltr" | "rtl";
type ResolvedTheme = "light" | "dark";

interface ThemeProviderState {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  direction: Direction;
  lang: string;
  setTheme: (theme: Theme) => void;
  setDirection: (direction: Direction) => void;
  toggleTheme: () => void;
  toggleDirection: () => void;
}

const STORAGE_THEME = "loam-theme";
const STORAGE_DIR = "loam-dir";

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_THEME);
  return stored === "light" || stored === "dark" ? stored : "system";
}

function readStoredDirection(): Direction {
  if (typeof window === "undefined") return "ltr";
  return window.localStorage.getItem(STORAGE_DIR) === "rtl" ? "rtl" : "ltr";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [direction, setDirectionState] = useState<Direction>(() => readStoredDirection());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    theme === "system" ? systemTheme() : theme,
  );

  useEffect(() => {
    const next = theme === "system" ? systemTheme() : theme;
    setResolvedTheme(next);
    const root = document.documentElement;
    root.classList.toggle("dark", next === "dark");
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("dir", direction);
    root.setAttribute("lang", direction === "rtl" ? "ar" : "en");
  }, [direction]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (theme === "system") setResolvedTheme(media.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    window.localStorage.setItem(STORAGE_THEME, next);
    setThemeState(next);
  }, []);

  const setDirection = useCallback((next: Direction) => {
    window.localStorage.setItem(STORAGE_DIR, next);
    setDirectionState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  const toggleDirection = useCallback(() => {
    setDirection(direction === "rtl" ? "ltr" : "rtl");
  }, [direction, setDirection]);

  const value = useMemo<ThemeProviderState>(
    () => ({
      theme,
      resolvedTheme,
      direction,
      lang: direction === "rtl" ? "ar" : "en",
      setTheme,
      setDirection,
      toggleTheme,
      toggleDirection,
    }),
    [theme, resolvedTheme, direction, setTheme, setDirection, toggleTheme, toggleDirection],
  );

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeProviderState {
  const context = useContext(ThemeProviderContext);
  if (!context) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
}
