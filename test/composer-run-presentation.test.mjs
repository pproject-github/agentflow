import assert from "node:assert/strict";
import test from "node:test";

import { stripAgentflowReceipt } from "../builtin/web-ui/src/lib/composerRunPresentation.js";

test("Run result hides the internal AgentFlow receipt while preserving useful prose", () => {
  assert.equal(
    stripAgentflowReceipt("已完成页面生成。\n\n---agentflow\nresultFile: outputs/result.html\n---end"),
    "已完成页面生成。",
  );
  assert.equal(
    stripAgentflowReceipt("---agentflow resultFile: outputs/result.html\n\n---end"),
    "",
  );
});
