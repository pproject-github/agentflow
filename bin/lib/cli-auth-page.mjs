function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>${escapeHtml(title)} · AgentFlow</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f6f3ff; background: radial-gradient(circle at top, #2b2048 0, #15121f 42%, #0c0b10 100%); }
    main { width: min(92vw, 580px); border: 1px solid #4b4265; border-radius: 22px; padding: 30px; background: rgba(28, 25, 36, .96); box-shadow: 0 28px 80px rgba(0,0,0,.48); }
    .brand { color: #ae98ff; font-size: 13px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 12px 0 8px; font-size: 28px; }
    p { color: #bdb7cb; line-height: 1.6; }
    .code { display: inline-block; margin: 10px 0 18px; padding: 9px 13px; border: 1px solid #51466e; border-radius: 10px; color: #d4c8ff; background: #15121d; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; }
    .card { margin: 20px 0; padding: 16px; border: 1px solid #3d374c; border-radius: 14px; background: #23202b; }
    ul { margin: 10px 0 0; padding-left: 22px; color: #d0cadb; line-height: 1.8; }
    label { display: block; margin: 14px 0 6px; color: #c9c2d7; font-size: 13px; font-weight: 700; }
    input { width: 100%; padding: 12px 13px; border: 1px solid #514a60; border-radius: 10px; color: #fff; background: #15131a; font: inherit; }
    .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }
    .button, button { min-width: 112px; padding: 11px 18px; border: 1px solid #554d66; border-radius: 999px; color: #fff; background: #302b39; font: inherit; font-weight: 750; cursor: pointer; }
    .button { display: inline-block; text-align: center; text-decoration: none; }
    .button.primary, button.primary { border-color: #8d72ff; background: #7352ef; }
    button.danger { color: #ffc8c8; }
    .error { padding: 12px 14px; border: 1px solid #8b454d; border-radius: 10px; color: #ffd1d4; background: #351d22; }
    .identity { color: #8edcb5; }
    .fine { margin-top: 22px; color: #837d90; font-size: 12px; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

const SCOPE_LABELS = new Map([
  ["workspace:read", "读取你的 Workspace 与 Flow"],
  ["workspace:write", "创建和修改 Draft Workspace"],
  ["workspace:run", "运行 Draft 与已发布 Flow"],
  ["flow:publish", "发布 Flow 到你的空间"],
  ["schedule:manage", "配置和触发定时运行"],
  ["node-package:manage", "管理可复用节点包"],
  ["workflow:manage", "读取和更新 Workflow 数据"],
]);

export function renderCliAuthorizationPage({ authorization, approvalNonce = "", user = null, error = "" } = {}) {
  if (!authorization) {
    return pageShell("CLI 授权", `<div class="brand">AgentFlow CLI</div><h1>授权请求无效</h1><p>${escapeHtml(error || "该链接不存在或已经过期。")}</p>`);
  }
  const requestId = escapeHtml(authorization.requestId);
  const clientName = escapeHtml(authorization.clientName || "AgentFlow CLI");
  const code = escapeHtml(authorization.userCode || "");
  const errorBlock = error ? `<div class="error">${escapeHtml(error)}</div>` : "";
  if (!user) {
    const returnTo = `/cli/authorize?request=${encodeURIComponent(String(authorization.requestId || ""))}`;
    const casLoginUrl = `/api/auth/cas/login?returnTo=${encodeURIComponent(returnTo)}`;
    return pageShell("登录并授权", `
      <div class="brand">AgentFlow CLI Authorization</div>
      <h1>登录后授权 ${clientName}</h1>
      <p>请求代码</p><div class="code">${code}</div>
      ${errorBlock}
      <p>普通用户仅支持 CAS 统一认证。</p>
      <div class="actions"><a class="button primary" href="${escapeHtml(casLoginUrl)}">使用 CAS 登录</a></div>
      <div class="fine">管理员密码入口仅用于 AgentFlow 管理后台，不能作为普通用户授权入口。</div>`);
  }
  const scopes = (authorization.scopes || []).map((scope) => `<li>${escapeHtml(SCOPE_LABELS.get(scope) || scope)}</li>`).join("");
  return pageShell("确认 CLI 授权", `
    <div class="brand">AgentFlow CLI Authorization</div>
    <h1>允许 ${clientName} 访问？</h1>
    <p class="identity">当前账号：${escapeHtml(user.username || user.userId)}</p>
    <p>请求代码</p><div class="code">${code}</div>
    ${errorBlock}
    <div class="card"><strong>授权后 CLI 可以：</strong><ul>${scopes}</ul></div>
    <form method="post" action="/cli/authorize/decision">
      <input type="hidden" name="request" value="${requestId}" />
      <input type="hidden" name="approvalNonce" value="${escapeHtml(approvalNonce)}" />
      <div class="actions">
        <button class="danger" type="submit" name="decision" value="deny">拒绝</button>
        <button class="primary" type="submit" name="decision" value="approve">允许</button>
      </div>
    </form>
    <div class="fine">CLI 将获得独立凭据；撤销 CLI 授权不会退出当前网页。</div>`);
}

export function renderCliAuthorizationResult({ approved, clientName = "AgentFlow CLI", error = "" } = {}) {
  const title = error ? "授权失败" : approved ? "授权完成" : "已拒绝授权";
  const message = error
    ? escapeHtml(error)
    : approved
      ? `已允许 ${escapeHtml(clientName)} 访问。你可以关闭此页面并返回终端。`
      : `没有授予 ${escapeHtml(clientName)} 访问权限。你可以关闭此页面。`;
  return pageShell(title, `<div class="brand">AgentFlow CLI</div><h1>${title}</h1><p>${message}</p>`);
}
