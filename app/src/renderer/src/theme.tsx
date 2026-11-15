import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { App as AntApp, ConfigProvider, theme as antdTheme } from 'antd'
import type { ThemeConfig } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { PREF } from './prefs'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ThemePalette = 'vivid' | 'classic'

const MODE_KEY = PREF.themeMode
const PALETTE_KEY = PREF.palette

const FONT_SANS = "-apple-system, 'Segoe UI', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"

interface ThemeContextValue {
  /** 用户选择：浅色 / 深色 / 跟随系统 */
  mode: ThemeMode
  /** 实际生效：system 已解析为 light 或 dark */
  resolved: 'light' | 'dark'
  /** 配色包：多巴胺 / 经典 */
  palette: ThemePalette
  setMode: (mode: ThemeMode) => void
  setPalette: (palette: ThemePalette) => void
  /** 顶栏按钮：浅色 → 深色 → 跟随系统 → 浅色 */
  cycleMode: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function isMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
}

function isPalette(value: unknown): value is ThemePalette {
  return value === 'vivid' || value === 'classic'
}

function readMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(MODE_KEY)
    if (isMode(stored)) return stored
  } catch { /* storage may be disabled */ }
  return 'light'
}

function readPalette(): ThemePalette {
  try {
    const stored = localStorage.getItem(PALETTE_KEY)
    if (isPalette(stored)) return stored
    // 旧版本只有一个布尔开关；新默认改为全局多巴胺，开启过的用户保持多巴胺。
    const legacy = localStorage.getItem(PREF.vivid)
    if (legacy === 'true') return 'vivid'
  } catch { /* storage may be disabled */ }
  return 'vivid'
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

// 在 React 首次渲染前写入外观，避免深色用户看到一帧白屏。
if (typeof document !== 'undefined') {
  const initialMode = readMode()
  const initialPalette = readPalette()
  const initialDark = initialMode === 'system' ? systemDark() : initialMode === 'dark'
  const root = document.documentElement
  root.dataset.theme = initialDark ? 'dark' : 'light'
  root.dataset.palette = initialPalette
  root.classList.toggle('theme-dark', initialDark)
  root.classList.toggle('theme-vivid', initialPalette === 'vivid')
  root.style.colorScheme = initialDark ? 'dark' : 'light'
}

export function buildThemeConfig(resolved: 'light' | 'dark', palette: ThemePalette): ThemeConfig {
  const dark = resolved === 'dark'
  const vivid = palette === 'vivid'
  const ink = vivid ? (dark ? '#5B3FD6' : '#6D4AFF') : dark ? '#2B2B2B' : '#111111'
  const primary = vivid ? (dark ? '#8B6CFF' : '#6D4AFF') : '#111111'
  const text = dark ? (vivid ? '#F7F2FF' : '#F2F2F2') : vivid ? '#241A33' : '#111111'
  const text2 = dark ? (vivid ? '#C9BCDF' : '#BDBDBD') : vivid ? '#5F4E75' : '#5C5C5C'
  const text3 = dark ? (vivid ? '#9789AE' : '#8F8F8F') : vivid ? '#9786AB' : '#9A9A9A'
  const line = dark ? (vivid ? '#3A3150' : '#333333') : vivid ? '#F0DFEC' : '#E5E5E5'
  const lineSoft = dark ? (vivid ? '#2A233B' : '#292929') : vivid ? '#F8ECF5' : '#EFEFEF'
  const surface = dark ? (vivid ? '#1D182A' : '#1B1B1B') : vivid ? '#FFFDFB' : '#FFFFFF'
  const surface2 = dark ? (vivid ? '#241E34' : '#232323') : vivid ? '#FFF2F7' : '#FAFAFA'
  const bgLayout = dark ? (vivid ? '#14101F' : '#121212') : vivid ? '#FFF6EE' : '#FFFFFF'
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: primary,
      colorLink: vivid ? (dark ? '#B7A1FF' : '#5B3FD6') : dark ? '#D4D4D4' : '#111111',
      colorInfo: vivid ? (dark ? '#8FB3FF' : '#3F7DF6') : '#111111',
      colorSuccess: vivid ? (dark ? '#4ADE9F' : '#128A63') : '#2F7D46',
      colorWarning: vivid ? (dark ? '#FFC24B' : '#B26A00') : '#8A6A16',
      colorError: vivid ? (dark ? '#FF8AA0' : '#D1435B') : '#B4372F',
      borderRadius: vivid ? 6 : 2,
      borderRadiusLG: vivid ? 8 : 2,
      borderRadiusSM: vivid ? 4 : 2,
      fontSize: 13,
      fontFamily: FONT_SANS,
      colorBorder: line,
      colorBorderSecondary: lineSoft,
      colorText: text,
      colorTextSecondary: text2,
      colorTextTertiary: text3,
      colorBgLayout: bgLayout,
      colorBgContainer: surface,
      colorBgElevated: surface,
      controlHeight: 30,
      boxShadow: 'none',
      boxShadowSecondary: dark ? '0 10px 28px rgba(0,0,0,.45)' : '0 6px 24px rgba(80,40,120,.12)'
    },
    components: {
      Button: { fontWeight: 500, defaultShadow: 'none', primaryShadow: 'none' },
      Card: { boxShadow: 'none' },
      Tabs: { itemSelectedColor: text, inkBarColor: vivid ? (dark ? '#B7A1FF' : '#6D4AFF') : ink, titleFontSize: 13 },
      Menu: {
        itemHeight: 34,
        itemSelectedBg: vivid ? (dark ? '#2E2447' : '#F3ECFF') : surface2,
        itemSelectedColor: vivid ? (dark ? '#E7DEFF' : '#3F2A96') : text,
        itemColor: text2
      },
      Table: {
        headerBg: surface2,
        headerColor: text2,
        borderColor: lineSoft,
        rowHoverBg: vivid ? surface2 : surface2
      },
      Tag: {
        defaultBg: vivid ? (dark ? '#2E2447' : '#FFF0F6') : surface2,
        defaultColor: vivid ? (dark ? '#E4D8FF' : '#7A3A63') : text2
      },
      Input: { activeBorderColor: primary, hoverBorderColor: primary, activeShadow: 'none' },
      Select: { optionSelectedBg: vivid ? surface2 : surface2 },
      Drawer: { footerPaddingBlock: 12 },
      Modal: { borderRadiusLG: vivid ? 8 : 2 },
      Pagination: { itemActiveBg: primary },
      Segmented: {
        itemSelectedBg: vivid ? (dark ? '#3A2C5C' : '#FFFFFF') : surface,
        itemSelectedColor: text,
        trackBg: surface2
      },
      Popover: { colorBgElevated: surface }
    }
  }
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(readMode)
  const [palette, setPaletteState] = useState<ThemePalette>(readPalette)
  const [prefersDark, setPrefersDark] = useState<boolean>(systemDark)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (event: MediaQueryListEvent): void => setPrefersDark(event.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])

  const resolved: 'light' | 'dark' = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode

  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolved
    root.dataset.palette = palette
    root.classList.toggle('theme-dark', resolved === 'dark')
    root.classList.toggle('theme-vivid', palette === 'vivid')
    root.style.colorScheme = resolved
  }, [resolved, palette])

  const setMode = useCallback((next: ThemeMode): void => {
    setModeState(next)
    try { localStorage.setItem(MODE_KEY, next) } catch { /* ignore */ }
  }, [])

  const setPalette = useCallback((next: ThemePalette): void => {
    setPaletteState(next)
    try {
      localStorage.setItem(PALETTE_KEY, next)
      localStorage.setItem(PREF.vivid, String(next === 'vivid'))
    } catch { /* ignore */ }
  }, [])

  const cycleMode = useCallback((): void => {
    setMode(mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light')
  }, [mode, setMode])

  const config = useMemo(() => buildThemeConfig(resolved, palette), [resolved, palette])

  return (
    <ThemeContext.Provider value={{ mode, resolved, palette, setMode, setPalette, cycleMode }}>
      <ConfigProvider locale={zhCN} theme={config}>
        <AntApp>{children}</AntApp>
      </ConfigProvider>
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}

export const THEME_MODE_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
  { label: '跟随系统', value: 'system' }
]

export const THEME_PALETTE_OPTIONS: { label: string; value: ThemePalette }[] = [
  { label: '多巴胺', value: 'vivid' },
  { label: '经典', value: 'classic' }
]
