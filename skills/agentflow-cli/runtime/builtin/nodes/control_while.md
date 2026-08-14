---
# 内置节点：While 单步推进
runtime: native
description: |
  Repeatedly execute either an explicit Condition/Body subflow pair or one legacy deterministic
  step command (`script` or `scriptRef`) without adding a cycle to the Workspace graph. A Run
  restarted after `wait` resumes from the saved output state.

  Preferred DSL form:
  `control.while("Advance", { state, maxIterations, timeout }, conditionFlow, bodyFlow)`.
  Condition must accept `state` and `iteration`, and return `decision` plus optional `summary`.
  Only `continue` invokes Body. Body must accept `state`, `iteration`, and `idempotencyKey`, and
  return the next `state` plus optional `summary`. `wait`, `done`, and `fail` skip Body.

  In legacy script mode, the command runs once per iteration and stdout must be exactly one JSON object:
  `{"decision":"continue|wait|done|fail","state":{},"summary":"..."}`.
  `continue` starts another iteration, `wait` pauses this Run before downstream nodes, `done`
  continues downstream, and `fail` fails the node. A missing `state` keeps the previous state.

  Each step receives `AGENTFLOW_WHILE_STATE` (JSON), the absolute
  `AGENTFLOW_WHILE_ITERATION`, `AGENTFLOW_WHILE_MAX_ITERATIONS`,
  `AGENTFLOW_WHILE_TIMEOUT_MS`, and a stable per-iteration
  `AGENTFLOW_WHILE_IDEMPOTENCY_KEY`. Pass the idempotency key to external write APIs when they
  support one. Write progress logs to stderr because stdout is reserved for the decision object.
  The command also supports the same runtime placeholders as `tool.nodejs`, including
  `${flowDir}` and `${workspaceRoot}`.

  A waiting checkpoint retains state, history, elapsed active time, and the next absolute
  iteration. `maxIterations` and `timeout` are cumulative across resumes. A changed input resets
  the checkpoint; a matching but malformed checkpoint fails closed. Step output is schema-strict
  and bounded: unknown fields are rejected, state/stdout are limited to 1 MiB, stderr to 256 KiB,
  and summary to 4000 characters.
displayName: While
ui:
  card:
    template: state-machine
    icon: repeat
    tone: purple
    sections:
      - type: binding
        label: State input
        input: state
      - type: loop
        label: Loop execution
        field: script
      - type: decision
        label: Decision status
        output: decision
        source: step.stdout.decision
        options:
          - value: continue
            label: continue
            tone: purple
            description: 保存 state 并立即进入下一轮
          - value: wait
            label: wait
            tone: amber
            description: 保存 checkpoint，暂停当前 Run
          - value: done
            label: done
            tone: green
            description: 结束循环并继续下游
          - value: fail
            label: fail
            tone: red
            description: 终止并标记节点失败
      - type: metrics
        label: Limits and progress
        items:
          - label: Iteration
            output: iterations
            maxInput: maxIterations
          - label: Timeout
            input: timeout
      - type: summary
        label: Latest outcome
        output: summary
      - type: history
        label: Iteration history
        output: history
        limit: 3
input:
  - type: node
    name: prev
    default: ""
  - type: json
    name: state
    default: "null"
  - type: text
    name: maxIterations
    default: "20"
  - type: text
    name: timeout
    default: "30m"
output:
  - type: node
    name: next
    default: ""
  - type: json
    name: result
    default: ""
  - type: json
    name: state
    default: "null"
  - type: text
    name: decision
    default: ""
    showOnNode: true
  - type: text
    name: iterations
    default: "0"
    showOnNode: true
  - type: text
    name: summary
    default: ""
    showOnNode: true
  - type: json
    name: history
    default: "[]"
  - type: text
    name: checkpointFingerprint
    default: ""
---
${USER_PROMPT}
