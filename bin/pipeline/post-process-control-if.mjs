#!/usr/bin/env node
/**
 * 已移除对 control_if_true、control_if_false 的支持；分支判断仅由 control_if 写 branch，get-ready-nodes 按 branch 解锁后继。
 * 本脚本保留为 no-op，避免主流程调用时报错。
 * 用法：node post-process-control-if.mjs <workspaceRoot> <flowName> <uuid> <instanceId>
 * 输出（stdout JSON）：{ "ok": true }
 */

function main() {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "Usage: node post-process-control-if.mjs <workspaceRoot> <flowName> <uuid> <instanceId>",
      }),
    );
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true }));
}

main();
