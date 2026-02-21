const HARD_TILE_LIMIT = 12;
const DEFAULT_TILE_COUNT = 5;
const CHART_WIDTH_RANGE = { min: 160, max: 800 };
const CHART_HEIGHT_RANGE = { min: 120, max: 600 };
const TV_WIDGET_TAG_NAME = "tv-mini-chart";
const TV_WIDGET_SCRIPT_URL =
  "https://widgets.tradingview-widget.com/w/en/tv-mini-chart.js";
const TV_WIDGET_LOAD_TIMEOUT_MS = 8000;
const FALLBACK_SYMBOL = "TVC:GOLD";
const ALLOWED_THEMES = new Set(["light", "dark"]);
const ALLOWED_LINE_CHART_TYPES = new Set(["Baseline", "Line", "Area"]);

const fallbackBridge = {
  getDefaults: async () => ({ defaultSymbols: [] }),
  getConfig: async () => createDefaultConfig(),
  setConfig: async () => ({ ok: true }),
  setAlwaysOnTop: async () => ({ ok: true }),
};

const bridge = window.appApi || fallbackBridge;
let defaultSymbols = [];

const elements = {
  chartsContainer: document.getElementById("chartsContainer"),
  settingsToggle: document.getElementById("settingsToggle"),
  clockJst: document.getElementById("clockJst"),
  settingsPanel: document.getElementById("settingsPanel"),
  closeSettings: document.getElementById("closeSettings"),
  themeSelect: document.getElementById("themeSelect"),
  chartWidthInput: document.getElementById("chartWidthInput"),
  chartHeightInput: document.getElementById("chartHeightInput"),
  tileCountInput: document.getElementById("tileCountInput"),
  alwaysOnTopToggle: document.getElementById("alwaysOnTopToggle"),
  tilesEditor: document.getElementById("tilesEditor"),
  status: document.getElementById("status"),
};

let config = createDefaultConfig();
let saveTimer = null;
let statusTimer = null;
let jstClockIntervalId = null;
let jstClockTimeoutId = null;
let tvWidgetLoadPromise = null;
let tvWidgetLoadState = "idle";
let tvWidgetLoadError = "";
const jstTimeFormatter = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Tokyo",
});

function createDefaultConfig() {
  return {
    theme: "dark",
    alwaysOnTop: false,
    maxTiles: DEFAULT_TILE_COUNT,
    chartWidth: 320,
    chartHeight: 250,
    tiles: createDefaultTiles(DEFAULT_TILE_COUNT),
  };
}

function sanitizeDefaultSymbols(value) {
  const source = Array.isArray(value?.defaultSymbols) ? value.defaultSymbols : [];
  return source
    .map((item) => (typeof item === "string" ? item.trim().toUpperCase() : ""))
    .filter((item) => item.length > 0);
}

function fallbackSymbol(index) {
  if (defaultSymbols.length === 0) {
    return FALLBACK_SYMBOL;
  }
  return defaultSymbols[index % defaultSymbols.length];
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

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
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
    rawConfig && typeof rawConfig === "object" ? rawConfig : createDefaultConfig();
  const tileCount = clampNumber(
    source.maxTiles,
    1,
    HARD_TILE_LIMIT,
    DEFAULT_TILE_COUNT,
  );
  const sourceTiles = Array.isArray(source.tiles) ? source.tiles : [];
  const tiles = [];
  const chartWidth = clampNumber(
    source.chartWidth,
    CHART_WIDTH_RANGE.min,
    CHART_WIDTH_RANGE.max,
    320,
  );
  const chartHeight = clampNumber(
    source.chartHeight,
    CHART_HEIGHT_RANGE.min,
    CHART_HEIGHT_RANGE.max,
    250,
  );
  for (let index = 0; index < tileCount; index += 1) {
    const fallback = fallbackSymbol(index);
    const tile = sourceTiles[index] || {};
    tiles.push({
      id: sanitizeId(tile.id, `tile-${index + 1}`),
      symbol: sanitizeSymbol(tile.symbol, fallback),
      lineChartType: sanitizeLineChartType(tile.lineChartType),
    });
  }

  return {
    theme: ALLOWED_THEMES.has(source.theme) ? source.theme : "dark",
    alwaysOnTop: Boolean(source.alwaysOnTop),
    maxTiles: tileCount,
    chartWidth,
    chartHeight,
    tiles,
  };
}

