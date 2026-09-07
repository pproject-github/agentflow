import fs from "node:fs";
import path from "node:path";

function text(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return text(value).toLowerCase();
}

function splitPaths(value) {
  return text(value)
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

const LOCAL_DEV_RELEASE_ROOT = "/Users/duanfengyuan/migration-workspace/test/likee_android";
const LOCAL_DEV_RELEASE_SKILL_ROOTS = [
  path.join(LOCAL_DEV_RELEASE_ROOT, ".workspace", "release-skills"),
  path.join(LOCAL_DEV_RELEASE_ROOT, ".workspace", "release-skills-google-play-aab"),
];

function parseJson(value, source) {
  if (!text(value)) return {};
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { configError: `${source} must contain a JSON object` };
    }
    return parsed;
  } catch (error) {
    return { configError: `${source} is invalid JSON: ${error?.message || String(error)}` };
  }
}

function normalizeProject(entry, fallbackId = "") {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const businessLine = normalized(entry.businessLine || entry.business || entry.product);
  const platform = normalized(entry.platform || entry.os);
  const workspaceRoot = text(entry.workspaceRoot || entry.repositoryRoot || entry.path);
  if (!businessLine || !platform || !workspaceRoot) return null;
  const id = text(entry.id || fallbackId || `${businessLine}-${platform}`);
  const skillRoots = Array.isArray(entry.skillRoots)
    ? entry.skillRoots.map((item) => text(item)).filter(Boolean).map((item) => path.resolve(item))
    : [];
  const tapdSource = entry.tapd && typeof entry.tapd === "object" && !Array.isArray(entry.tapd) ? entry.tapd : {};
  const tapd = {
    ...(text(tapdSource.workspaceId || tapdSource.workspace_id) ? { workspaceId: text(tapdSource.workspaceId || tapdSource.workspace_id) } : {}),
    ...(text(tapdSource.categoryId || tapdSource.category_id) ? { categoryId: text(tapdSource.categoryId || tapdSource.category_id) } : {}),
    ...(text(tapdSource.categoryName || tapdSource.category_name) ? { categoryName: text(tapdSource.categoryName || tapdSource.category_name) } : {}),
    ...(text(tapdSource.iterationName || tapdSource.iteration_name) ? { iterationName: text(tapdSource.iterationName || tapdSource.iteration_name) } : {}),
    ...(text(tapdSource.apiBaseUrl || tapdSource.api_base_url) ? { apiBaseUrl: text(tapdSource.apiBaseUrl || tapdSource.api_base_url) } : {}),
    ...(text(tapdSource.accessTokenEnv || tapdSource.access_token_env) ? { accessTokenEnv: text(tapdSource.accessTokenEnv || tapdSource.access_token_env) } : {}),
  };
  return {
    id,
    businessLine,
    platform: platform === "ios" || platform === "iphone" ? "ios" : platform,
    workspaceRoot: path.resolve(workspaceRoot),
    ...(skillRoots.length ? { skillRoots: [...new Set(skillRoots)] } : {}),
    ...(Object.keys(tapd).length ? { tapd } : {}),
    ...(entry.enabled === false ? { enabled: false } : {}),
  };
}

function projectsFromJson(raw) {
  if (Array.isArray(raw.projects)) {
    return raw.projects.map((entry) => normalizeProject(entry)).filter(Boolean);
  }
  const projects = [];
  for (const [businessLine, byPlatform] of Object.entries(raw)) {
    if (["skillRoots", "projects", "allowWorkspaceSkillRoots", "operators"].includes(businessLine)) continue;
    if (!byPlatform || typeof byPlatform !== "object" || Array.isArray(byPlatform)) continue;
    for (const [platform, entry] of Object.entries(byPlatform)) {
      const normalizedEntry = normalizeProject({ ...(entry || {}), businessLine, platform }, `${businessLine}-${platform}`);
      if (normalizedEntry) projects.push(normalizedEntry);
    }
  }
  return projects;
}

const DEFAULT_DEV_OPERATORS = Object.freeze({
  likee: Object.freeze({
    android: Object.freeze(["duanfengyuan", "suruijia", "wangfang"]),
    ios: Object.freeze(["liangjiajian", "yangcaimu"]),
  }),
  bigolive: Object.freeze({ android: Object.freeze([]), ios: Object.freeze([]) }),
  hello: Object.freeze({ android: Object.freeze([]), ios: Object.freeze([]) }),
});

