import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { parseChartSpec } from "./chartSpec.js";

function splitMarkdownTableRow(line) {
  let text = String(line || "").trim();
  if (!text.includes("|")) return [];
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function markdownTableAlignments(separatorLine) {
  return splitMarkdownTableRow(separatorLine).map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

function isMermaidStart(line) {
  return /^\s*(sequenceDiagram|flowchart\s+(?:TD|TB|BT|LR|RL)|graph\s+(?:TD|TB|BT|LR|RL))\b/i.test(String(line || ""));
}

function parseMermaidFlowchart(code) {
  const lines = String(code || "").split(/\r?\n/).map((line) => line.replace(/%%.*$/, "").trim()).filter(Boolean);
  const nodes = new Map();
  const edges = [];
  let direction = "TD";
  const ensure = (id, label = "") => {
    const clean = String(id || "").replace(/[^A-Za-z0-9_]/g, "_") || `N${nodes.size + 1}`;
    if (!nodes.has(clean)) nodes.set(clean, { id: clean, label: label || clean });
    else if (label) nodes.get(clean).label = label;
    return clean;
  };
  const parseEndpoint = (raw) => {
    const text = String(raw || "").trim().replace(/[;,]+$/, "");
    const match = text.match(/^([A-Za-z][A-Za-z0-9_]*)(?:\[(.+?)\]|\((.+?)\)|\{(.+?)\})?$/);
    if (!match) return ensure(text.replace(/[^A-Za-z0-9_]/g, "_"), text);
    return ensure(match[1], match[2] || match[3] || match[4] || match[1]);
  };
  for (const line of lines) {
    const dir = line.match(/^(graph|flowchart)\s+(TD|TB|BT|LR|RL)\b/i);
    if (dir) {
      direction = dir[2].toUpperCase();
      continue;
    }
    const edge = line.match(/^(.+?)\s*-{1,2}>+\s*(.+)$/);
    if (edge) {
      edges.push({ from: parseEndpoint(edge[1]), to: parseEndpoint(edge[2]) });
      continue;
    }
    parseEndpoint(line);
  }
  return { nodes: Array.from(nodes.values()), edges, direction };
}

function MermaidFlowchartPreview({ code }) {
  const graph = useMemo(() => parseMermaidFlowchart(code), [code]);
  const horizontal = graph.direction === "LR" || graph.direction === "RL";
  const nodeW = 150;
  const nodeH = 46;
  const gapX = horizontal ? 102 : 38;
  const gapY = horizontal ? 34 : 72;
  const positions = new Map();
  graph.nodes.forEach((node, idx) => {
    positions.set(node.id, {
      x: 28 + (horizontal ? idx * (nodeW + gapX) : (idx % 3) * (nodeW + gapX)),
      y: 28 + (horizontal ? (idx % 3) * (nodeH + gapY) : idx * (nodeH + gapY)),
    });
  });
  const maxX = Math.max(520, ...Array.from(positions.values()).map((p) => p.x + nodeW + 28));
  const maxY = Math.max(220, ...Array.from(positions.values()).map((p) => p.y + nodeH + 28));
  return (
    <svg viewBox={`0 0 ${maxX} ${maxY}`} role="img" aria-label="Mermaid flowchart preview">
      <defs>
        <marker id="af-md-mermaid-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      {graph.edges.map((edge, idx) => {
        const a = positions.get(edge.from);
        const b = positions.get(edge.to);
        if (!a || !b) return null;
        const d = horizontal
          ? `M ${a.x + nodeW} ${a.y + nodeH / 2} C ${(a.x + b.x + nodeW) / 2} ${a.y + nodeH / 2}, ${(a.x + b.x + nodeW) / 2} ${b.y + nodeH / 2}, ${b.x} ${b.y + nodeH / 2}`
          : `M ${a.x + nodeW / 2} ${a.y + nodeH} C ${a.x + nodeW / 2} ${a.y + nodeH + 28}, ${b.x + nodeW / 2} ${b.y - 28}, ${b.x + nodeW / 2} ${b.y}`;
        return <path key={`${edge.from}-${edge.to}-${idx}`} className="af-md-mermaid-edge" d={d} markerEnd="url(#af-md-mermaid-arrow)" />;
      })}
      {graph.nodes.map((node) => {
        const p = positions.get(node.id);
        return (
          <g key={node.id}>
            <rect className="af-md-mermaid-box" x={p.x} y={p.y} width={nodeW} height={nodeH} rx="8" />
            <text className="af-md-mermaid-text" x={p.x + nodeW / 2} y={p.y + nodeH / 2 + 5} textAnchor="middle">
              {node.label.slice(0, 24)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function parseMermaidSequence(code) {
  const lines = String(code || "").split(/\r?\n/).map((line) => line.replace(/%%.*$/, "").trim()).filter(Boolean);
  const participants = new Map();
  const rows = [];
  const ensureParticipant = (id, label = "") => {
    const clean = String(id || "").trim();
    if (!clean) return;
    if (!participants.has(clean)) participants.set(clean, label || clean);
  };
  for (const line of lines) {
    if (/^sequenceDiagram\b/i.test(line)) continue;
    const participant = line.match(/^(participant|actor)\s+([A-Za-z0-9_]+)(?:\s+as\s+(.+))?$/i);
    if (participant) {
      ensureParticipant(participant[2], participant[3] || participant[2]);
      continue;
    }
    const message = line.match(/^([A-Za-z0-9_]+)\s*[-=]+>>\+?\s*([A-Za-z0-9_]+)\s*:\s*(.+)$/);
    if (message) {
      ensureParticipant(message[1]);
      ensureParticipant(message[2]);
      rows.push({ type: "message", from: message[1], to: message[2], text: message[3] });
      continue;
    }
    const note = line.match(/^note\s+(?:over|right of|left of)\s+([^:]+):\s*(.+)$/i);
    rows.push({ type: "note", text: note ? note[2] : line });
  }
  return { participants: Array.from(participants, ([id, label]) => ({ id, label })), rows };
}

function MermaidSequencePreview({ code }) {
  const graph = useMemo(() => parseMermaidSequence(code), [code]);
  const participants = graph.participants.length ? graph.participants : [{ id: "A", label: "A" }, { id: "B", label: "B" }];
  const colW = 190;
  const left = 48;
  const top = 26;
  const headerH = 44;
  const rowH = 48;
  const width = Math.max(620, left * 2 + participants.length * colW);
  const height = Math.max(220, top + headerH + Math.max(1, graph.rows.length) * rowH + 34);
  const xFor = (id) => {
    const idx = Math.max(0, participants.findIndex((p) => p.id === id));
    return left + idx * colW + colW / 2;
  };
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Mermaid sequence diagram preview">
      <defs>
        <marker id="af-md-sequence-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      {participants.map((participant, idx) => {
        const x = left + idx * colW + colW / 2;
        return (
          <g key={participant.id}>
            <rect className="af-md-mermaid-box" x={x - 68} y={top} width="136" height="34" rx="8" />
            <text className="af-md-mermaid-text" x={x} y={top + 22} textAnchor="middle">{participant.label.slice(0, 18)}</text>
            <line className="af-md-sequence-life" x1={x} y1={top + headerH} x2={x} y2={height - 18} />
          </g>
        );
      })}
      {graph.rows.map((row, idx) => {
        const y = top + headerH + idx * rowH + 24;
        if (row.type !== "message") {
          return (
            <g key={`note-${idx}`}>
              <rect className="af-md-sequence-note" x={left} y={y - 17} width={width - left * 2} height="30" rx="7" />
              <text className="af-md-mermaid-text" x={left + 12} y={y + 4}>{row.text.slice(0, 120)}</text>
            </g>
          );
        }
        const fromX = xFor(row.from);
        const toX = xFor(row.to);
        const labelX = (fromX + toX) / 2;
        return (
          <g key={`msg-${idx}`}>
            <line className="af-md-mermaid-edge" x1={fromX} y1={y} x2={toX} y2={y} markerEnd="url(#af-md-sequence-arrow)" />
            <text className="af-md-sequence-label" x={labelX} y={y - 8} textAnchor="middle">{row.text.slice(0, 72)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function MermaidDisplayBlock({ code }) {
  const text = String(code || "").trim();
  if (!text) return null;
  const isSequence = /^sequenceDiagram\b/i.test(text);
  return (
    <div className="af-md-mermaid-preview">
      {isSequence ? <MermaidSequencePreview code={text} /> : <MermaidFlowchartPreview code={text} />}
    </div>
  );
}

function parseMarkdownDisplayBlocks(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let textLines = [];
  let inFence = false;
  const flushText = () => {
    if (!textLines.length) return;
    blocks.push({ type: "markdown", text: textLines.join("\n") });
    textLines = [];
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i] || "";
    const mermaidFence = line.match(/^\s*```\s*(mermaid|mmd)\s*$/i);
    if (!inFence && mermaidFence) {
      flushText();
      const mermaidLines = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] || "")) {
        mermaidLines.push(lines[i] || "");
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: "mermaid", text: mermaidLines.join("\n") });
      continue;
    }
    if (!inFence && isMermaidStart(line)) {
      flushText();
      const mermaidLines = [];
      while (i < lines.length) {
        const current = lines[i] || "";
        if (mermaidLines.length > 0 && (!current.trim() || /^-{3,}\s*$/.test(current) || /^#{1,6}\s+/.test(current))) break;
        mermaidLines.push(current);
        i++;
      }
      blocks.push({ type: "mermaid", text: mermaidLines.join("\n") });
      continue;
    }
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      textLines.push(line);
      i++;
      continue;
    }
    if (!inFence && i + 1 < lines.length && splitMarkdownTableRow(line).length > 1 && isMarkdownTableSeparator(lines[i + 1])) {
      flushText();
      const headers = splitMarkdownTableRow(line);
      const align = markdownTableAlignments(lines[i + 1]);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && splitMarkdownTableRow(lines[i]).length > 1) {
        rows.push(splitMarkdownTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers, align, rows });
      continue;
    }
    textLines.push(line);
    i++;
  }
  flushText();
  return blocks;
}

function normalizeMarkdownRelativePath(value, basePath = "") {
  const text = String(value || "").trim();
  if (!text || /^(?:https?:|data:|blob:|file:|javascript:|mailto:|tel:)/i.test(text) || text.startsWith("/") || text.startsWith("#")) return text;
  if (!basePath || text.startsWith("outputs/")) return text;
  const baseParts = String(basePath || "").split("/").filter(Boolean);
  baseParts.pop();
  const parts = [...baseParts, ...text.split("/")].filter(Boolean);
  const normalized = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (normalized.length === 0) return text;
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.join("/");
}

function markdownComponents(resolveSrc, inline = false, basePath = "") {
  const resolveLinkHref = (href) => {
    const text = String(href || "").trim();
    if (!text) return "";
    if (/^(?:https?:|data:|blob:|file:|javascript:|mailto:|tel:)/i.test(text) || text.startsWith("#")) return text;
    const resolvedPath = normalizeMarkdownRelativePath(text, basePath);
    return resolveSrc ? resolveSrc(resolvedPath, { kind: "link", download: true }) : resolvedPath;
  };
  return {
    ...(inline ? { p: ({ children: pChildren }) => <>{pChildren}</> } : {}),
    code: ({ inline: codeInline, className, children }) => {
      const language = String(className || "").match(/language-(\w+)/i)?.[1] || "";
      const text = String(children || "").replace(/\n$/, "");
      if (!codeInline && /^(mermaid|mmd)$/i.test(language)) {
        return <MermaidDisplayBlock code={text} />;
      }
      return codeInline ? <code className={className}>{children}</code> : <code className={className}>{children}</code>;
    },
    img: ({ src, alt }) => (
      <img src={resolveSrc ? resolveSrc(normalizeMarkdownRelativePath(src, basePath)) : src || ""} alt={alt || ""} loading="lazy" />
    ),
    a: ({ href, children }) => (
      <a href={resolveLinkHref(href)} target="_blank" rel="noopener noreferrer">{children}</a>
    ),
  };
}

function MarkdownInline({ children, resolveSrc, basePath = "" }) {
  return <ReactMarkdown components={markdownComponents(resolveSrc, true, basePath)}>{String(children || "")}</ReactMarkdown>;
}

export function MarkdownDisplayContent({ content, resolveSrc, basePath = "" }) {
  const blocks = useMemo(() => parseMarkdownDisplayBlocks(content), [content]);
  const components = useMemo(() => markdownComponents(resolveSrc, false, basePath), [basePath, resolveSrc]);
  return (
    <>
      {blocks.map((block, idx) => {
        if (block.type === "mermaid") {
          return <MermaidDisplayBlock key={`mermaid-${idx}`} code={block.text} />;
        }
        if (block.type !== "table") {
          return <ReactMarkdown key={`md-${idx}`} components={components}>{block.text}</ReactMarkdown>;
        }
        return (
          <div className="af-work-display-table-wrap" key={`table-${idx}`}>
            <table className="af-work-display-table">
              <thead>
                <tr>
                  {block.headers.map((cell, cellIdx) => (
                    <th key={cellIdx} style={{ textAlign: block.align[cellIdx] || "left" }}>
                      <MarkdownInline resolveSrc={resolveSrc} basePath={basePath}>{cell}</MarkdownInline>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIdx) => (
                  <tr key={rowIdx}>
                    {block.headers.map((_, cellIdx) => (
                      <td key={cellIdx} style={{ textAlign: block.align[cellIdx] || "left" }}>
                        <MarkdownInline resolveSrc={resolveSrc} basePath={basePath}>{row[cellIdx] || ""}</MarkdownInline>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

function parseDelimitedTable(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/\r\n/g, "\n");
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => String(value || "").trim()));
}

function normalizeTableValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeTableSpec(raw) {
  if (Array.isArray(raw)) {
    if (raw.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
      const columns = Array.from(new Set(raw.flatMap((row) => Object.keys(row))));
      return {
        columns: columns.map((key) => ({ key, label: key, align: "left" })),
        rows: raw.map((row) => columns.map((key) => normalizeTableValue(row[key]))),
      };
    }
    if (raw.every(Array.isArray) && raw.length > 0) {
      const headers = raw[0].map((cell, idx) => normalizeTableValue(cell) || `Column ${idx + 1}`);
      return {
        columns: headers.map((label, idx) => ({ key: String(idx), label, align: "left" })),
        rows: raw.slice(1).map((row) => headers.map((_, idx) => normalizeTableValue(row[idx]))),
      };
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const rawColumns = Array.isArray(raw.columns) ? raw.columns : Array.isArray(raw.headers) ? raw.headers : [];
  const rawRows = Array.isArray(raw.rows) ? raw.rows : Array.isArray(raw.data) ? raw.data : [];
  let columns = rawColumns.map((column, idx) => {
    if (column && typeof column === "object") {
      const key = String(column.key || column.name || column.field || idx);
      return {
        key,
        label: String(column.label || column.title || column.name || column.key || `Column ${idx + 1}`),
        align: ["left", "center", "right"].includes(column.align) ? column.align : "left",
      };
    }
    return { key: String(idx), label: normalizeTableValue(column) || `Column ${idx + 1}`, align: "left" };
  });
  if (columns.length === 0 && rawRows.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    columns = Array.from(new Set(rawRows.flatMap((row) => Object.keys(row)))).map((key) => ({ key, label: key, align: "left" }));
  }
  if (columns.length === 0 && rawRows.every(Array.isArray) && rawRows.length > 0) {
    columns = rawRows[0].map((cell, idx) => ({ key: String(idx), label: normalizeTableValue(cell) || `Column ${idx + 1}`, align: "left" }));
    return {
      columns,
      rows: rawRows.slice(1).map((row) => columns.map((_, idx) => normalizeTableValue(row[idx]))),
    };
  }
  return {
    columns,
    rows: rawRows.map((row) => {
      if (Array.isArray(row)) return columns.map((_, idx) => normalizeTableValue(row[idx]));
      if (row && typeof row === "object") return columns.map((column) => normalizeTableValue(row[column.key]));
      return columns.map((_, idx) => (idx === 0 ? normalizeTableValue(row) : ""));
    }),
  };
}

function parseTableDisplayContent(content) {
  const text = String(content || "").trim();
  if (!text) return { columns: [], rows: [], error: "" };
  const fenced = text.match(/^```(?:json|table|csv|tsv|markdown|md)?\s*\n?([\s\S]*?)```\s*$/i);
  const body = fenced ? fenced[1].trim() : text;
  try {
    const normalized = normalizeTableSpec(JSON.parse(body));
    if (normalized && normalized.columns.length) return { ...normalized, error: "" };
  } catch {
    /* try non-JSON formats */
  }
  const lines = body.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim());
  if (lines.length >= 2 && splitMarkdownTableRow(lines[0]).length > 1 && isMarkdownTableSeparator(lines[1])) {
    const headers = splitMarkdownTableRow(lines[0]);
    const align = markdownTableAlignments(lines[1]);
    return {
      columns: headers.map((label, idx) => ({ key: String(idx), label, align: align[idx] || "left" })),
      rows: lines.slice(2).map((line) => splitMarkdownTableRow(line)),
      error: "",
    };
  }
  const delimiter = body.includes("\t") ? "\t" : ",";
  const delimited = parseDelimitedTable(body, delimiter);
  if (delimited.length > 0 && delimited[0].length > 1) {
    const headers = delimited[0].map((cell, idx) => cell || `Column ${idx + 1}`);
    return {
      columns: headers.map((label, idx) => ({ key: String(idx), label, align: "left" })),
      rows: delimited.slice(1),
      error: "",
    };
  }
  return { columns: [], rows: [], error: "No table data detected" };
}

export function TableDisplayContent({ content }) {
  const table = useMemo(() => parseTableDisplayContent(content), [content]);
  if (table.error || table.columns.length === 0) {
    return (
      <div className="af-work-display-table-empty">
        <strong>Table data error</strong>
        <span>{table.error || "No columns found"}</span>
      </div>
    );
  }
  return (
    <div className="af-work-display-table-wrap af-work-display-table-wrap--standalone">
      <table className="af-work-display-table">
        <thead>
          <tr>
            {table.columns.map((column, idx) => (
              <th key={`${column.key}-${idx}`} style={{ textAlign: column.align || "left" }}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {table.columns.map((column, cellIdx) => (
                <td key={`${column.key}-${cellIdx}`} style={{ textAlign: column.align || "left" }}>
                  {normalizeTableValue(row[cellIdx])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartDisplayContent({ content }) {
  const hostRef = useRef(null);
  const parsed = useMemo(() => parseChartSpec(content), [content]);
  const [renderState, setRenderState] = useState({ loading: false, error: "" });

  useEffect(() => {
    if (!parsed.ok) {
      setRenderState({ loading: false, error: parsed.error || "Invalid chart spec" });
      return undefined;
    }
    let disposed = false;
    let chart = null;
    let resizeObserver = null;
    let resize = null;
    setRenderState({ loading: true, error: "" });
    import("echarts")
      .then((echarts) => {
        if (disposed || !hostRef.current) return;
        chart = echarts.init(hostRef.current, "dark", { renderer: "canvas" });
        chart.setOption(parsed.spec.option, true);
        resize = () => chart?.resize();
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(resize);
          resizeObserver.observe(hostRef.current);
        }
        window.addEventListener("resize", resize);
        window.requestAnimationFrame(resize);
        if (!disposed) setRenderState({ loading: false, error: "" });
      })
      .catch((error) => {
        if (!disposed) setRenderState({ loading: false, error: String(error?.message || error) });
      });
    return () => {
      disposed = true;
      if (resize) window.removeEventListener("resize", resize);
      resizeObserver?.disconnect?.();
      chart?.dispose?.();
    };
  }, [parsed]);

  if (!parsed.ok || renderState.error) {
    return (
      <div className="af-work-display-chart-error">
        <strong>Chart configuration error</strong>
        <span>{renderState.error || parsed.error}</span>
      </div>
    );
  }

  return (
    <div className="af-work-display-chart">
      <div ref={hostRef} className="af-work-display-chart__canvas" />
      {renderState.loading ? <div className="af-work-display-chart__loading">Loading chart...</div> : null}
    </div>
  );
}
