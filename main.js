const { app, BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const HARD_TILE_LIMIT = 12;
const DEFAULT_TILE_COUNT = 5;
const CHART_WIDTH_RANGE = { min: 160, max: 800 };
const CHART_HEIGHT_RANGE = { min: 120, max: 600 };
const DEFAULT_WINDOW_SIZE = { width: 1400, height: 900 };
const WINDOW_STATE_DEBOUNCE_MS = 150;
const WINDOW_STATE_MAX_DIMENSION = 5000;
const STARTUP_LOG_FILE = "startup.log";
const STARTUP_LOG_ENABLED = process.env.TVMC_STARTUP_LOG === "1";
const DEFAULT_SYMBOLS = [
  "FX:USDJPY",
  "CME_MINI_DL:ES1!",
  "TVC:GOLD",
  "TVC:US10Y",
  "TVC:JP10Y",
];
const ALLOWED_THEMES = new Set(["light", "dark"]);
const ALLOWED_LINE_CHART_TYPES = new Set(["Baseline", "Line", "Area"]);

const DEFAULT_CONFIG = {
  theme: "dark",
  alwaysOnTop: false,
  maxTiles: DEFAULT_TILE_COUNT,
  chartWidth: 320,
  chartHeight: 250,
  tiles: createDefaultTiles(DEFAULT_TILE_COUNT),
};

let mainWindow = null;
let currentConfig = clone(DEFAULT_CONFIG);
let windowStateSaveTimer = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function fallbackSymbol(index) {
  return DEFAULT_SYMBOLS[index % DEFAULT_SYMBOLS.length];
}

function createDefaultTiles(count) {
  const tiles = [];
  for (let index = 0; index < count; index += 1) {
    tiles.push({
      id: `tile-${index + 1}`,
      symbol: fallbackSymbol(index),
      lineChartType: "Baseline",
    });
  }
  return tiles;
}

function sanitizeSymbol(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : fallback;
}

function sanitizeLineChartType(value) {
  if (typeof value === "string" && ALLOWED_LINE_CHART_TYPES.has(value)) {
    return value;
  }
  return "Baseline";
}

function sanitizeId(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function sanitizeConfig(rawConfig) {
  const source =
    rawConfig && typeof rawConfig === "object" ? rawConfig : DEFAULT_CONFIG;
  const tileCount = clampNumber(
    source.maxTiles,
    1,
    HARD_TILE_LIMIT,
    DEFAULT_TILE_COUNT,
  );
  const sourceTiles = Array.isArray(source.tiles) ? source.tiles : [];
  const tiles = [];

  for (let index = 0; index < tileCount; index += 1) {
    const fallback = fallbackSymbol(index);
    const tile = sourceTiles[index] || {};
    tiles.push({
      id: sanitizeId(tile.id, `tile-${index + 1}`),
      symbol: sanitizeSymbol(tile.symbol, fallback),
      lineChartType: sanitizeLineChartType(tile.lineChartType),
    });
  }

  const chartWidth = clampNumber(
    source.chartWidth,
    CHART_WIDTH_RANGE.min,
    CHART_WIDTH_RANGE.max,
    DEFAULT_CONFIG.chartWidth,
  );
  const chartHeight = clampNumber(
    source.chartHeight,
    CHART_HEIGHT_RANGE.min,
    CHART_HEIGHT_RANGE.max,
    DEFAULT_CONFIG.chartHeight,
  );

  return {
    theme: ALLOWED_THEMES.has(source.theme) ? source.theme : "dark",
    alwaysOnTop: Boolean(source.alwaysOnTop),
    maxTiles: tileCount,
    chartWidth,
    chartHeight,
    tiles,
  };
}

function computeMinimumContentSize(config) {
  return {
    width: Number(config.chartWidth) + 24,
    height: 56 + Number(config.chartHeight) + 24,
  };
}

function sanitizeCoordinate(value) {
  if (!Number.isFinite(Number(value))) {
    return undefined;
  }
  return Math.trunc(Number(value));
}

function sanitizeWindowState(rawState, minimumContentSize) {
  const source = rawState && typeof rawState === "object" ? rawState : {};
  const minimum = minimumContentSize || computeMinimumContentSize(currentConfig);
  const width = clampNumber(
    source.width,
    minimum.width,
    WINDOW_STATE_MAX_DIMENSION,
    Math.max(DEFAULT_WINDOW_SIZE.width, minimum.width),
  );
  const height = clampNumber(
    source.height,
    minimum.height,
    WINDOW_STATE_MAX_DIMENSION,
    Math.max(DEFAULT_WINDOW_SIZE.height, minimum.height),
  );
  const x = sanitizeCoordinate(source.x);
  const y = sanitizeCoordinate(source.y);
  const sanitized = {
    width,
    height,
    isMaximized: Boolean(source.isMaximized),
  };

  if (x !== undefined) {
    sanitized.x = x;
  }
  if (y !== undefined) {
    sanitized.y = y;
  }

  return sanitized;
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function windowStatePath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function startupLogPath() {
  return path.join(app.getPath("userData"), STARTUP_LOG_FILE);
}

async function appendStartupLog(message) {
  if (!STARTUP_LOG_ENABLED) {
    return;
  }
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    const filePath = startupLogPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, line, "utf8");
  } catch {
    // Ignore logging failures; diagnostics should not impact runtime behavior.
  }
}

async function loadConfig() {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    return sanitizeConfig(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to read settings.json:", error);
    }
    return clone(DEFAULT_CONFIG);
  }
}

