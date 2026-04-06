# AgentFlow

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![中文](https://img.shields.io/badge/lang-中文-red.svg)](./README.zh-CN.md)
[![English](https://img.shields.io/badge/lang-English-blue.svg)](./README.md)

> **Orchestration system for long-running complex agent tasks.**  
> AgentFlow uses graphs to encode dependencies and control flow, treating Cursor, OpenCode, and Claude Code (in progress) as **swappable execution backends**. Battle-tested on **large engineering efforts**—not a demo script, but a runtime that can finish, pause, and resume.

## The Origin: From Pain Point to Solution

### That Migration Task That Broke Me

As a developer who uses Cursor and OpenCode daily, I had a comfortable workflow: small changes directly, slightly larger tasks with plan mode, and most things worked out. Until one day I needed to migrate code from a main module to a submodule—this seemingly simple requirement made me realize the boundaries of existing tools.

Migration, compilation, tree dependencies, discovering new dependencies, migrating again, compiling again... this was a cyclic process. Cursor or OpenCode could help me with individual steps well, like "move this file" or "compile and check errors". But the entire workflow was like an endless relay race: AI runs a segment, I discover issues, manually intervene, AI runs another segment, I find more issues... **Humans still handle a lot of coordination and decision-making, with limited efficiency gains.**

What I needed wasn't a smarter AI assistant, but a system that could **chain these steps together, execute cyclically and automatically, knowing where to stop and where to resume when problems arise**. Thus, AgentFlow was born.

### Design Philosophy of AgentFlow

AgentFlow doesn't aim to replace Cursor or OpenCode, but **builds upon them**:

**Reuse, Not Rebuild**: Your company might only have Cursor subscriptions, and you've accumulated skills and prompts. AgentFlow directly invokes existing Coding Agents as execution backends—no need to migrate to a new AI platform, existing capabilities can be directly orchestrated and reused.

**Orchestration, Not Dialogue**: Describe workflows with nodes and connections like ComfyUI. Once defined, flows can be repeatedly executed—not "every conversation is a fresh start". The core is the **coding process** rather than AI dialogue, so there's no context length limit—it can run indefinitely.

**Persistence, Not Volatility**: Every node's inputs, outputs, and execution state are recorded in intermediate files, inspired by Gradle task caching. Support for checkpoint resumption—tasks that stopped halfway last night can continue from the failure point today, not from the beginning.

**CI-Friendly**: Long-running, fixed workflows, recoverable—these characteristics make AgentFlow particularly suitable for CI/CD integration. Not "humans monitoring AI execution", but "AI workflows run automatically, with human intervention only when needed".

## Key Features

- **Based on Existing Agents**: Supports Cursor, OpenCode, and other Coding Agents, reuses existing skills and prompts without platform migration
- **Node Orchestration System**: Visual drag-and-drop orchestration, fixed and reusable workflows, combining complex workflows like building blocks
- **Unlimited Context Execution**: Persistent state via intermediate files and cache system, breaking through conversational AI context limits, supporting hour-long or longer tasks
- **Checkpoint Resumption**: Every node state persisted, precise problem node location on failure, single-node retry or full recovery, no need to start from scratch
- **CI/CD Ready**: Fixed workflows, repeatable execution, long-running support, naturally suited for continuous integration scenarios

The hard part of complex work is rarely "model quality alone"—it is **state, boundaries, and cadence**: who depends on whom, where humans must sign off, and which checkpoint to restart from after failure. AgentFlow models workflows as **nodes + directed edges**: a scheduler advances a **ready set** from dependency closure; each node binds an agent capability to a backend. Run directories persist artifacts and per-node status, yielding **observability** and **recoverability** (pause / resume / replay). Orchestration stays decoupled from your codebase: swap tools; keep the graph and execution semantics.

## Common Scenarios

**1. Large-scale refactor / migration**  
Turn “touch it and pray” monolith changes into an audible chain with checkpoints: scan → plan → incremental change → verify—every failure has a scene and a story.

**2. Deep codebase cleanup**  
At scale, checklists break. Use loops and batch-oriented nodes to drive cleanup and standardization—repay technical debt as a **measurable, pausable, resumable** engineering process.

**3. AI-driven test automation, continuously**  
Move testing from "when someone remembers" to a **slow-burn loop**: schedule or iterate, emit node-level reports, localize failures—let the quality flywheel run in the background.

## Practical Examples

Detailed tutorials available in Wiki docs:

**1. [Module Migration Workflow](docs/wiki/module-migration-workflow.en.md)**  
Migrate code from main module to submodule: scan → analyze dependencies → migrate → compile → loop fix. Demonstrates how to implement "check-fix-check" cyclic pattern with `control_anyOne` + `control_if`, supporting checkpoint resumption and single-node retry.

**2. [Figma UI Implementation Workflow](docs/wiki/figma-ui-implementation-workflow.en.md)**  
One-shot implementation of complex Figma designs: parse design → extract components → generate code → screenshot comparison → loop optimization. Demonstrates phased code generation, automated UI verification, and continuous iteration until pixel-perfect accuracy.

## Usage Guide

Shortest path: install → first pipeline → validate → run → diagnose and resume.

### 1. Installation

Requirements: Node >= 18, Cursor CLI installed (`agent` command available)

```bash
# Global install from npm (no clone needed once published)
npm install -g agentflow

# Verify installation
agentflow --help
```

For development from source: clone the repository, then run `npm install` and `npm link` in that directory.

### 2. Create a Flow

```bash
# List built-in pipelines
agentflow list

# Start Web UI (default port 8765)
agentflow ui
```

#### Method 1: Visual Orchestration (Beginner-friendly)

In the Web UI:
1. Click to create a new pipeline, choose blank template or copy existing
2. Drag nodes from the left panel to canvas
3. Connect node edges, configure node parameters
4. Save to get `flow.yaml`

#### Method 2: AI Composer Mode (Recommended for Complex Flows)

In the Web UI's right Composer input box, describe your needs in natural language - AI auto-generates the flow:

**Example 1: Simple Linear Flow**
```
Create a flow: read requirements doc, generate code implementation, run tests to verify
```

**Example 2: Flow with Loop Verification**
```
Create a code check flow:
1. Scan codebase for issues
2. Auto-fix the issues
3. Re-check if it passes
4. If not passed, continue fixing until all pass
```
AI recognizes "check-fix-loop" pattern and generates loop structure with `control_anyOne` + `control_toBool` + `control_if`.

**Example 3: Todolist Batch Processing Flow**
```
Create a large file breakdown flow:
1. Break down large file into todolist
2. Process each subtask in todolist
3. Mark completed items with checkmark
4. Until all tasks done
```
AI adopts todolist mode: breakdown node → loop process each item → check if all complete.

**Composer Workflow**:
- **Phased Generation**: Complex flows auto-split into three phases
  - Flow Planning: establish overall framework, node types, main topology
  - Node Enrichment: complete each node's specific content (body, script, etc.)
  - Flow Finishing: complete connections, optimize layout, validate & repair
- **Smart Loop Detection**: auto-generates loops when detecting keywords like "check", "verify", "batch"
- **Auto Validation & Repair**: validates flow.yaml after generation, attempts up to 5 repairs

### 3. Create Loops and Validate

For flows requiring loops/branches:

```bash
# Validate flow structure
agentflow validate <FlowName>
```

Common control nodes (add in UI):
- `control_if` — Conditional branch
- `control_toBool` — Convert to boolean for If nodes
- `control_anyOne` — Continue when any of multiple branches completes

### 4. Run

```bash
# Apply (execute) the flow
agentflow apply <FlowName>

# Check run status
agentflow run-status <FlowName> <uuid>
```

The flow executes automatically in dependency order, with each Agent node invoking Cursor CLI streaming output.

### 5. Troubleshooting and Resume

```bash
# View run logs
cat .workspace/agentflow/runBuild/<FlowName>/<uuid>/logs/log.txt

# Extract thinking process
agentflow extract-thinking <FlowName> <uuid>

# Resume from breakpoint (marks pending/failed nodes as acknowledged and continues)
agentflow resume <FlowName> <uuid>

# Retry a specific node individually
agentflow replay <FlowName> <uuid> <instanceId>
```

---

## Quick Reference

### Command Subcommands

| Command | Description |
|---------|-------------|
| `list` | List all pipelines |
| `ui` | Start Web UI orchestration tool |
| `apply` | Execute flow |
| `validate` | Validate flow structure |
| `resume` | Resume execution from breakpoint |
| `replay` | Retry a specific node individually |
| `run-status` | View node execution status |
| `extract-thinking` | Extract and organize agent thinking process |

### Common Options

- `--workspace-root <path>` — Workspace root directory
- `--dry-run` — Preview ready nodes without execution
- `--model <name>` — Specify Cursor model
- `--parallel` — Execute same-round nodes in parallel
- `--machine-readable` — JSON event stream output (for UI integration)
- `--lang <code>` — Set language

### Environment Variables

- `CURSOR_AGENT_CMD` — Cursor CLI command (default: `agent`)
- `CURSOR_AGENT_MODEL` — Default model
- `AGENTFLOW_HOME` — Override user data directory (default: `~/agentflow`; runBuild is now workspace-local)

## User Data Directories

- Default user data directory: **`~/agentflow/`** (`pipelines/`, `agents/`, `model-lists.json`, etc.)
- Run build directory (primary): **`<workspaceRoot>/.workspace/agentflow/runBuild/<flowId>/<uuid>/`**
- Legacy runBuild compatibility read path: **`~/agentflow/runBuild/`**
- In-project pipeline copies: **`<workspaceRoot>/.workspace/agentflow/pipelines/<flowId>/`**
- In-project custom nodes: **`<workspaceRoot>/.workspace/agentflow/nodes/`**

## Flow Definition

See [reference/flow-control-capabilities.md](reference/flow-control-capabilities.md) for control nodes and typical wiring patterns.

## Internationalization (i18n)

AgentFlow supports multiple languages at three levels:

1. **CLI Language**: `--lang` flag or `LANG` environment variable
2. **Web UI Language**: Automatically detects browser language
3. **Agent Definitions**: Multi-language prompts in `agents/<lang>/` directory

Supported languages: `zh` (中文), `en` (English)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

[MIT](LICENSE)
