# Quickstart: Automate Your PR Workflow with AgentFlow

> **Story**: How I tamed the chaotic PR review process and achieved 100% reliable execution.

## The Pain: "AI Sometimes Forgets Steps"

As a developer who cares about code quality, I wanted to automate our team's PR workflow:

```
1. Submit code → 2. Code Review → 3. Generate PR → 4. Notify team via Slack
```

I tried using **Skills** or custom **Commands** to define this flow. **Most of the time it worked**, but occasionally:

- ❌ AI skipped the code review step
- ❌ PR description was generated without running tests
- ❌ Team notification went out before the PR was actually created
- ❌ When errors occurred, I had to start from scratch

**The root cause**: AI dialogue is inherently unstable. Even with clear instructions, the model might "forget" steps when context gets long or when errors occur. There's no runtime enforcement—just hope the model remembers.

## The AgentFlow Solution: "Define Once, Execute Reliably"

AgentFlow treats your workflow as a **graph with explicit dependencies**, not a conversation. The AI executes each node independently, and the **runtime**—not the model—ensures the flow proceeds correctly.

### Step 1: Describe in AI Composer

In the Web UI Composer input box, I typed:

```
Create a PR workflow:
1. Scan changed files from git diff
2. Run code review on each changed file
3. Generate PR title and description
4. Create GitHub PR
5. Send Slack notification to team
```

### Step 2: Review & Adjust

AI generated a flow with 5 nodes. I made a few adjustments:

1. **Added `control_if` node**: Skip notification if no changes detected
2. **Changed review node to `agent_subAgent`**: Better quality for code analysis
3. **Added `tool_print` node**: Display the PR link prominently

Here's what the final flow looks like:

```
control_start
    ↓
git_diff_scan
    ↓
review_loop (control_anyOne for each file)
    ↓
generate_pr_content
    ↓
create_github_pr
    ↓
control_if (has changes?)
   ↙     ↘
 yes      no
  ↓        ↓
slack_notify  control_end
  ↓
control_end
```

### Step 3: Run & Relax

```bash
# Apply the flow
agentflow apply prsrc

# If any step fails, resume from that exact point
agentflow resume prsrc <uuid>
```

**Now every PR follows the exact same steps, every single time:**

- ✅ Code review **never** skipped
- ✅ Tests **always** run before PR creation
- ✅ Notification **only** sent after PR exists
- ✅ If any step fails, **resume from that point** (not from scratch)

## Why AgentFlow Wins

| Approach | Stability | Recovery | Visibility | Learning Curve |
|----------|-----------|----------|------------|----------------|
| Skills/Commands | ~80% | Start over | Opaque | Low |
| **AgentFlow** | **100%** | **Checkpoint resume** | **Every step logged** | Medium |

## The flow.yaml

Here's a simplified version of the resulting `flow.yaml`:

```yaml
instances:
  start:
    definitionId: control_start
    label: Start
  git_diff:
    definitionId: tool_nodejs
    label: Scan Git Changes
    script: git diff --name-only HEAD~1
  review_each:
    definitionId: agent_subAgent
    label: Code Review
    body: Review the changed file for potential issues...
  generate_pr:
    definitionId: agent_subAgent
    label: Generate PR Description
    body: Create a clear PR title and description...
  create_pr:
    definitionId: tool_nodejs
    label: Create GitHub PR
    script: gh pr create --title "${title}" --body "${body}"
  has_changes:
    definitionId: control_toBool
    label: Has Changes?
    value: ${git_diff.result}
  if_changes:
    definitionId: control_if
    label: If Has Changes
  slack_notify:
    definitionId: tool_nodejs
    label: Slack Notification
    script: curl -X POST $SLACK_WEBHOOK -d '{"text":"PR created: ${pr_url}"}'
  end:
    definitionId: control_end
    label: End

edges:
  - source: start
    target: git_diff
  - source: git_diff
    target: review_each
  - source: review_each
    target: generate_pr
  - source: generate_pr
    target: create_pr
  - source: create_pr
    target: has_changes
  - source: has_changes
    target: if_changes
    sourceHandle: output-1
    targetHandle: input-1
  - source: if_changes
    target: slack_notify
    sourceHandle: output-0
  - source: if_changes
    target: end
    sourceHandle: output-1
  - source: slack_notify
    target: end

ui:
  nodePositions:
    start: { x: 400, y: 50 }
    git_diff: { x: 400, y: 150 }
    review_each: { x: 400, y: 250 }
    generate_pr: { x: 400, y: 350 }
    create_pr: { x: 400, y: 450 }
    has_changes: { x: 400, y: 550 }
    if_changes: { x: 400, y: 650 }
    slack_notify: { x: 250, y: 750 }
    end: { x: 400, y: 850 }
```

## Try It Yourself

### Option 1: Use AI Composer (Recommended)

1. Run `agentflow ui`
2. Click **New Pipeline**
3. In the Composer box, type:
   ```
   Create a PR workflow that scans git changes, reviews code,
   creates a PR, and notifies the team
   ```
4. Review the generated flow and adjust as needed
5. Click **Save** and **Run**

### Option 2: Start from Template

```bash
# List built-in pipelines
agentflow list

# Create from template (if available)
agentflow create pr-workflow
```

## What's Next?

Once you've mastered the PR workflow, try these advanced patterns:

- **Loop & Fix**: Automatically fix issues found during code review
- **Parallel Review**: Review multiple files in parallel
- **Scheduled Checks**: Run code quality checks on a schedule

See [Module Migration Workflow](module-migration-workflow.en.md) for more complex examples.
