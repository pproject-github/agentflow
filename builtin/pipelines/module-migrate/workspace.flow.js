import { agent, control, display, flow, provide, tool } from "agentflow/flow";

// ── 输入：原来这些值硬编码在节点正文里，现在提到引脚上 ──────────────
const repoRoot = provide.str("仓库根目录", {
  value: ".",
});
const sourcePath = provide.str("待迁移的源码路径", {
  value: "app/src/main/java/com/example/push/",
});
const moduleName = provide.str("新模块名", {
  value: "module-push",
});
const rules = provide.str("模块规范文档", {
  value: ".cursor/rules/android-module-structure.mdc、.cursor/rules/module-main-sub-dependency.mdc",
});

// ══ ① 定范围 ════════════════════════════════════════════════════════
const scope = agent.subAgent("确定迁移范围", {}, `参照 ${rules.value}，确定 ${sourcePath.value} 的迁移范围。仓库根目录 ${repoRoot.value}。

**只定范围，不动任何文件。**

回复正文就是要迁的文件清单，每行一个仓库相对路径，不要标题、不要编号、不要别的话——下游脚本按行解析。`);

const showScope = display.markdown("迁移范围（确认后点②）", { content: scope.result });

export const scopeRun = flow("① 定范围", scope, showScope);

// ══ ② 建模块并迁移 ══════════════════════════════════════════════════
const newModule = agent.subAgent("新建模块", {}, `参照 ${rules.value}，在 ${repoRoot.value} 下新建模块 ${moduleName.value}，同时建出配套的 ${moduleName.value}_api。

按规范补齐 build.gradle、settings.gradle 注册、包结构。`);

const migrate = agent.subAgent("执行迁移", {}, `按清单迁移到 ${moduleName.value}：

${scope.result}

**只搬代码和资源，不改业务逻辑。** 可以并行分派多个 agent，但只做搬运，不做检查。

回复正文是迁移后的文件清单，每行一个仓库相对路径，格式同上。`);

// ── 静态检查：脚本查一遍，AI 再查一遍，两个判定用脚本合成一个 bool ──
const staticCheck = tool.nodejs("静态引用检查", {
  repoRoot: repoRoot.value,
  before: scope.result,
  after: migrate.result,
}, `node ${flowDir}/scripts/static-check.mjs ${repoRoot} ${before} ${after} ${ok} ${report}`);
const { ok: staticOk, report: staticReport } = staticCheck;

const aiCheck = agent.subAgent("AI 交叉检查", {}, `迁移前清单：

${scope.result}

迁移后清单：

${migrate.result}

脚本侧的静态检查结果：

${staticReport}

参照 ${rules.value}，检查主模块是否还直接依赖被迁走的类。逐条列出需要改成 API 中转的位置（\`文件:行号 -> 全限定类名\`）。

**回复正文第一行必须只有 \`true\` 或 \`false\`**：脚本和你自己都没查出问题写 true，任一有问题写 false。第二行起写明细。`);

const verdict = tool.nodejs("合成静态检查结论", {
  scriptOk: staticOk,
  aiVerdict: aiCheck.result,
}, `node ${flowDir}/scripts/gate.mjs ${scriptOk} ${aiVerdict} ${ok} ${report}`);
const { ok: verdictOk, report: verdictReport } = verdict;

// ── 静态一次过：直接编译 ────────────────────────────────────────────
// 「逐个编译、失败就修、修完重编」是节点内部的迭代，不是图上的环——图不支持环，
// 而 agent 本来就能在一个节点里循环。原来那圈 anyOne + toBool + if 就是在图上
// 表达本该在节点里表达的东西。
const buildA = agent.subAgent("编译并修到通过", {}, `在 ${repoRoot.value} 用 gradle 列出 Java / Kotlin 的 debug 编译任务，**串行**逐个执行，一次一个，不要一把梭。

失败就当场修（参照 ${rules.value}，缺的依赖走 _api 模块中转，不要把实现类重新暴露给主模块），修完重编该任务，直到全过或确实卡住。

回复正文第一行只写 \`true\`（全部通过）或 \`false\`（有卡住的），第二行起写任务清单和失败详情。`);

