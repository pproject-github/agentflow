import { spawnSync } from "node:child_process";

const DEFAULT_TAPD_API_BASE_URL = "https://api.tapd.cn";

function text(value) {
  return String(value ?? "").trim();
}

function normalizeVersion(value) {
  const match = text(value).match(/(?:^|[^\d])v?(\d+\.\d+)(?=$|[^\d])/i);
  return match ? match[1] : "";
}

function asIterationRows(payload) {
  const source = payload?.body ?? payload;
  const data = Array.isArray(source?.data) ? source.data : (Array.isArray(source) ? source : []);
  return data.map((entry) => entry?.Iteration || entry?.iteration || entry).filter((entry) => (
    entry && typeof entry === "object" && text(entry.id) && text(entry.name)
  ));
}

function normalizeDate(value) {
  const match = text(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

/**
 * 用户需求点: 发版列表自动从 TAPD 迭代中识别版本和发版日期，必须过滤掉非版本迭代。
 */
export function versionIterationRows(payload) {
  return asIterationRows(payload)
    .map((iteration) => ({
      iteration,
      version: normalizeVersion(iteration.name),
      releaseDate: normalizeDate(iteration.enddate || iteration.endDate || iteration.completed),
    }))
    .filter((entry) => entry.version && entry.releaseDate);
}

/** 用户需求点: 准备发版上下文时按当前两级版本精准定位 TAPD 迭代，避免让 Agent 再做一次日期确认。 */
export function findTapdIterationForVersion(payload, version) {
  const wanted = normalizeVersion(version);
  if (!wanted) return null;
  return versionIterationRows(payload)
    .filter((entry) => entry.version === wanted)
    .sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate)))[0] || null;
}

