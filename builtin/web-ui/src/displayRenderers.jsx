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

function markdownComponents(resolveSrc, inline = false) {
  return {
    ...(inline ? { p: ({ children: pChildren }) => <>{pChildren}</> } : {}),
    img: ({ src, alt }) => (
      <img src={resolveSrc ? resolveSrc(src) : src || ""} alt={alt || ""} loading="lazy" />
    ),
    a: ({ href, children }) => (
      <a href={href || ""} target="_blank" rel="noopener noreferrer">{children}</a>
    ),
  };
}

function MarkdownInline({ children, resolveSrc }) {
  return <ReactMarkdown components={markdownComponents(resolveSrc, true)}>{String(children || "")}</ReactMarkdown>;
}

export function MarkdownDisplayContent({ content, resolveSrc }) {
  const blocks = useMemo(() => parseMarkdownDisplayBlocks(content), [content]);
  const components = useMemo(() => markdownComponents(resolveSrc), [resolveSrc]);
  return (
    <>
      {blocks.map((block, idx) => {
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
                      <MarkdownInline resolveSrc={resolveSrc}>{cell}</MarkdownInline>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIdx) => (
                  <tr key={rowIdx}>
                    {block.headers.map((_, cellIdx) => (
                      <td key={cellIdx} style={{ textAlign: block.align[cellIdx] || "left" }}>
                        <MarkdownInline resolveSrc={resolveSrc}>{row[cellIdx] || ""}</MarkdownInline>
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
