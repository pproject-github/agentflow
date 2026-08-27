import { useCallback, useEffect, useMemo, useState } from "react";

function projectKey(project) {
  return `${project.userId}\t${project.archived ? "1" : "0"}\t${project.flowId}`;
}

export default function AdminUsersPage({ authUser }) {
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const [targetUserId, setTargetUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/users?includeProjects=1");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "读取用户归属失败");
      const nextUsers = Array.isArray(payload.users) ? payload.users : [];
      const nextProjects = Array.isArray(payload.projects) ? payload.projects : [];
      setUsers(nextUsers);
      setProjects(nextProjects);
      setSelectedProjectKey((current) => current && nextProjects.some((project) => projectKey(project) === current) ? current : "");
      setTargetUserId((current) => current && nextUsers.some((user) => user.userId === current && user.authProvider === "cas") ? current : "");
    } catch (loadError) {
      setError(String(loadError?.message || loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selectedProject = useMemo(
    () => projects.find((project) => projectKey(project) === selectedProjectKey) || null,
    [projects, selectedProjectKey],
  );
  const casUsers = useMemo(
    () => users.filter((user) => user.authProvider === "cas" && !user.isAdmin && user.userId !== selectedProject?.userId),
    [selectedProject?.userId, users],
  );
  const projectCounts = useMemo(() => {
    const counts = new Map();
    for (const project of projects) counts.set(project.userId, (counts.get(project.userId) || 0) + 1);
    return counts;
  }, [projects]);

  if (!authUser?.isAdmin) {
    return <main className="af-admin-users-page"><div className="af-workflows-message af-workflows-message--error">仅超级管理员可以管理用户归属。</div></main>;
  }

  const transfer = async () => {
    if (!selectedProject || !targetUserId || busy) return;
    const target = users.find((user) => user.userId === targetUserId);
    if (!window.confirm(`将 Project「${selectedProject.flowId}」从 ${selectedProject.userId} 转移给 ${target?.username || targetUserId}？\n\nStable/Draft、协作关系和定时任务归属会一并迁移。`)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/projects/reassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceUserId: selectedProject.userId,
          targetUserId,
          flowId: selectedProject.flowId,
          archived: selectedProject.archived === true,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "迁移 Project 失败");
      setMessage(`已将 ${selectedProject.flowId} 迁移给 ${target?.username || targetUserId}`);
      setSelectedProjectKey("");
      setTargetUserId("");
      await load();
    } catch (transferError) {
      setError(String(transferError?.message || transferError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="af-admin-users-page">
      <header className="af-admin-users-hero">
        <div><span>Admin / Identity</span><h1>用户与 Project 归属</h1><p>普通用户由 CAS 自动创建；将旧账号下的 Project 显式迁移给新的 CAS 用户。</p></div>
        <button type="button" onClick={() => void load()} disabled={loading || busy}><span className="material-symbols-outlined">refresh</span>刷新</button>
      </header>

      {error ? <div className="af-workflows-message af-workflows-message--error">{error}</div> : null}
      {message ? <div className="af-workflows-message af-workflows-message--success">{message}</div> : null}

      <section className="af-admin-transfer-card">
        <div className="af-admin-transfer-card__head">
          <span className="material-symbols-outlined">drive_file_move</span>
          <div><h2>迁移 Project 归属</h2><p>不会覆盖目标用户的同名 Project；历史运行审计仍保留原执行人。</p></div>
        </div>
        <div className="af-admin-transfer-fields">
          <label><span>旧账号 / Project</span><select value={selectedProjectKey} onChange={(event) => { setSelectedProjectKey(event.target.value); setTargetUserId(""); }}>
            <option value="">选择待迁移 Project</option>
            {projects.map((project) => <option key={projectKey(project)} value={projectKey(project)}>{project.userId} / {project.flowId}{project.archived ? "（已归档）" : ""}</option>)}
          </select></label>
          <span className="material-symbols-outlined af-admin-transfer-arrow">arrow_forward</span>
          <label><span>目标 CAS 用户</span><select value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)} disabled={!selectedProject}>
            <option value="">选择 CAS 用户</option>
            {casUsers.map((user) => <option key={user.userId} value={user.userId}>{user.username}（{user.userId}）</option>)}
          </select></label>
          <button type="button" className="is-primary" disabled={!selectedProject || !targetUserId || busy} onClick={() => void transfer()}>{busy ? "迁移中…" : "确认迁移"}</button>
        </div>
      </section>

      <section className="af-admin-user-directory">
        <div className="af-admin-user-directory__head"><div><h2>用户目录</h2><p>CAS 用户首次登录后会出现在这里，才能作为 Project 的目标归属人。</p></div><strong>{users.length} 用户</strong></div>
        <div className="af-admin-user-grid">
          {users.map((user) => <article key={user.userId}>
            <span className="material-symbols-outlined">{user.isAdmin ? "admin_panel_settings" : user.authProvider === "cas" ? "badge" : "person"}</span>
            <div><strong>{user.username || user.userId}</strong><code>{user.userId}</code></div>
            <em className={`is-${user.isAdmin ? "admin" : user.authProvider === "cas" ? "cas" : "legacy"}`}>{user.isAdmin ? "Admin 密码" : user.authProvider === "cas" ? "CAS" : "旧密码"}</em>
            <small>{projectCounts.get(user.userId) || 0} Projects</small>
          </article>)}
          {!loading && users.length === 0 ? <p>暂无用户。</p> : null}
        </div>
      </section>
    </main>
  );
}
