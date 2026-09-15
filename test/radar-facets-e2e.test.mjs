import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 端到端：两条流程，一块板，状态**全部由流水线产出**。
 *
 * 这一点是这个用例的全部意义。单测能证明父子汇总、owns 拒收、缺席判定各自成立，
 * 证明不了「子流程读到父表之后，自己决定拆几条子任务并写回去」这条链是通的——
 * 中间隔着 radar.readShard 的跨片只读、提示词、agent 的文件写入、CLI 校验、
 * owns 拒收。任何一环断了，板上看到的都会是**手工造出来的状态**，而不是流程产出的。
 *
 * 所以这里不预置任何子项：父表由第一条流程写，子任务由第二条流程自己拆。
 * 跑真实 agent（默认 cursor），默认跳过：
 *   AGENTFLOW_E2E=1 node --test test/radar-facets-e2e.test.mjs
 */
const RUN_E2E = process.env.AGENTFLOW_E2E === "1";
const BOARD = "gpe2e";

/** 一个假的 Likee 仓库：两条要求都查得出结论，且都不是「满足」 */
function seedRepo(dir) {
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app", "build.gradle"), [
    "android {",
    "    compileSdk 35",
    "    defaultConfig {",
    "        applicationId 'video.like'",
    "        minSdk 21",
    "        targetSdk 34",
    "    }",
    "    ndkVersion '21.4.7075529'",
    "}",
    "dependencies {",
    "    implementation 'com.example:effect-one:3.2.0'",
    "    implementation 'com.example:codec:1.9.4'",
    "}",
  ].join("\n"), "utf-8");
  fs.mkdirSync(path.join(dir, "app", "src", "main"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app", "src", "main", "AndroidManifest.xml"), [
    "<manifest package=\"video.like\">",
    "  <application android:label=\"Likee\" />",
    "</manifest>",
  ].join("\n"), "utf-8");
}