function showStatus(message, isError = false, durationMs = 2400) {
  if (!elements.status) {
    return;
  }
  clearTimeout(statusTimer);

  if (!message) {
    elements.status.textContent = "";
    elements.status.classList.remove("visible", "error");
    return;
  }

  elements.status.textContent = message;
  elements.status.classList.add("visible");
  elements.status.classList.toggle("error", isError);

  statusTimer = setTimeout(() => {
    elements.status.classList.remove("visible", "error");
  }, durationMs);
}

function renderJstClock() {
  if (!elements.clockJst) {
    return;
  }
  elements.clockJst.textContent = `${jstTimeFormatter.format(new Date())} JST`;
}

function stopJstClock() {
  if (jstClockTimeoutId !== null) {
    clearTimeout(jstClockTimeoutId);
    jstClockTimeoutId = null;
  }
  if (jstClockIntervalId !== null) {
    clearInterval(jstClockIntervalId);
    jstClockIntervalId = null;
  }
}

function startJstClock() {
  stopJstClock();
  renderJstClock();

  const now = new Date();
  const msUntilNextMinute =
    60000 - (now.getSeconds() * 1000 + now.getMilliseconds());

  jstClockTimeoutId = setTimeout(() => {
    renderJstClock();
    jstClockIntervalId = setInterval(renderJstClock, 60000);
    jstClockTimeoutId = null;
  }, msUntilNextMinute);
}

function setPanelOpen(isOpen) {
  if (!elements.settingsPanel) {
    return;
  }
  elements.settingsPanel.classList.toggle("open", isOpen);
  elements.settingsPanel.setAttribute("aria-hidden", String(!isOpen));
}

function applyTheme() {
  document.body.dataset.theme = config.theme;
  document.documentElement.style.colorScheme = config.theme;
}

function applyChartSizeVariables() {
  document.documentElement.style.setProperty("--mini-card-width", `${config.chartWidth}px`);
  document.documentElement.style.setProperty("--mini-card-height", `${config.chartHeight}px`);
}

function isTvWidgetReady() {
  return Boolean(customElements.get(TV_WIDGET_TAG_NAME));
}

function widgetFallbackMessage() {
  if (tvWidgetLoadState === "failed") {
    return "Chart widget failed to load.";
  }
  if (tvWidgetLoadState === "loading") {
    return "Loading chart widget...";
  }
  return "Preparing chart widget...";
}

function buildWidgetFallback() {
  const fallback = document.createElement("div");
  fallback.className = "chart-widget-status";
  fallback.textContent = widgetFallbackMessage();
  if (tvWidgetLoadState === "failed" && tvWidgetLoadError) {
    fallback.title = tvWidgetLoadError;
  }
  return fallback;
}

function buildChartElement(tile) {
  const host = document.createElement("div");
  host.className = "chart-host";

  if (!isTvWidgetReady()) {
    host.appendChild(buildWidgetFallback());
    return host;
  }

  const miniChart = document.createElement(TV_WIDGET_TAG_NAME);
  miniChart.setAttribute("symbol", tile.symbol);
  miniChart.setAttribute("line-chart-type", tile.lineChartType);
  miniChart.setAttribute("theme", config.theme);
  miniChart.setAttribute("autosize", "true");
  host.appendChild(miniChart);

  return host;
}

function renderCharts() {
  elements.chartsContainer.replaceChildren();

  if (!config.tiles.length) {
    const placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    placeholder.textContent = "No charts configured.";
    elements.chartsContainer.appendChild(placeholder);
    return;
  }

  config.tiles.forEach((tile) => {
    const tileContainer = document.createElement("section");
    tileContainer.className = "chart-tile";
    tileContainer.appendChild(buildChartElement(tile));
    elements.chartsContainer.appendChild(tileContainer);
  });
}