function tapdApiConfig(options = {}) {
  const apiBaseUrl = text(options.apiBaseUrl || options.endpoint || process.env.AGENTFLOW_TAPD_API_BASE_URL || DEFAULT_TAPD_API_BASE_URL).replace(/\/+$/, "");
  const accessTokenEnv = text(options.accessTokenEnv || options.access_token_env || process.env.AGENTFLOW_TAPD_ACCESS_TOKEN_ENV || "TAPD_ACCESS_TOKEN");
  const accessToken = text(options.accessToken || options.access_token || process.env[accessTokenEnv] || process.env.TAPD_ACCESS_TOKEN || process.env.AGENTFLOW_TAPD_ACCESS_TOKEN);
  if (!accessToken) throw new Error(`缺少 TAPD AccessToken，请配置 ${accessTokenEnv}`);
  if (!/^https?:\/\//i.test(apiBaseUrl)) throw new Error("TAPD API 地址必须是 http(s) URL");
  return { apiBaseUrl, accessToken };
}

function tapdRequestUrl({ apiBaseUrl, resource, params }) {
  const query = params instanceof URLSearchParams
    ? params
    : new URLSearchParams(Object.entries(params || {}).filter(([, value]) => text(value)));
  return `${apiBaseUrl}/${String(resource || "").replace(/^\/+/, "")}${query.toString() ? `?${query.toString()}` : ""}`;
}

async function tapdApiGet({ resource, params, ...options }) {
  const { apiBaseUrl, accessToken } = tapdApiConfig(options);
  const url = tapdRequestUrl({ apiBaseUrl, resource, params });
  if (typeof globalThis.fetch !== "function") throw new Error("当前 Node 运行时不支持 TAPD HTTP API");
  let response;
  try {
    response = await globalThis.fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(45_000) : undefined,
    });
  } catch (error) {
    throw new Error(`TAPD 迭代查询失败：${text(error?.message || error)}`);
  }
  if (!response.ok) throw new Error(`TAPD 迭代查询失败：HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`TAPD 迭代查询返回无效 JSON：${text(error?.message || error)}`);
  }
}

function tapdApiGetSync({ resource, params, ...options }) {
  const { apiBaseUrl, accessToken } = tapdApiConfig(options);
  const url = tapdRequestUrl({ apiBaseUrl, resource, params });
  const curl = text(process.env.AGENTFLOW_CURL_BIN) || "curl";
  const result = spawnSync(curl, ["--fail-with-body", "--silent", "--show-error", "--max-time", "45", "--header", `Authorization: Bearer ${accessToken}`, "--header", "Accept: application/json", url], {
    timeout: 45_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`TAPD 迭代查询失败：HTTP API 请求失败（${result.status == null ? "命令不可用" : `exit ${result.status}`}）`);
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(`TAPD 迭代查询返回无效 JSON：${text(error?.message || error)}`);
  }
}

async function defaultFetchIterations({ workspaceId, categoryId = "", iterationName = "", apiBaseUrl, accessToken, accessTokenEnv }) {
  const params = new URLSearchParams({ workspace_id: text(workspaceId), limit: "200" });
  if (categoryId) params.set("workitem_type_id", text(categoryId));
  if (iterationName) params.set("name", text(iterationName));
  return tapdApiGet({ resource: "iterations", params, apiBaseUrl, accessToken, accessTokenEnv });
}

async function defaultFetchCategories({ workspaceId, categoryName = "", apiBaseUrl, accessToken, accessTokenEnv }) {
  const params = new URLSearchParams({ workspace_id: text(workspaceId), limit: "200" });
  if (categoryName) params.set("name", text(categoryName));
  return tapdApiGet({ resource: "workitem_types", params, apiBaseUrl, accessToken, accessTokenEnv });
}

/** 用户需求点: 初始化节点是同步脚本路径，必须在不启动 Agent 的情况下完成 TAPD 日期查询。 */
export function defaultFetchIterationsSync({ workspaceId, categoryId = "", iterationName = "", apiBaseUrl, accessToken, accessTokenEnv }) {
  const params = new URLSearchParams({ workspace_id: text(workspaceId), limit: "200" });
  if (categoryId) params.set("workitem_type_id", text(categoryId));
  if (iterationName) params.set("name", text(iterationName));
  return tapdApiGetSync({ resource: "iterations", params, apiBaseUrl, accessToken, accessTokenEnv });
}

function categoryRows(payload) {
  const source = payload?.body ?? payload;
  const data = Array.isArray(source?.data) ? source.data : (Array.isArray(source) ? source : []);
  return data.map((entry) => entry?.WorkitemType || entry?.workitem_type || entry).filter((entry) => (
    entry && typeof entry === "object" && text(entry.id) && text(entry.name)
  ));
}

function tapdMeta(iteration, workspaceId) {
  return {
    tapdWorkspaceId: text(workspaceId),
    tapdIterationId: text(iteration.id),
    tapdIterationName: text(iteration.name),
    tapdIterationStartDate: normalizeDate(iteration.startdate || iteration.startDate),
    tapdIterationEndDate: normalizeDate(iteration.enddate || iteration.endDate || iteration.completed),
  };
}

/**
 * 用户需求点: 同步必须幂等，重复点击只更新 TAPD 日期/元数据，不重复生成版本记录。
 */
export async function syncTapdReleases({
  project,
  platform,
  tapd = {},
  fetchIterations = defaultFetchIterations,
  fetchCategories = defaultFetchCategories,
  upsertRelease,
} = {}) {
  const workspaceId = text(tapd.workspaceId || tapd.workspace_id);
  if (!workspaceId) throw new Error("TAPD workspaceId 未配置");
  if (typeof upsertRelease !== "function") throw new Error("发版版本写入器未配置");
  let categoryId = text(tapd.categoryId || tapd.category_id);
  if (!categoryId && text(tapd.categoryName || tapd.category_name)) {
    const categories = categoryRows(await fetchCategories({
      workspaceId,
      categoryName: tapd.categoryName || tapd.category_name,
      apiBaseUrl: tapd.apiBaseUrl || tapd.api_base_url,
      accessTokenEnv: tapd.accessTokenEnv || tapd.access_token_env,
      accessToken: tapd.accessToken || tapd.access_token,
    }));
    const wanted = text(tapd.categoryName || tapd.category_name).toLowerCase();
    categoryId = text(categories.find((entry) => text(entry.name).toLowerCase() === wanted)?.id);
    if (!categoryId) throw new Error(`TAPD 分类不存在：${tapd.categoryName || tapd.category_name}`);
  }
  const payload = await fetchIterations({
    workspaceId,
    categoryId,
    iterationName: tapd.iterationName || tapd.iteration_name,
    apiBaseUrl: tapd.apiBaseUrl || tapd.api_base_url,
    accessTokenEnv: tapd.accessTokenEnv || tapd.access_token_env,
    accessToken: tapd.accessToken || tapd.access_token,
  });
  const allRows = asIterationRows(payload);
  const rows = versionIterationRows(payload);
  const results = [];
  for (const { iteration, version, releaseDate } of rows) {
    const result = await upsertRelease({
      project,
      platform,
      version,
      releaseDate,
      ...tapdMeta(iteration, workspaceId),
    });
    results.push({ version, releaseDate, ...(result || {}) });
  }
  return {
    workspaceId,
    total: results.length,
    created: results.filter((item) => item.created).length,
    updated: results.filter((item) => item.updated).length,
    skipped: (allRows.length - rows.length) + results.filter((item) => item.skipped).length,
    releases: results,
  };
}

export { defaultFetchCategories, defaultFetchIterations };