async function saveConfig(nextConfig) {
  const sanitized = sanitizeConfig(nextConfig);
  const filePath = settingsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(sanitized, null, 2), "utf8");
  return sanitized;
}

async function loadWindowState(minimumContentSize) {
  try {
    const raw = await fs.readFile(windowStatePath(), "utf8");
    return sanitizeWindowState(JSON.parse(raw), minimumContentSize);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to read window-state.json:", error);
    }
    return sanitizeWindowState({}, minimumContentSize);
  }
}

async function saveWindowState(nextState) {
  const sanitized = sanitizeWindowState(
    nextState,
    computeMinimumContentSize(currentConfig),
  );
  const filePath = windowStatePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(sanitized, null, 2), "utf8");
  return sanitized;
}

function isRectVisibleOnAnyDisplay(rect) {
  for (const display of screen.getAllDisplays()) {
    const area = display.workArea;
    const intersects =
      rect.x < area.x + area.width &&
      rect.x + rect.width > area.x &&
      rect.y < area.y + area.height &&
      rect.y + rect.height > area.y;
    if (intersects) {
      return true;
    }
  }
  return false;
}

function normalizeWindowStateForLaunch(rawState, minimumContentSize) {
  const sanitized = sanitizeWindowState(rawState, minimumContentSize);
  const displays = screen.getAllDisplays();
  if (!displays.length) {
    return sanitized;
  }

  const maxWorkWidth = Math.max(...displays.map((display) => display.workArea.width));
  const maxWorkHeight = Math.max(...displays.map((display) => display.workArea.height));
  const widthUpperBound = Math.max(maxWorkWidth, minimumContentSize.width);
  const heightUpperBound = Math.max(maxWorkHeight, minimumContentSize.height);
  const isExtremeSize =
    sanitized.width > maxWorkWidth * 1.5 ||
    sanitized.height > maxWorkHeight * 1.5;

  const normalized = { ...sanitized };
  if (isExtremeSize) {
    normalized.width = clampNumber(
      DEFAULT_WINDOW_SIZE.width,
      minimumContentSize.width,
      widthUpperBound,
      minimumContentSize.width,
    );
    normalized.height = clampNumber(
      DEFAULT_WINDOW_SIZE.height,
      minimumContentSize.height,
      heightUpperBound,
      minimumContentSize.height,
    );
    delete normalized.x;
    delete normalized.y;
    return normalized;
  }

  if (
    typeof normalized.x === "number" &&
    typeof normalized.y === "number" &&
    !isRectVisibleOnAnyDisplay(normalized)
  ) {
    delete normalized.x;
    delete normalized.y;
  }

  return normalized;
}

function readWindowStateFromWindow(targetWindow) {
  const isMaximized = targetWindow.isMaximized();
  const bounds = isMaximized
    ? targetWindow.getNormalBounds()
    : targetWindow.getBounds();

  return {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized,
  };
}

