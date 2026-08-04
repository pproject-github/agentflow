import { useCallback, useEffect, useMemo, useState } from "react";

export default function AdminTeamsPage({ authUser }) {
  const [teams, setTeams] = useState([]);
  const [users, setUsers] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState({ name: "", description: "", status: "active", members: [] });
  const [newName, setNewName] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/admin/teams");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "读取团队失败");
      const nextTeams = Array.isArray(payload.teams) ? payload.teams : [];
      setTeams(nextTeams);
      setUsers(Array.isArray(payload.users) ? payload.users : []);
      setSelectedId((current) => current && nextTeams.some((team) => team.id === current) ? current : nextTeams[0]?.id || "");
    } catch (loadError) {
      setError(String(loadError.message || loadError));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => teams.find((team) => team.id === selectedId) || null, [selectedId, teams]);
  useEffect(() => {
    if (!selected) {
      setDraft({ name: "", description: "", status: "active", members: [] });
      return;
    }
    setDraft({
      name: selected.name || "",
      description: selected.description || "",
      status: selected.status || "active",
      members: (selected.members || []).map((member) => member.userId || member),
    });
  }, [selected]);

  const request = async (method, body) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/teams", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "更新团队失败");
      await load();
      return payload;
    } catch (requestError) {
      setError(String(requestError.message || requestError));
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (!authUser?.isAdmin) {
    return <main className="af-team-admin-page"><div className="af-workflows-message af-workflows-message--error">仅超级管理员可以管理团队。</div></main>;
  }

  const filteredUsers = users.filter((user) => {
    const keyword = query.trim().toLowerCase();
    return !keyword || `${user.username} ${user.userId}`.toLowerCase().includes(keyword);
  });

  return (
    <main className="af-team-admin-page">
      <header className="af-team-admin-hero">
        <div><span>Admin / Organization</span><h1>团队管理</h1><p>划分团队成员，并为团队迭代汇总与 Project 分享提供权限边界。</p></div>
        <button type="button" onClick={() => void load()} disabled={busy}><span className="material-symbols-outlined">refresh</span>刷新</button>
      </header>
      {error ? <div className="af-workflows-message af-workflows-message--error">{error}</div> : null}
      <div className="af-team-admin-layout">
        <aside className="af-team-admin-list">
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!newName.trim()) return;
            void request("POST", { name: newName.trim() }).then((payload) => {
              if (payload?.team?.id) setSelectedId(payload.team.id);
              if (payload) setNewName("");
            });
          }}>
            <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="新团队名称" />
            <button type="submit" disabled={busy || !newName.trim()}><span className="material-symbols-outlined">add</span></button>
          </form>
          {teams.map((team) => (
            <button key={team.id} type="button" className={team.id === selectedId ? "is-active" : ""} onClick={() => setSelectedId(team.id)}>
              <span><strong>{team.name}</strong><small>{team.memberCount || 0} 位成员</small></span>
              {team.status === "inactive" ? <em>已停用</em> : null}
            </button>
          ))}
          {!teams.length ? <p>还没有团队。</p> : null}
        </aside>
        <section className="af-team-admin-detail">
          {selected ? <>
            <div className="af-team-admin-fields">
              <label><span>团队名称</span><input value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} /></label>
              <label><span>状态</span><select value={draft.status} onChange={(event) => setDraft((value) => ({ ...value, status: event.target.value }))}><option value="active">启用</option><option value="inactive">停用</option></select></label>
              <label className="is-wide"><span>说明</span><textarea value={draft.description} onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))} placeholder="团队职责或范围" /></label>
            </div>
            <div className="af-team-admin-members-head"><div><strong>团队成员</strong><span>一个用户只能属于一个团队，保存后会自动从原团队移出。</span></div><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索用户" /></div>
            <div className="af-team-admin-members">
              {filteredUsers.map((user) => {
                const checked = draft.members.includes(user.userId);
                return <label key={user.userId} className={checked ? "is-selected" : ""}>
                  <input type="checkbox" checked={checked} onChange={(event) => setDraft((value) => ({
                    ...value,
                    members: event.target.checked
                      ? [...value.members, user.userId]
                      : value.members.filter((id) => id !== user.userId),
                  }))} />
                  <span className="material-symbols-outlined">person</span>
                  <span><strong>{user.username}</strong><small>{user.userId}{user.isAdmin ? " · Admin" : ""}</small></span>
                  {user.teamId && user.teamId !== selected.id ? <em>{teams.find((team) => team.id === user.teamId)?.name || "其他团队"}</em> : null}
                </label>;
              })}
            </div>
            <footer className="af-team-admin-actions">
              <button type="button" className="is-danger" disabled={busy || draft.members.length > 0} onClick={() => {
                if (window.confirm(`删除团队「${selected.name}」？`)) void request("DELETE", { teamId: selected.id });
              }}>删除团队</button>
              <div>
                <button type="button" disabled={busy} onClick={() => setDraft({ name: selected.name, description: selected.description || "", status: selected.status, members: (selected.members || []).map((member) => member.userId || member) })}>重置</button>
                <button type="button" className="is-primary" disabled={busy || !draft.name.trim()} onClick={async () => {
                  const updated = await request("PATCH", { teamId: selected.id, name: draft.name, description: draft.description, status: draft.status });
                  if (updated) await request("PUT", { teamId: selected.id, members: draft.members });
                }}>{busy ? "保存中..." : "保存团队"}</button>
              </div>
            </footer>
          </> : <div className="af-workflows-message">创建或选择一个团队。</div>}
        </section>
      </div>
    </main>
  );
}
