/**
 * Node UI Kit v1.
 *
 * 节点包来自 Marketplace，UI 声明必须和节点声明一样是纯数据。这里把可接受的卡片组件收敛成
 * 白名单，避免节点包把任意 HTML / React / 事件处理器带进 Workspace。
 */

const CARD_TEMPLATES = new Set(["details", "state-machine"]);
const TONES = new Set(["neutral", "blue", "purple", "green", "amber", "red"]);
const SECTION_TYPES = new Set(["binding", "code", "decision", "metrics", "summary", "history", "subflow", "loop"]);
const CODE_FIELDS = new Set(["script", "scriptRef", "body", "implementationRef"]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function shortText(value, max = 160) {
  return String(value ?? "").trim().slice(0, max);
}

function token(value, max = 80) {
  const text = shortText(value, max);
  return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(text) ? text : "";
}

function tone(value, fallback = "neutral") {
  const valueText = shortText(value, 20).toLowerCase();
  return TONES.has(valueText) ? valueText : fallback;
}

function normalizeDecisionOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((raw) => {
    const item = object(raw);
    const optionValue = token(item?.value, 40);
    if (!item || !optionValue) return null;
    return {
      value: optionValue,
      label: shortText(item.label || optionValue, 60),
      tone: tone(item.tone),
      ...(item.description != null ? { description: shortText(item.description, 180) } : {}),
    };
  }).filter(Boolean);
}

function normalizeMetricItems(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map((raw) => {
    const item = object(raw);
    if (!item) return null;
    const input = token(item.input);
    const output = token(item.output);
    if (!input && !output) return null;
    const maxInput = token(item.maxInput);
    return {
      label: shortText(item.label || output || input, 60),
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
      ...(maxInput ? { maxInput } : {}),
      ...(item.suffix != null ? { suffix: shortText(item.suffix, 24) } : {}),
    };
  }).filter(Boolean);
}

function normalizeSection(raw) {
  const item = object(raw);
  const type = shortText(item?.type, 30).toLowerCase();
  if (!item || !SECTION_TYPES.has(type)) return null;
  const label = shortText(item.label || type, 60);
  if (type === "subflow") return { type, label };
  if (type === "loop") {
    const field = shortText(item.field || "script", 40);
    return CODE_FIELDS.has(field) ? { type, label, field } : null;
  }
  if (type === "binding") {
    const input = token(item.input);
    return input ? { type, label, input } : null;
  }
  if (type === "code") {
    const field = shortText(item.field, 40);
    return CODE_FIELDS.has(field) ? { type, label, field } : null;
  }
  if (type === "decision") {
    const output = token(item.output);
    if (!output) return null;
    return {
      type,
      label,
      output,
      ...(item.source != null ? { source: shortText(item.source, 120) } : {}),
      options: normalizeDecisionOptions(item.options),
    };
  }
  if (type === "metrics") {
    const items = normalizeMetricItems(item.items);
    return items.length ? { type, label, items } : null;
  }
  if (type === "summary" || type === "history") {
    const output = token(item.output);
    if (!output) return null;
    return {
      type,
      label,
      output,
      ...(type === "history" ? { limit: Math.min(8, Math.max(1, Number(item.limit) || 3)) } : {}),
    };
  }
  return null;
}

export function normalizeNodeUi(value) {
  const root = object(value);
  const rawCard = object(root?.card);
  if (!root || !rawCard) return undefined;
  const templateText = shortText(rawCard.template, 40).toLowerCase();
  const template = CARD_TEMPLATES.has(templateText) ? templateText : "details";
  const icon = token(rawCard.icon, 48);
  const sections = (Array.isArray(rawCard.sections) ? rawCard.sections : [])
    .slice(0, 12)
    .map(normalizeSection)
    .filter(Boolean);
  if (!icon && sections.length === 0) return undefined;
  return {
    version: 1,
    card: {
      template,
      tone: tone(rawCard.tone),
      ...(icon ? { icon } : {}),
      sections,
    },
  };
}

export function normalizeNodeUiForSlots(value, inputs = [], outputs = []) {
  const ui = normalizeNodeUi(value);
  if (!ui) return undefined;
  const inputNames = new Set((Array.isArray(inputs) ? inputs : []).map((slot) => String(slot?.name || "")));
  const outputNames = new Set((Array.isArray(outputs) ? outputs : []).map((slot) => String(slot?.name || "")));
  const sections = ui.card.sections.map((section) => {
    if (section.type === "binding") return inputNames.has(section.input) ? section : null;
    if (section.type === "decision" || section.type === "summary" || section.type === "history") {
      return outputNames.has(section.output) ? section : null;
    }
    if (section.type === "metrics") {
      const items = section.items.filter((item) => (
        (!item.input || inputNames.has(item.input))
        && (!item.output || outputNames.has(item.output))
        && (!item.maxInput || inputNames.has(item.maxInput))
      ));
      return items.length ? { ...section, items } : null;
    }
    return section;
  }).filter(Boolean);
  if (!ui.card.icon && sections.length === 0) return undefined;
  return { ...ui, card: { ...ui.card, sections } };
}