function buildTileEditor() {
  elements.tilesEditor.replaceChildren();

  config.tiles.forEach((tile, index) => {
    const row = document.createElement("div");
    row.className = "tile-row";

    const title = document.createElement("div");
    title.className = "tile-row-title";
    title.textContent = `Chart ${index + 1}`;
    row.appendChild(title);

    const symbolInput = document.createElement("input");
    symbolInput.type = "text";
    symbolInput.value = tile.symbol;
    symbolInput.placeholder = "EXCHANGE:SYMBOL";
    symbolInput.addEventListener("change", () => {
      config.tiles[index].symbol = sanitizeSymbol(
        symbolInput.value,
        fallbackSymbol(index),
      );
      symbolInput.value = config.tiles[index].symbol;
      renderCharts();
      scheduleConfigSave();
    });
    row.appendChild(symbolInput);

    const lineTypeSelect = document.createElement("select");
    for (const type of ALLOWED_LINE_CHART_TYPES) {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      lineTypeSelect.appendChild(option);
    }
    lineTypeSelect.value = tile.lineChartType;
    lineTypeSelect.addEventListener("change", () => {
      config.tiles[index].lineChartType = sanitizeLineChartType(
        lineTypeSelect.value,
      );
      renderCharts();
      scheduleConfigSave();
    });
    row.appendChild(lineTypeSelect);

    elements.tilesEditor.appendChild(row);
  });
}

function syncControlsFromConfig() {
  elements.themeSelect.value = config.theme;
  elements.chartWidthInput.value = String(config.chartWidth);
  elements.chartHeightInput.value = String(config.chartHeight);
  elements.tileCountInput.value = String(config.maxTiles);
  elements.alwaysOnTopToggle.checked = Boolean(config.alwaysOnTop);
}

async function persistConfig() {
  const sanitized = sanitizeConfig(config);
  config = sanitized;
  await bridge.setConfig(sanitized);
}

function scheduleConfigSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await persistConfig();
    } catch (error) {
      console.error(error);
      showStatus("Could not save settings.", true);
    }
  }, 250);
}

function updateTileCount(count) {
  const safeCount = clampNumber(
    count,
    1,
    HARD_TILE_LIMIT,
    config.maxTiles || DEFAULT_TILE_COUNT,
  );
  config.maxTiles = safeCount;

  const nextTiles = [];
  for (let index = 0; index < safeCount; index += 1) {
    const sourceTile = config.tiles[index] || {};
    nextTiles.push({
      id: sanitizeId(sourceTile.id, `tile-${index + 1}`),
      symbol: sanitizeSymbol(sourceTile.symbol, fallbackSymbol(index)),
      lineChartType: sanitizeLineChartType(sourceTile.lineChartType),
    });
  }

  config.tiles = nextTiles;
  buildTileEditor();
  renderCharts();
  scheduleConfigSave();
}

