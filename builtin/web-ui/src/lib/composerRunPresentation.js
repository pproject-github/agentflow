export function stripAgentflowReceipt(value) {
  return String(value || "")
    .replace(/---agentflow\b[\s\S]*?---end\b/gi, "")
    .replace(/^\s*resultFile\s*:\s*\S+\s*$/gim, "")
    .trim();
}