function normalizePlatformKey(value) {
  const platform = normalized(value);
  return platform === "iphone" ? "ios" : platform;
}

function normalizeOperatorList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalized(item)).filter(Boolean))];
}

/**
 * 用户需求点: 发版写权限按业务线×平台名单控制；同一用户最多归属一个业务线+平台。
 */
export function validateReleaseOperators(operators = {}) {
  const errors = [];
  if (!operators || typeof operators !== "object" || Array.isArray(operators)) {
    return { valid: false, errors: ["operators must be an object"] };
  }
  const seen = new Map();
  for (const [businessLineRaw, byPlatform] of Object.entries(operators)) {
    const businessLine = normalized(businessLineRaw);
    if (!businessLine) {
      errors.push("operators business line is required");
      continue;
    }
    if (!byPlatform || typeof byPlatform !== "object" || Array.isArray(byPlatform)) {
      errors.push(`operators.${businessLine} must be an object of platforms`);
      continue;
    }
    for (const [platformRaw, users] of Object.entries(byPlatform)) {
      const platform = normalizePlatformKey(platformRaw);
      if (!platform) {
        errors.push(`operators.${businessLine} has empty platform`);
        continue;
      }
      if (!Array.isArray(users)) {
        errors.push(`operators.${businessLine}.${platform} must be an array`);
        continue;
      }
      for (const user of normalizeOperatorList(users)) {
        const prior = seen.get(user);
        if (prior) {
          errors.push(`operator ${user} is listed under ${prior.businessLine}/${prior.platform} and ${businessLine}/${platform}`);
          continue;
        }
        seen.set(user, { businessLine, platform });
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function normalizeReleaseOperators(rawOperators) {
  const operators = {};
  if (!rawOperators || typeof rawOperators !== "object" || Array.isArray(rawOperators)) return operators;
  for (const [businessLineRaw, byPlatform] of Object.entries(rawOperators)) {
    const businessLine = normalized(businessLineRaw);
    if (!businessLine || !byPlatform || typeof byPlatform !== "object" || Array.isArray(byPlatform)) continue;
    operators[businessLine] = operators[businessLine] || {};
    for (const [platformRaw, users] of Object.entries(byPlatform)) {
      const platform = normalizePlatformKey(platformRaw);
      if (!platform) continue;
      operators[businessLine][platform] = normalizeOperatorList(users);
    }
  }
  return operators;
}

export function resolveReleaseOperatorMembership(username, config = {}) {
  const user = normalized(username);
  if (!user) return null;
  const operators = config?.operators && typeof config.operators === "object" ? config.operators : {};
  for (const [businessLine, byPlatform] of Object.entries(operators)) {
    if (!byPlatform || typeof byPlatform !== "object") continue;
    for (const [platform, users] of Object.entries(byPlatform)) {
      if (normalizeOperatorList(users).includes(user)) {
        return { businessLine: normalized(businessLine), platform: normalizePlatformKey(platform) };
      }
    }
  }
  return null;
}

export function canWriteRelease(username, context = {}, config = {}) {
  const user = normalized(username);
  const businessLine = normalized(context.businessLine);
  const platform = normalizePlatformKey(context.platform);
  if (!user || !businessLine || !platform) return false;
  const operators = config?.operators && typeof config.operators === "object" ? config.operators : {};
  const hasConfiguredOperators = Object.values(operators).some((byPlatform) => (
    byPlatform && typeof byPlatform === "object"
    && Object.values(byPlatform).some((users) => Array.isArray(users) && users.some((item) => normalized(item)))
  ));
  // 未配置 operators 时：生产拒绝写；非生产保持开放以兼容既有测试与本地未配名单环境。
  if (!hasConfiguredOperators) return config?.production !== true;
  const users = operators?.[businessLine]?.[platform];
  return normalizeOperatorList(users).includes(user);
}

/**
 * 写操作鉴权：补全缺失的业务线/平台归属后判断是否在 operators 名单中。
 * @returns {{ ok: true, context, membership, canWrite: true } | { ok: false, status: 403, code: string, error: string, context, membership, canWrite: false }}
 */
export function assertReleaseWriteAccess(username, context = {}, config = {}) {
  const membership = resolveReleaseOperatorMembership(username, config);
  const resolved = {
    businessLine: normalized(context.businessLine) || membership?.businessLine || "",
    platform: normalizePlatformKey(context.platform) || membership?.platform || "",
    version: text(context.version),
    batch: normalized(context.batch || "initial") || "initial",
  };
  if (!resolved.businessLine || !resolved.platform) {
    return {
      ok: false,
      status: 403,
      code: "RELEASE_OPERATOR_FORBIDDEN",
      error: "无发版操作权限：无法确定业务线与平台归属（页面与助手都不能触发运行）",
      context: resolved,
      membership,
      canWrite: false,
    };
  }
  if (!canWriteRelease(username, resolved, config)) {
    return {
      ok: false,
      status: 403,
      code: "RELEASE_OPERATOR_FORBIDDEN",
      error: `无发版操作权限：${resolved.businessLine}/${resolved.platform}（页面与助手都不能触发运行）`,
      context: resolved,
      membership,
      canWrite: false,
    };
  }
  return { ok: true, context: resolved, membership, canWrite: true };
}

export function buildReleaseAccessPayload(username, context = {}, config = {}) {
  const membership = resolveReleaseOperatorMembership(username, config);
  const businessLine = normalized(context.businessLine) || membership?.businessLine || "";
  const platform = normalizePlatformKey(context.platform) || membership?.platform || "";
  const scoped = { businessLine, platform };
  const canWrite = Boolean(businessLine && platform && canWriteRelease(username, scoped, config));
  // 用户需求点: 助手侧用 operators 反查业务线/平台；不在名单则直接提示无法操作。
  return {
    username: normalized(username) || "",
    membership,
    canWrite,
    operable: Boolean(membership),
    businessLine: businessLine || null,
    platform: platform || null,
    message: membership ? "" : "无法操作",
  };
}

export const RELEASE_PROJECTS_FILENAME = "release-projects.json";

/** 用户需求点: 发版工程配置默认落在 AgentFlow 数据根，与 workspaces.json 同级，设置页可改。 */
export function resolveReleaseProjectsFilePath(dataRoot = "") {
  const root = text(dataRoot);
  if (!root) return "";
  return path.join(path.resolve(root), RELEASE_PROJECTS_FILENAME);
}

export function emptyReleaseProjectsDocument() {
  return {
    projects: [
      {
        id: "likee-android-prod",
        businessLine: "likee",
        platform: "android",
        workspaceRoot: "",
        skillRoots: [],
        tapd: { workspaceId: "33202860" },
      },
      {
        id: "likee-ios-prod",
        businessLine: "likee",
        platform: "ios",
        workspaceRoot: "",
        skillRoots: [],
        tapd: { workspaceId: "33202860" },
      },
    ],
    operators: {
      likee: { android: [], ios: [] },
      bigolive: { android: [], ios: [] },
      hello: { android: [], ios: [] },
    },
  };
}

/** 用户需求点: 线上首次启动缺文件时种子写入 mengmai 发版工程路径；已有文件永不覆盖。 */
export function defaultReleaseProjectsSeedDocument() {
  return {
    projects: [
      {
        id: "likee-android-prod",
        businessLine: "likee",
        platform: "android",
        workspaceRoot: "/data1/services/mengmai/workspace/repos/likee_android",
        skillRoots: ["/data1/services/mengmai/agentflow/workspaces/repos/ws_mtmeszw3_lojgr"],
        tapd: { workspaceId: "33202860" },
      },
      {
        id: "likee-ios-prod",
        businessLine: "likee",
        platform: "ios",
        workspaceRoot: "/data1/services/mengmai/workspace/repos/likee_ios",
        skillRoots: ["/data1/services/mengmai/agentflow/workspaces/repos/ws_mtmeszw3_lojgr"],
        tapd: { workspaceId: "33202860" },
      },
    ],
    operators: {
      likee: {
        android: ["duanfengyuan", "suruijia", "wangfang"],
        ios: ["liangjiajian", "yangcaimu"],
      },
      bigolive: { android: [], ios: [] },
      hello: { android: [], ios: [] },
    },
  };
}

/** 是否应在缺文件时自动种子（生产、显式开关、或 mengmai AgentFlow 数据根）。 */
export function shouldSeedReleaseProjectsFile(dataRoot = "", env = process.env) {
  if (text(env.AGENTFLOW_RELEASE_SEED_PROJECTS) === "0") return false;
  if (text(env.AGENTFLOW_RELEASE_SEED_PROJECTS) === "1") return true;
  if (normalized(env.NODE_ENV) === "production") return true;
  return /\/mengmai\/agentflow(?:\/|$)/i.test(text(dataRoot));
}

export function normalizeReleaseProjectsDocument(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const projects = projectsFromJson(source).filter((entry) => entry.enabled !== false);
  const operators = normalizeReleaseOperators(source.operators);
  const operatorValidation = validateReleaseOperators(operators);
  const skillRoots = Array.isArray(source.skillRoots)
    ? [...new Set(source.skillRoots.map((item) => text(item)).filter(Boolean).map((item) => path.resolve(item)))]
    : [];
  return {
    document: {
      projects: projects.map((entry) => ({
        id: entry.id,
        businessLine: entry.businessLine,
        platform: entry.platform,
        workspaceRoot: entry.workspaceRoot,
        ...(entry.skillRoots?.length ? { skillRoots: [...entry.skillRoots] } : {}),
        ...(entry.tapd ? { tapd: { ...entry.tapd } } : {}),
        ...(entry.enabled === false ? { enabled: false } : {}),
      })),
      operators,
      ...(skillRoots.length ? { skillRoots } : {}),
      ...(source.allowWorkspaceSkillRoots === true ? { allowWorkspaceSkillRoots: true } : {}),
    },
    valid: operatorValidation.valid && !source.configError,
    errors: [
      ...(text(source.configError) ? [text(source.configError)] : []),
      ...operatorValidation.errors,
    ],
  };
}

export function writeReleaseProjectsDocument(filePath, raw = {}) {
  const target = path.resolve(text(filePath));
  if (!target) throw new Error("release-projects file path is required");
  const normalized = normalizeReleaseProjectsDocument(raw);
  if (!normalized.valid) throw new Error(normalized.errors.join("; ") || "invalid release-projects document");
  for (const project of normalized.document.projects) {
    if (!project.workspaceRoot || !path.isAbsolute(project.workspaceRoot)) {
      throw new Error(`project ${project.id || "(missing id)"} workspaceRoot must be an absolute path`);
    }
    for (const skillRoot of project.skillRoots || []) {
      if (!path.isAbsolute(skillRoot)) {
        throw new Error(`project ${project.id} skillRoots must be absolute paths`);
      }
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(normalized.document, null, 2)}\n`, "utf8");
  return normalized.document;
}

/**
 * 用户需求点: 线上发版的工程与 Skill 根目录必须由服务端配置拥有，不能依赖开发机路径或浏览器输入。
 * @param {NodeJS.ProcessEnv|object} env
 * @param {{ defaultFilePath?: string }} [options]
 * @returns {{projects: object[], skillRoots: string[], allowWorkspaceSkillRoots: boolean, allowServerWorkspace: boolean, configError: string, operators: object, projectsFilePath: string, projectsSource: string}}
 */
export function readReleaseDeploymentConfig(env = process.env, options = {}) {
  const envObject = env && typeof env === "object" ? env : {};
  let projectsSource = "none";
  let projectsFilePath = "";
  let raw = parseJson(envObject.AGENTFLOW_RELEASE_PROJECTS_JSON, "AGENTFLOW_RELEASE_PROJECTS_JSON");
  if (text(envObject.AGENTFLOW_RELEASE_PROJECTS_JSON) && !raw.configError) projectsSource = "env-json";
  if (!raw.configError && !text(envObject.AGENTFLOW_RELEASE_PROJECTS_JSON) && text(envObject.AGENTFLOW_RELEASE_PROJECTS_FILE)) {
    projectsFilePath = path.resolve(String(envObject.AGENTFLOW_RELEASE_PROJECTS_FILE));
    try {
      raw = parseJson(fs.readFileSync(projectsFilePath, "utf8"), "AGENTFLOW_RELEASE_PROJECTS_FILE");
      if (!raw.configError) projectsSource = "env-file";
    } catch (error) {
      raw = { configError: `AGENTFLOW_RELEASE_PROJECTS_FILE cannot be read: ${error?.message || String(error)}` };
    }
  }
  // 用户需求点: 未设 env 时读取数据根下的 release-projects.json（设置页写入）；文件不存在不算错误。
  if (!raw.configError && !text(envObject.AGENTFLOW_RELEASE_PROJECTS_JSON) && !text(envObject.AGENTFLOW_RELEASE_PROJECTS_FILE)) {
    const defaultFile = text(options?.defaultFilePath);
    if (defaultFile) {
      projectsFilePath = path.resolve(defaultFile);
      if (fs.existsSync(projectsFilePath)) {
        try {
          raw = parseJson(fs.readFileSync(projectsFilePath, "utf8"), RELEASE_PROJECTS_FILENAME);
          if (!raw.configError) projectsSource = "data-root-file";
        } catch (error) {
          raw = { configError: `${RELEASE_PROJECTS_FILENAME} cannot be read: ${error?.message || String(error)}` };
        }
      }
    }
  }
  let projects = projectsFromJson(raw).filter((entry) => entry.enabled !== false);
  // 用户需求点: 本地 npm run dev 应默认连接 likee Android 测试发版工程，重试节点时不能因服务端根目录不同而被 allowlist 拒绝。
  // 仅限开发+测试模式且本机目录确实存在；线上和普通测试仍必须显式配置项目 allowlist。
  const isDevTest = text(envObject.AGENTFLOW_DEV) === "1" && text(envObject.AGENTFLOW_RELEASE_TEST_MODE) === "1";
  if (!raw.configError && !projects.length && isDevTest && fs.existsSync(LOCAL_DEV_RELEASE_ROOT)) {
    projects = [normalizeProject({
      id: "likee-android-local",
      businessLine: "likee",
      platform: "android",
      workspaceRoot: LOCAL_DEV_RELEASE_ROOT,
      skillRoots: LOCAL_DEV_RELEASE_SKILL_ROOTS,
    })].filter(Boolean);
  }
  let operators = normalizeReleaseOperators(raw.operators);
  if (!raw.configError && !Object.keys(operators).length && isDevTest) {
    operators = normalizeReleaseOperators(DEFAULT_DEV_OPERATORS);
  }
  const operatorValidation = validateReleaseOperators(operators);
  const skillRoots = [
    ...splitPaths(envObject.AGENTFLOW_RELEASE_SKILLS_ROOT),
    ...(Array.isArray(raw.skillRoots) ? raw.skillRoots.map((item) => text(item)).filter(Boolean).map((item) => path.resolve(item)) : []),
  ];
  const isTestMode = text(envObject.AGENTFLOW_RELEASE_TEST_MODE) === "1";
  const isProduction = normalized(envObject.NODE_ENV) === "production";
  return {
    projects,
    operators,
    skillRoots: [...new Set(skillRoots)],
    allowWorkspaceSkillRoots: raw.allowWorkspaceSkillRoots === true,
    // 未设置 NODE_ENV=production 时兼容 node --test 与本地开发；线上必须显式配置项目 allowlist。
    allowServerWorkspace: text(envObject.AGENTFLOW_RELEASE_ALLOW_SERVER_WORKSPACE) === "1" || (!isProduction && projects.length === 0),
    configError: text(raw.configError) || (operatorValidation.valid ? "" : operatorValidation.errors.join("; ")),
    production: isProduction,
    projectsFilePath,
    projectsSource,
  };
}

function pathMatches(a, b) {
  return Boolean(a && b && path.resolve(a) === path.resolve(b));
}

/**
 * 用户需求点: 发版请求只能选择业务线+平台对应的 allowlist 工程；workspacePath 仅用于本地测试，线上不接受任意绝对路径。
 */
export function resolveReleaseWorkspace(config, context = {}, requestedId = "", requestedPath = "", fallbackRoot = "") {
  const businessLine = normalized(context.businessLine);
  const platform = normalized(context.platform) === "iphone" ? "ios" : normalized(context.platform);
  const candidates = (Array.isArray(config?.projects) ? config.projects : [])
    .filter((entry) => entry.businessLine === businessLine && entry.platform === platform);
  const id = text(requestedId);
  const candidateById = id ? candidates.find((entry) => entry.id === id) : null;
  if (id && !candidateById && candidates.length > 0) {
    // 发版页可能误传知识库工作区 id（ws_*）；唯一配置工程时自动映射到发版工程。
    if (candidates.length === 1 && /^ws_/i.test(id)) {
      const only = candidates[0];
      return { ok: true, workspaceId: only.id, workspaceRoot: only.workspaceRoot, project: only, remappedFromWorkspaceId: id };
    }
    // 显式 AGENTFLOW_RELEASE_SKILLS_ROOT（测试/隔离）可在未匹配 project id 时落到服务端 workspace。
    if (!config?.production && (Array.isArray(config?.skillRoots) ? config.skillRoots : []).length && fallbackRoot) {
      return { ok: true, workspaceId: id || "release-workspace", workspaceRoot: path.resolve(fallbackRoot), project: null };
    }
    const validIds = candidates.map((entry) => entry.id).join("、");
    return { ok: false, status: 403, code: "RELEASE_WORKSPACE_NOT_ALLOWED", error: `工作区不属于当前业务线和平台，请使用发版工程：${validIds}` };
  }
  const requested = text(requestedPath);
  if (requested) {
    if (config?.production) {
      return { ok: false, status: 403, code: "RELEASE_WORKSPACE_PATH_FORBIDDEN", error: "线上发版只允许提交 workspaceId，workspacePath 由服务端配置" };
    }
    const requestedResolved = path.resolve(requested);
    const matched = candidates.find((entry) => pathMatches(entry.workspaceRoot, requestedResolved));
    if (matched && (!id || matched.id === id)) return { ok: true, workspaceId: matched.id, workspaceRoot: matched.workspaceRoot, project: matched };
    if (matched && id && matched.id !== id) {
      return { ok: false, status: 403, code: "RELEASE_WORKSPACE_NOT_ALLOWED", error: "workspaceId 与 workspacePath 不匹配" };
    }
    if (!candidates.length && config?.allowServerWorkspace && fallbackRoot && pathMatches(fallbackRoot, requestedResolved)) {
      return { ok: true, workspaceId: id || "release-workspace", workspaceRoot: path.resolve(fallbackRoot), project: null };
    }
    return { ok: false, status: 403, code: "RELEASE_WORKSPACE_NOT_ALLOWED", error: "workspacePath 不在发版工程 allowlist 中" };
  }
  if (candidateById) return { ok: true, workspaceId: candidateById.id, workspaceRoot: candidateById.workspaceRoot, project: candidateById };
  if (!id && candidates.length === 1) {
    const only = candidates[0];
    return { ok: true, workspaceId: only.id, workspaceRoot: only.workspaceRoot, project: only };
  }
  if (!candidates.length && config?.allowServerWorkspace && fallbackRoot) {
    return { ok: true, workspaceId: id || "release-workspace", workspaceRoot: path.resolve(fallbackRoot), project: null };
  }
  if (config?.configError) return { ok: false, status: 503, code: "RELEASE_DEPLOYMENT_CONFIG_INVALID", error: config.configError };
  return { ok: false, status: 503, code: "RELEASE_WORKSPACE_NOT_CONFIGURED", error: "当前业务线和平台尚未配置发版工程" };
}

/**
 * 用户需求点: Skill 仓库可以独立于产品工程部署，且客户端不能覆盖服务端指定的 Skill 根目录。
 */
export function releaseSkillRoots(config, project = null, workspaceRoot = "") {
  const explicit = [
    ...(Array.isArray(config?.skillRoots) ? config.skillRoots : []),
    ...(Array.isArray(project?.skillRoots) ? project.skillRoots : []),
  ].filter(Boolean).map((item) => path.resolve(String(item)));
  if (explicit.length) return [...new Set(explicit)];
  if (config?.allowWorkspaceSkillRoots && workspaceRoot) {
    return [
      path.join(path.resolve(workspaceRoot), ".workspace", "release-skills"),
      path.join(path.resolve(workspaceRoot), ".workspace", "release-skills-google-play-aab"),
    ].filter((entry) => fs.existsSync(entry));
  }
  return [];
}

/** 用户需求点: release-skills 必须来自显式配置（知识库/部署目录），禁止静默回退到产品工程下的 .workspace。 */
export function assertReleaseSkillRootsConfigured(config, project = null, workspaceRoot = "") {
  const roots = releaseSkillRoots(config, project, workspaceRoot);
  if (roots.length) return { ok: true, roots };
  return {
    ok: false,
    status: 503,
    code: "RELEASE_SKILLS_NOT_CONFIGURED",
    error: "未配置 release-skills 根目录。请在发版工程配置 skillRoots 或设置 AGENTFLOW_RELEASE_SKILLS_ROOT（知识库中的 release-skills 目录）。",
  };
}
