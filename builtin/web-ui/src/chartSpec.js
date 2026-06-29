const ALLOWED_RENDERERS = new Set(["echarts"]);
const ALLOWED_SERIES_TYPES = new Set([
  "line",
  "bar",
  "pie",
  "scatter",
  "radar",
  "heatmap",
  "tree",
  "treemap",
  "sunburst",
  "sankey",
  "graph",
  "gauge",
  "funnel",
]);
const DISALLOWED_EVENT_KEYS = new Set([
  "onclick",
  "ondblclick",
  "onmousedown",
  "onmouseup",
  "onmouseover",
  "onmouseout",
  "onmousemove",
  "onmouseenter",
  "onmouseleave",
  "oncontextmenu",
  "onkeydown",
  "onkeyup",
  "onkeypress",
  "onload",
  "onerror",
]);
const CHART_COLORS = [
  "#7c9cff",
  "#a8e66f",
  "#ffcf5c",
  "#68d8d6",
  "#ff8fb3",
  "#b79cff",
  "#f59e73",
  "#8bd17c",
];

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeDefaults(value, defaults) {
  if (!isPlainObject(value)) return { ...defaults };
  const next = { ...value };
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (next[key] == null) {
      next[key] = defaultValue;
    } else if (isPlainObject(next[key]) && isPlainObject(defaultValue)) {
      next[key] = mergeDefaults(next[key], defaultValue);
    }
  }
  return next;
}

function normalizeComponent(value, defaults) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((item) => (isPlainObject(item) ? mergeDefaults(item, defaults) : item));
  return isPlainObject(value) ? mergeDefaults(value, defaults) : value;
}

