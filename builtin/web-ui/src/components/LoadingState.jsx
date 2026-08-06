export default function LoadingState({
  title = "正在加载",
  detail = "请稍候…",
  rows = 0,
  variant = "panel",
  className = "",
}) {
  const classes = ["af-loading-state", `af-loading-state--${variant}`, className].filter(Boolean).join(" ");
  return (
    <div className={classes} role="status" aria-live="polite">
      <span className="af-loading-state__spinner" aria-hidden />
      <div className="af-loading-state__copy"><strong>{title}</strong>{detail ? <span>{detail}</span> : null}</div>
      {rows > 0 ? (
        <div className="af-loading-state__skeleton" aria-hidden>
          {Array.from({ length: rows }, (_, index) => <i key={index} />)}
        </div>
      ) : null}
    </div>
  );
}