function bindEvents() {
  elements.settingsToggle.addEventListener("click", () => {
    const open = !elements.settingsPanel.classList.contains("open");
    setPanelOpen(open);
  });

  elements.closeSettings.addEventListener("click", () => {
    setPanelOpen(false);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setPanelOpen(false);
    }
  });

  elements.themeSelect.addEventListener("change", () => {
    config.theme = ALLOWED_THEMES.has(elements.themeSelect.value)
      ? elements.themeSelect.value
      : "dark";
    applyTheme();
    renderCharts();
    scheduleConfigSave();
  });

  elements.chartWidthInput.addEventListener("change", () => {
    config.chartWidth = clampNumber(
      elements.chartWidthInput.value,
      CHART_WIDTH_RANGE.min,
      CHART_WIDTH_RANGE.max,
      config.chartWidth,
    );
    elements.chartWidthInput.value = String(config.chartWidth);
    applyChartSizeVariables();
    renderCharts();
    scheduleConfigSave();
  });

  elements.chartHeightInput.addEventListener("change", () => {
    config.chartHeight = clampNumber(
      elements.chartHeightInput.value,
      CHART_HEIGHT_RANGE.min,
      CHART_HEIGHT_RANGE.max,
      config.chartHeight,
    );
    elements.chartHeightInput.value = String(config.chartHeight);
    applyChartSizeVariables();
    renderCharts();
    scheduleConfigSave();
  });

  elements.tileCountInput.addEventListener("change", () => {
    updateTileCount(elements.tileCountInput.value);
  });

  elements.alwaysOnTopToggle.addEventListener("change", async () => {
    const nextValue = elements.alwaysOnTopToggle.checked;
    const previousValue = config.alwaysOnTop;
    config.alwaysOnTop = nextValue;

    try {
      await bridge.setAlwaysOnTop(nextValue);
      await persistConfig();
      showStatus(`Always on top: ${nextValue ? "ON" : "OFF"}.`);
    } catch (error) {
      console.error(error);
      config.alwaysOnTop = previousValue;
      elements.alwaysOnTopToggle.checked = previousValue;
      showStatus("Could not update always on top.", true);
    }
  });
}

function waitForTvWidgetDefinition(timeoutMs) {
  if (isTvWidgetReady()) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error("TradingView widget load timed out."));
    }, timeoutMs);

    customElements
      .whenDefined(TV_WIDGET_TAG_NAME)
      .then(() => {
        clearTimeout(timeoutId);
        resolve();
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function loadTradingViewWidgetScript() {
  if (isTvWidgetReady()) {
    tvWidgetLoadState = "ready";
    return Promise.resolve();
  }

  if (tvWidgetLoadPromise) {
    return tvWidgetLoadPromise;
  }

  tvWidgetLoadState = "loading";
  tvWidgetLoadError = "";
  renderCharts();

  tvWidgetLoadPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector("script[data-tv-mini-chart='1']");
    if (existingScript) {
      waitForTvWidgetDefinition(TV_WIDGET_LOAD_TIMEOUT_MS)
        .then(resolve)
        .catch(reject);
      return;
    }

    const script = document.createElement("script");
    script.type = "module";
    script.async = true;
    script.src = TV_WIDGET_SCRIPT_URL;
    script.dataset.tvMiniChart = "1";
    script.addEventListener("load", () => {
      waitForTvWidgetDefinition(TV_WIDGET_LOAD_TIMEOUT_MS)
        .then(resolve)
        .catch(reject);
    });
    script.addEventListener("error", () => {
      reject(new Error("TradingView widget script request failed."));
    });
    document.head.appendChild(script);
  })
    .then(() => {
      tvWidgetLoadState = "ready";
      tvWidgetLoadError = "";
      tvWidgetLoadPromise = null;
      renderCharts();
      showStatus("", false);
    })
    .catch((error) => {
      tvWidgetLoadState = "failed";
      tvWidgetLoadError = error?.message || "TradingView widget load failed.";
      tvWidgetLoadPromise = null;
      renderCharts();
      showStatus("TradingView widget failed to load.", true, 7000);
      console.error(error);
    });

  return tvWidgetLoadPromise;
}

async function bootstrap() {
  bindEvents();

  try {
    defaultSymbols = sanitizeDefaultSymbols(await bridge.getDefaults());
  } catch (error) {
    console.error(error);
    defaultSymbols = [];
  }

  try {
    const loadedConfig = await bridge.getConfig();
    config = sanitizeConfig(loadedConfig);
  } catch (error) {
    console.error(error);
    config = createDefaultConfig();
    showStatus("Using default settings due to load error.", true);
  }

  applyTheme();
  startJstClock();
  applyChartSizeVariables();
  syncControlsFromConfig();
  buildTileEditor();
  renderCharts();

  try {
    await bridge.setAlwaysOnTop(config.alwaysOnTop);
  } catch (error) {
    console.error(error);
    showStatus("Could not sync always on top on startup.", true);
  }

  void loadTradingViewWidgetScript();
}

bootstrap();
