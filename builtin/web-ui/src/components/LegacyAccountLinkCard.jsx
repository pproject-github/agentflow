import { useCallback, useEffect, useState } from "react";

export default function LegacyAccountLinkCard({ authUser }) {
  const eligible = !authUser?.isAdmin && authUser?.authProvider === "cas";
  const [legacyUserIds, setLegacyUserIds] = useState([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadStatus = useCallback(async () => {
    if (!eligible) return;
    setLoading(true);
    try {
      const response = await fetch("/api/auth/legacy-account-link");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "读取旧账号同步状态失败");
      setLegacyUserIds(Array.isArray(payload.legacyUserIds) ? payload.legacyUserIds.map(String) : []);
    } catch (loadError) {
      setError(String(loadError?.message || loadError));
    } finally {
      setLoading(false);
    }
  }, [eligible]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  if (!eligible) return null;

  const submit = async (event) => {
    event.preventDefault();
    if (!username.trim() || !password || busy) return;
    if (!window.confirm(`确认将旧账号「${username.trim()}」同步到当前 CAS 账号？\n\nProject、协作关系和定时任务会迁移；旧账号密码将停用，历史运行审计不会改写。`)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/auth/legacy-account-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "同步旧账号失败");
      setUsername("");
      setPassword("");
      setMessage(`旧账号同步完成，共迁移 ${Number(payload.transferredProjects || 0)} 个 Project。`);
      await loadStatus();
    } catch (submitError) {
      setError(String(submitError?.message || submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="af-set-card af-set-card--wide af-legacy-link-card">
      <div className="af-set-card-head">
        <div className="af-set-env-icon-wrap"><span className="material-symbols-outlined af-set-icon--primary">sync_alt</span></div>
        <div><h2 className="af-set-h2">同步旧账号</h2><p className="af-set-card-subtitle">用旧账号密码证明归属，将原有 Project 自助迁移到当前 CAS 用户。</p></div>
      </div>
      {legacyUserIds.length > 0 ? <div className="af-legacy-link-linked"><span>已同步</span>{legacyUserIds.map((userId) => <code key={userId}>{userId}</code>)}</div> : null}
      {error ? <p className="af-err af-set-hint af-set-hint--inline">{error}</p> : null}
      {message ? <p className="af-legacy-link-success">{message} <a href="/projects">查看 Project</a></p> : null}
      <form className="af-legacy-link-form" onSubmit={submit}>
        <label><span>旧用户名</span><input type="text" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="旧 AgentFlow 用户名" disabled={busy || loading} /></label>
        <label><span>旧密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="用于验证归属，不会保存" disabled={busy || loading} /></label>
        <button type="submit" disabled={busy || loading || !username.trim() || !password}>{busy ? "同步中…" : "验证并同步"}</button>
      </form>
      <p className="af-set-hint">同步前会检查同名 Project、定时任务冲突和运行中任务；任一检查不通过都不会开始迁移。</p>
    </section>
  );
}