function stripJsonFences(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  const fenced = text.match(/```(?:json|chart|echarts)?\s*\n?([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();
  else {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) text = text.slice(first, last + 1).trim();
  }
  return text.replace(/^json\s*\n/i, "").trim();
}

function rejectUnsafeStrings(value, path = "$") {
  if (value == null) return;
  if (typeof value === "string") {
    if (/<\s*(script|iframe|object|embed|link|meta)\b/i.test(value)) {
      throw new Error(`${path} contains unsafe HTML`);
    }
    if (/\bjavascript\s*:/i.test(value) || /\bdata\s*:\s*text\/html/i.test(value)) {
      throw new Error(`${path} contains unsafe URL text`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUnsafeStrings(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/^on[A-Z]/.test(key) || DISALLOWED_EVENT_KEYS.has(key.toLowerCase())) {
        throw new Error(`${path}.${key} is not allowed`);
      }
      rejectUnsafeStrings(item, `${path}.${key}`);
    }
  }
}

function normalizeSeries(series) {
  const list = Array.isArray(series) ? series : [series].filter(Boolean);
  if (!list.length) throw new Error("option.series is required");
  for (const item of list) {
    const type = String(item?.type || "").trim();
    if (!ALLOWED_SERIES_TYPES.has(type)) {
      throw new Error(`series.type "${type || "(empty)"}" is not allowed`);
    }
  }
  return list;
}

function normalizeTooltip(tooltip) {
  const defaults = {
    trigger: "item",
    renderMode: "richText",
    backgroundColor: "rgba(20, 22, 28, 0.96)",
    borderColor: "rgba(124, 156, 255, 0.28)",
    textStyle: { color: "rgba(255, 255, 255, 0.92)" },
  };
  if (!tooltip || typeof tooltip !== "object" || Array.isArray(tooltip)) return defaults;
  return mergeDefaults(tooltip, defaults);
}

function normalizeTitle(title, specTitle) {
  const defaults = {
    left: "center",
    top: 12,
    textStyle: {
      color: "rgba(255, 255, 255, 0.9)",
      fontSize: 15,
      fontWeight: 700,
    },
    subtextStyle: { color: "rgba(255, 255, 255, 0.52)" },
  };
  if (Array.isArray(title)) {
    return title.map((item, index) => {
      if (!isPlainObject(item)) return item;
      const base = index === 0 && specTitle && item.text == null ? { ...item, text: specTitle } : item;
      return mergeDefaults(base, defaults);
    });
  }
  if (isPlainObject(title)) {
    return mergeDefaults(specTitle && title.text == null ? { ...title, text: specTitle } : title, defaults);
  }
  return specTitle ? { ...defaults, text: specTitle } : title;
}

function normalizeLegend(legend, hasTitle) {
  const defaults = {
    top: hasTitle ? 42 : 14,
    textStyle: { color: "rgba(255, 255, 255, 0.72)" },
    itemGap: 14,
  };
  if (legend == null) return legend;
  return normalizeComponent(legend, defaults);
}

function normalizeAxis(axis, axisNameColor = "rgba(255, 255, 255, 0.62)") {
  const defaults = {
    nameTextStyle: { color: axisNameColor },
    axisLabel: { color: "rgba(255, 255, 255, 0.58)" },
    axisLine: { lineStyle: { color: "rgba(255, 255, 255, 0.22)" } },
    axisTick: { lineStyle: { color: "rgba(255, 255, 255, 0.18)" } },
    splitLine: { lineStyle: { color: "rgba(255, 255, 255, 0.12)" } },
  };
  return normalizeComponent(axis, defaults);
}

function normalizeGrid(grid, hasTitleOrLegend) {
  const defaults = {
    left: 52,
    right: 42,
    top: hasTitleOrLegend ? 78 : 42,
    bottom: 42,
    containLabel: true,
  };
  if (grid == null) return defaults;
  return normalizeComponent(grid, defaults);
}

function normalizeRadar(radar) {
  const defaults = {
    axisName: { color: "rgba(255, 255, 255, 0.68)" },
    splitLine: { lineStyle: { color: "rgba(255, 255, 255, 0.12)" } },
    splitArea: {
      areaStyle: {
        color: ["rgba(255, 255, 255, 0.025)", "rgba(255, 255, 255, 0.045)"],
      },
    },
    axisLine: { lineStyle: { color: "rgba(255, 255, 255, 0.16)" } },
  };
  if (radar == null) return radar;
  return normalizeComponent(radar, defaults);
}

function normalizeOption(option, series, specTitle) {
  const title = normalizeTitle(option.title, specTitle);
  const hasTitle = Boolean((Array.isArray(title) ? title : [title]).filter(Boolean).some((item) => isPlainObject(item) && item.text));
  const hasLegend = option.legend != null && option.legend !== false;
  return {
    ...option,
    backgroundColor: option.backgroundColor ?? "transparent",
    color: option.color ?? CHART_COLORS,
    textStyle: mergeDefaults(option.textStyle, { color: "rgba(255, 255, 255, 0.78)" }),
    title,
    tooltip: normalizeTooltip(option.tooltip),
    legend: normalizeLegend(option.legend, hasTitle),
    grid: option.xAxis != null || option.yAxis != null ? normalizeGrid(option.grid, hasTitle || hasLegend) : option.grid,
    xAxis: normalizeAxis(option.xAxis),
    yAxis: normalizeAxis(option.yAxis),
    radar: normalizeRadar(option.radar),
    series,
  };
}

export function parseChartSpec(content) {
  const text = stripJsonFences(content);
  if (!text) return { ok: false, error: "No chart content" };
  try {
    const spec = JSON.parse(text);
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error("ChartSpec must be a JSON object");
    }
    if (spec.type !== "chart") throw new Error('type must be "chart"');
    if (spec.version !== "1.0") throw new Error('version must be "1.0"');
    if (!ALLOWED_RENDERERS.has(spec.renderer)) throw new Error('renderer must be "echarts"');
    if (!spec.option || typeof spec.option !== "object" || Array.isArray(spec.option)) {
      throw new Error("option must be an ECharts option object");
    }
    rejectUnsafeStrings(spec);
    const series = normalizeSeries(spec.option.series);
    const title = spec.title == null ? "" : String(spec.title);
    const option = normalizeOption(spec.option, series, title);
    return { ok: true, spec: { ...spec, title, option } };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