async function persistCurrentWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  await saveWindowState(readWindowStateFromWindow(mainWindow));
}

function scheduleWindowStateSave() {
  clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    void persistCurrentWindowState();
  }, WINDOW_STATE_DEBOUNCE_MS);
}

async function createMainWindow(config) {
  const minimumContentSize = computeMinimumContentSize(config);
  const rawWindowState = await loadWindowState(minimumContentSize);
  const restoredWindowState = normalizeWindowStateForLaunch(
    rawWindowState,
    minimumContentSize,
  );
  const windowOptions = {
    width: restoredWindowState.width,
    height: restoredWindowState.height,
    useContentSize: true,
    minWidth: minimumContentSize.width,
    minHeight: minimumContentSize.height,
    autoHideMenuBar: true,
    alwaysOnTop: Boolean(config.alwaysOnTop),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  if (
    typeof restoredWindowState.x === "number" &&
    typeof restoredWindowState.y === "number"
  ) {
    windowOptions.x = restoredWindowState.x;
    windowOptions.y = restoredWindowState.y;
  } else {
    windowOptions.center = true;
  }

  mainWindow = new BrowserWindow(windowOptions);
  void appendStartupLog(
    `window created width=${windowOptions.width} height=${windowOptions.height} x=${windowOptions.x ?? "auto"} y=${windowOptions.y ?? "auto"} maximized=${restoredWindowState.isMaximized}`,
  );

  if (STARTUP_LOG_ENABLED) {
    mainWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        void appendStartupLog(
          `did-fail-load code=${errorCode} mainFrame=${Boolean(isMainFrame)} url=${validatedURL} desc=${errorDescription}`,
        );
      },
    );
    mainWindow.webContents.on(
      "console-message",
      (_event, level, message, line, sourceId) => {
        const trimmedMessage = String(message).slice(0, 400);
        void appendStartupLog(
          `console level=${level} source=${sourceId}:${line} message=${trimmedMessage}`,
        );
      },
    );
  }

  mainWindow.on("move", scheduleWindowStateSave);
  mainWindow.on("resize", scheduleWindowStateSave);
  mainWindow.on("maximize", scheduleWindowStateSave);
  mainWindow.on("unmaximize", scheduleWindowStateSave);
  mainWindow.on("close", () => {
    clearTimeout(windowStateSaveTimer);
    void persistCurrentWindowState();
  });

  mainWindow.on("closed", () => {
    clearTimeout(windowStateSaveTimer);
    mainWindow = null;
  });

  await mainWindow.loadFile(path.join(__dirname, "index.html"));
  if (restoredWindowState.isMaximized) {
    mainWindow.maximize();
  }
}

function registerIpcHandlers() {
  ipcMain.handle("config:get", async () => clone(currentConfig));

  ipcMain.handle("config:set", async (_event, payload) => {
    currentConfig = await saveConfig(payload);
    if (mainWindow && !mainWindow.isDestroyed()) {
      const minimumContentSize = computeMinimumContentSize(currentConfig);
      mainWindow.setMinimumSize(minimumContentSize.width, minimumContentSize.height);
      if (!mainWindow.isMaximized()) {
        const [contentWidth, contentHeight] = mainWindow.getContentSize();
        const nextWidth = Math.max(contentWidth, minimumContentSize.width);
        const nextHeight = Math.max(contentHeight, minimumContentSize.height);
        if (nextWidth !== contentWidth || nextHeight !== contentHeight) {
          mainWindow.setContentSize(nextWidth, nextHeight);
        }
      }
      mainWindow.setAlwaysOnTop(Boolean(currentConfig.alwaysOnTop));
      scheduleWindowStateSave();
    }
    return { ok: true };
  });

  ipcMain.handle("window:setAlwaysOnTop", async (_event, payload) => {
    const alwaysOnTop = Boolean(payload);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(alwaysOnTop);
    }
    currentConfig = await saveConfig({
      ...currentConfig,
      alwaysOnTop,
    });
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  void appendStartupLog(`app ready version=${app.getVersion()}`);

  currentConfig = await loadConfig();
  registerIpcHandlers();
  await createMainWindow(currentConfig);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      currentConfig = await loadConfig();
      await createMainWindow(currentConfig);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