test("e2e：子流程读父表、自己拆子任务、写回板，owns 与缺席全程由契约管", { skip: !RUN_E2E, timeout: 1_200_000 }, async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-facet-e2e-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  try {
    const [{ commitTrack }, radar, { parseFlowSource }, { irToGraph }, { runWorkspaceGraph }] = await Promise.all([
      import("../bin/lib/radar-cli.mjs"),
      import("../bin/lib/radar.mjs"),
      import("../bin/lib/flow-dsl/parser.mjs"),
      import("../bin/lib/flow-dsl/ir.mjs"),
      import("../bin/lib/workspace-server.mjs"),
    ]);

    // ---- 板 + 父表。父表是第一条流程的产出，这里直接给定它的结果 ----
    radar.createRadarBoard(BOARD, { title: "政策 e2e" });
    commitTrack({
      board: BOARD,
      flowId: "policy-watch",
      owns: ["pol-*"],
      rows: [
        {
          id: "pol-16kb",
          title: "Google 要求 target API 35+ 应用支持 16KB 内存页",
          required: "所有 native 库按 16KB page size 对齐；NDK r28 起默认满足",
          due: "2027-01-31",
          state: "idle",
        },
        {
          id: "pol-target-api-35",
          title: "存量应用 targetSdk 必须 >= 35",
          required: "app/build.gradle 里 targetSdk >= 35",
          due: "2026-08-31",
          state: "idle",
        },
      ],
    });

    const boardDir = radar.radarBoardDir(BOARD);
    const trackersDir = path.join(boardDir, "trackers", "likee");
    fs.mkdirSync(trackersDir, { recursive: true });
    const repoDir = path.join(tempRoot, "likee-android");
    seedRepo(repoDir);

    // 跨片读是**图上的一条边**（radar.readShard），不是藏在命令行里的一次 CLI 调用
    const source = `import { agent, flow, radar, tool } from "agentflow/flow";

const policy = radar.readShard("读政策片", { board: "${BOARD}", shard: "policy-watch" });

const work = agent.subAgent("梳理 Likee 适配", { policy: policy.rows }, \`你负责回答 Likee Android 这一个端**适配到哪一步**。

上游政策表在输入 policy 里，是一段 JSON：{ rows: [{ id, title, required, due }] }。
Likee 的代码库在 ${repoDir}/。

对每一条政策，去代码库查证，然后**自己决定要拆成几条子任务**——满足了就写一条结论，
没满足就按真正要做的事拆开。每条子任务写一个文件到 ${trackersDir}/，
**文件名是「id 加 .md」，必须带 .md 后缀**（例如 pol-16kb-ndk@likee.md）：

---
id: <政策id>-<你起的短名>@likee
parent: <政策id>
app: likee
tags: [<给这条打 1-3 个标签，从这些里挑：android16 / aep / native / manifest / console>]
title: <这条子任务要做什么>
state: <ok 已满足 / warn 在做或部分满足 / risk 没做且有截止日 / unknown 查不出来>
current: "<一句话说明代码里现在是什么样，带文件路径>"
evidence: "<文件路径:行号>"
---

正文里写你是怎么查的。

硬要求：
- id 必须以 @likee 结尾，文件名是 id 加 .md；parent 必须是上游政策表里真实存在的 id。
- state 只能是 ok / warn / risk / unknown，不要写中文。
- 查不出来写 unknown，**不要**默认写成 ok。
- current / evidence 的值里有冒号、井号或引号时，整个值必须用双引号包起来，否则 YAML 解析不了、这一轮一条都写不进去。
- 每条政策至少写一条子任务；确实要做多件事时就拆多条，不要塞进一条。
- tags 至少一个，只能从上面那五个里挑，不要自造。要靠它做分类，拼法不一致就分不到一起。\`);

const sync = tool.nodejs(
  "同步回板",
  { after: work.result },
  \`agentflow track sync --board=${BOARD} --flow=likee-compliance --dir=${trackersDir} --owns='*@likee' --covers='pol-*' --flow-ref=likee-compliance\`,
);

export const run = flow("Run", policy, work, sync);
`;

    const flowDir = path.join(tempRoot, "flow");
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(flowDir, "workspace.flow.js"), source, "utf-8");

    const ir = parseFlowSource(source);
    assert.deepEqual(ir.unresolved, [], "流程源码里有解析不出来的引用");
    assert.equal(ir.nodes.policy.definitionId, "radar_read_shard", "跨片读要是一个真的节点");
    const graph = irToGraph(ir);

    const events = [];
    const result = await runWorkspaceGraph(flowDir, flowDir, {
      graph,
      runNodeId: "run",
      runId: `facet-e2e-${process.pid}`,
      ignoreCache: true,
    }, { userId: "facet-e2e" }, { onEvent: (event) => events.push(event) });

    const failed = events.filter((event) => event.type === "node-done" && event.status === "failed");
    assert.deepEqual(failed.map((event) => event.nodeId), [], `有节点失败：${JSON.stringify(failed, null, 2)}`);
    assert.deepEqual(result.pauseNodeIds || [], []);

    const board = radar.readRadarBoard(BOARD, { scope: "all" });
    if (process.env.AGENTFLOW_E2E_DUMP === "1") {
      for (const row of board.rows) {
        console.log(`  ${String(row.id).padEnd(34)} ${String(row.state).padEnd(7)} ${row.parent ? "↳ " : ""}${row.title}`);
        if (row.current) console.log(`      ${row.current}`);
      }
    }

    // ---- 子任务确实是流程产出的，而且挂在父项下 ----
    const facets = board.rows.filter((row) => String(row.parent || ""));
    assert.ok(facets.length >= 2, `子任务太少，流程没真的梳理：${board.rows.map((row) => row.id).join(", ")}`);
    for (const facet of facets) {
      assert.ok(String(facet.id).endsWith("@likee"), `子任务 id 不合契约：${facet.id}`);
      assert.equal(facet.flowId, "likee-compliance", "子任务必须来自 Likee 那一片");
      assert.ok(board.rows.some((row) => row.id === facet.parent), `孤儿子项：${facet.id}`);
      assert.ok(String(facet.current || "").trim(), `${facet.id} 没写现状，等于没给结论`);
    }

    // 两条政策都要被回答——漏一条和「查不出来」是两回事
    const answered = new Set(facets.map((row) => String(row.parent)));
    assert.deepEqual([...answered].sort(), ["pol-16kb", "pol-target-api-35"]);

    // targetSdk 34 < 35，不可能满足。判成 ok 说明它没真去看代码
    const sdkKids = facets.filter((row) => row.parent === "pol-target-api-35");
    assert.ok(
      sdkKids.every((row) => row.state !== "ok"),
      `代码里是 targetSdk 34，不该判成已满足：${sdkKids.map((row) => row.current).join(" / ")}`,
    );

    // ---- tag 是流程自己打的，而且能拿来分组 ----
    const KNOWN = new Set(["android16", "aep", "native", "manifest", "console"]);
    for (const facet of facets) {
      assert.ok((facet.tags || []).length, `${facet.id} 没打标签`);
      for (const tag of facet.tags) assert.ok(KNOWN.has(tag), `${facet.id} 自造了标签 ${tag}`);
    }
    // 至少有一个标签被多条子任务共用——否则「按标签分类」这件事没有意义
    const tagCount = new Map();
    for (const facet of facets) for (const tag of facet.tags) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
    assert.ok([...tagCount.values()].some((count) => count >= 2), `每个标签只用了一次，分不出类：${[...tagCount]}`);

    // ---- 人的图层：认领和贴标签都落在覆盖层，流程重写整片也冲不掉 ----
    const target = facets[0];
    radar.setRadarItemOverride(BOARD, target.id, { owner: "wangfang1", addTags: ["需要人跟"], by: "wangfang1" });
    const afterHuman = radar.readRadarBoard(BOARD, { scope: "all" }).rows.find((row) => row.id === target.id);
    assert.equal(afterHuman.owner, "wangfang1");
    assert.ok(afterHuman.tags.includes("需要人跟"), "人贴的标签要和流程打的并存");
    assert.ok(afterHuman.tags.some((tag) => KNOWN.has(tag)), "流程打的标签不能被人贴的挤掉");
    assert.equal(afterHuman.overrideConflict, false, "贴标签、认领都不算和扫描结果矛盾");

    // ---- 父行汇总：读的时候算，不回写任何分片 ----
    const parent = board.rows.find((row) => row.id === "pol-target-api-35");
    assert.equal(parent.rolledUp, true, "父行没有被子项推导");
    assert.equal(
      radar.readRadarShard(BOARD, "policy-watch").rows.find((row) => row.id === "pol-target-api-35").state,
      "idle",
      "汇总只能发生在读的时候，不能回写政策片",
    );

    // ---- 缺席由 covers 契约反推，和业务维度无关 ----
    assert.equal(parent.missingFacets, undefined, "likee 那一片写了，不该算缺席");
    commitTrack({
      board: BOARD,
      flowId: "bigolive-compliance",
      owns: ["*@bigolive"],
      covers: ["pol-*"],
      rows: [{ id: "placeholder@bigolive", title: "占位，不挂任何父项", state: "idle" }],
    });
    const withBigo = radar.readRadarBoard(BOARD, { scope: "all" });
    assert.deepEqual(
      withBigo.rows.find((row) => row.id === "pol-16kb").missingFacets,
      ["bigolive-compliance"],
      "声明了 covers 却一条子项都没写，就是缺席",
    );

    // ---- owns 在真实链路上确实拒收越界 ----
    assert.throws(
      () => commitTrack({
        board: BOARD,
        flowId: "likee-compliance",
        rows: [{ id: "pol-16kb", title: "抢政策行", state: "ok" }],
      }),
      /越界/,
      "likee 那一片应当写不了 pol-* 的父项",
    );
    assert.deepEqual(board.conflicts, [], "两条流程写同一块板不该产生冲突");
  } finally {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