const buildOkA = control.agentToBool("编译全过了吗", { value: buildA.result }, `上游正文第一行是 true 或 false。**只回 true 或 false 这一个词**，多一个字都会被判成 false。`);

const docA = agent.subAgent("输出迁移文档", {}, `把这次迁移写成文档：范围、改了什么、主模块改成 API 中转的位置、遗留问题。

范围：${scope.result}

编译结果：${buildA.result}`);
const showDocA = display.markdown("迁移文档", { content: docA.result });
const buildStuckA = display.markdown("编译卡住，需要人工介入", { content: buildA.result });

const gateBuildA = control.if("编译过了吗", { prediction: buildOkA.prediction },
  flow(docA, showDocA),
  flow(buildStuckA),
);

// ── 静态没过：修一轮，再查一轮。没有循环原语，就展开成固定两轮 ──────
const fix1 = agent.subAgent("修引用", {}, `静态检查没过。

${verdictReport}

脚本报告：
${staticReport}

AI 检查：
${aiCheck.result}

参照 ${rules.value}，把主模块里直接用到被迁类的地方改成走 SPI（对应的 _api 模块）中转。一次批量处理多条，改完自检一遍。`);

const staticCheck2 = tool.nodejs("静态引用复查", {
  repoRoot: repoRoot.value,
  before: scope.result,
  after: migrate.result,
}, `node ${flowDir}/scripts/static-check.mjs ${repoRoot} ${before} ${after} ${ok} ${report}`);
const { ok: staticOk2, report: staticReport2 } = staticCheck2;

const aiCheck2 = agent.subAgent("AI 复查", {}, `修完一轮了。脚本侧复查结果：

${staticReport2}

参照 ${rules.value} 再查一遍主模块对被迁类的直接依赖。

**回复正文第一行必须只有 \`true\` 或 \`false\`。**`);

const verdict2 = tool.nodejs("合成复查结论", {
  scriptOk: staticOk2,
  aiVerdict: aiCheck2.result,
}, `node ${flowDir}/scripts/gate.mjs ${scriptOk} ${aiVerdict} ${ok} ${report}`);
const { ok: verdictOk2, report: verdictReport2 } = verdict2;

// 修过一轮之后的编译链。和上面那条是两条独立的链——分支不能汇合，fan-in 是禁止的
const buildB = agent.subAgent("编译并修到通过（修过一轮）", {}, `在 ${repoRoot.value} 用 gradle 列出 Java / Kotlin 的 debug 编译任务，**串行**逐个执行。

失败就当场修（参照 ${rules.value}，走 _api 模块中转），修完重编，直到全过或确实卡住。

回复正文第一行只写 \`true\` 或 \`false\`，第二行起写清单和详情。`);

const buildOkB = control.agentToBool("编译全过了吗（修过一轮）", { value: buildB.result }, `上游正文第一行是 true 或 false。**只回 true 或 false 这一个词**，多一个字都会被判成 false。`);

const docB = agent.subAgent("输出迁移文档（修过一轮）", {}, `把这次迁移写成文档：范围、改了什么、主模块改成 API 中转的位置、遗留问题。

范围：${scope.result}

修复记录：${fix1.result}

编译结果：${buildB.result}`);
const showDocB = display.markdown("迁移文档", { content: docB.result });
const buildStuckB = display.markdown("编译卡住，需要人工介入", { content: buildB.result });

const gateBuildB = control.if("编译过了吗（修过一轮）", { prediction: buildOkB.prediction },
  flow(docB, showDocB),
  flow(buildStuckB),
);

const staticStuck = display.markdown("两轮静态检查仍未通过，需要人工介入", { content: verdictReport2 });

const gate2 = control.if("第二轮静态检查", { prediction: verdictOk2 },
  flow(buildB, buildOkB, gateBuildB),
  flow(staticStuck),
);

const gate1 = control.if("第一轮静态检查", { prediction: verdictOk },
  flow(buildA, buildOkA, gateBuildA),
  flow(fix1, staticCheck2, aiCheck2, verdict2, gate2),
);

export const migrateRun = flow(
  "② 建模块并迁移",
  newModule, migrate, staticCheck, aiCheck, verdict, gate1,
);

// 人工闸门：范围确认过了再点②
flow.resume(showScope, migrateRun);
