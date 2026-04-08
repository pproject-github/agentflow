# How to Create a Module Migration Workflow

## Background

Module migration is a common scenario in code refactoring: migrating code from a main module to a submodule involves multiple steps such as file movement, dependency updates, and compilation verification. Traditional methods require manual repetition of these steps, which is inefficient and error-prone.

With AgentFlow, the entire migration process can be orchestrated as an automated workflow, supporting loop verification and checkpoint resumption.

## Workflow Design Concept

The core process of module migration:

```
Scan Module → Analyze Dependencies → Migrate Files → Update Dependencies → Compile Verification → Discover New Dependencies → Migrate New Dependencies → Compile Verification → ... → Complete
```

This is a typical "check-fix-check" loop pattern, which can be implemented using AgentFlow's `control_anyOne` + `control_if`.

## Workflow Node Design

### 1. Entry Node

- **control_start**: Process entry point

### 2. Scanning and Analysis Phase

- **agent_scan_module**: Scan the main module to identify files and dependencies that need migration
- **agent_analyze_dependencies**: Analyze tree-structured dependency relationships and generate migration plan

### 3. Migration Execution Phase

- **agent_migrate_files**: Migrate files to submodule according to the plan
- **agent_update_imports**: Update all import statements in references

### 4. Compilation Verification Phase

- **tool_nodejs**: Execute compilation commands (e.g., `npm run build`)
- **agent_check_errors**: Analyze compilation errors and identify newly discovered dependencies

### 5. Loop Control Nodes

- **control_anyOne**: Merge two paths: "first entry" and "re-check after fix"
- **control_toBool**: Convert compilation result to boolean value (success/failure)
- **control_if**: Decide whether to continue the loop based on compilation result

### 6. Fix Phase

- **agent_fix_dependencies**: Fix new dependency issues discovered in compilation errors

### 7. End Node

- **control_end**: Process exit point

## flow.yaml Example

```yaml
instances:
  start:
    definitionId: control_start
    label: Start
    
  scan_module:
    definitionId: agent_subAgent
    label: Scan Module
    role: Scan the main module to identify files that need migration
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: moduleName, value: 'main-module' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: fileList, value: 'output/file_list.md' }
      
  analyze_deps:
    definitionId: agent_subAgent
    label: Analyze Dependencies
    role: Analyze file dependency relationships and generate migration plan
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: fileList, value: '${scan_module fileList}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: plan, value: 'output/migration_plan.md' }
      
  migrate_files:
    definitionId: agent_subAgent
    label: Migrate Files
    role: Execute file migration
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: plan, value: '${analyze_deps plan}' }
    output:
      - { type: 节点, name: next, value: '' }
      
  compile_check:
    definitionId: tool_nodejs
    label: Compile Verification
    script: npm run build
    input:
      - { type: 节点, name: prev, value: '' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: result, value: '' }
      
  check_errors:
    definitionId: agent_subAgent
    label: Check Errors
    role: Analyze compilation results and determine if there are errors
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: compileResult, value: '${compile_check result}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: hasError, value: 'output/has_error.txt' }
      
  to_bool:
    definitionId: control_toBool
    label: Convert to Boolean
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: value, value: '${check_errors hasError}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: prediction, value: '' }
      
  check_branch:
    definitionId: control_if
    label: Has Errors
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: prediction, value: '${to_bool prediction}' }
    output:
      - { type: 节点, name: next1, value: '' }  # No errors → End
      - { type: 节点, name: next2, value: '' }  # Has errors → Fix
      
  fix_deps:
    definitionId: agent_subAgent
    label: Fix Dependencies
    role: Fix dependency issues based on compilation errors
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: errorLog, value: '${compile_check result}' }
    output:
      - { type: 节点, name: next, value: '' }
      
  loop_entry:
    definitionId: control_anyOne
    label: Loop Entry
    input:
      - { type: 节点, name: prev1, value: '' }
      - { type: 节点, name: prev2, value: '' }
    output:
      - { type: 节点, name: next, value: '' }
      
  end:
    definitionId: control_end
    label: End

edges:
  - { source: start, target: scan_module }
  - { source: scan_module, target: analyze_deps }
  - { source: analyze_deps, target: migrate_files }
  - { source: migrate_files, target: loop_entry, sourceHandle: output-0, targetHandle: input-0 }
  - { source: loop_entry, target: compile_check }
  - { source: compile_check, target: check_errors }
  - { source: check_errors, target: to_bool }
  - { source: to_bool, target: check_branch, sourceHandle: output-1, targetHandle: input-1 }
  - { source: check_branch, target: end, sourceHandle: output-0, targetHandle: input-0 }
  - { source: check_branch, target: fix_deps, sourceHandle: output-1, targetHandle: input-0 }
  - { source: fix_deps, target: loop_entry, sourceHandle: output-0, targetHandle: input-1 }

ui:
  nodePositions:
    start: { x: 100, y: 100 }
    scan_module: { x: 250, y: 100 }
    analyze_deps: { x: 400, y: 100 }
    migrate_files: { x: 550, y: 100 }
    loop_entry: { x: 700, y: 100 }
    compile_check: { x: 700, y: 250 }
    check_errors: { x: 700, y: 400 }
    to_bool: { x: 700, y: 550 }
    check_branch: { x: 700, y: 700 }
    fix_deps: { x: 900, y: 700 }
    end: { x: 550, y: 700 }
```

## Key Design Points

### 1. Loop Control Pattern

Use `control_anyOne` as the loop entry, merging two paths:
- **prev1**: First entry (connected from `migrate_files`)
- **prev2**: Re-check after fix (connected from `fix_deps`)

Either path being ready triggers entry into the compilation verification phase.

### 2. Conditional Branching

Use `control_if` to determine compilation result:
- **No errors (prediction=false)**: Connect from `next1` (output-0) to `end`, exit the process
- **Has errors (prediction=true)**: Connect from `next2` (output-1) to `fix_deps`, enter fix phase

Note: The output of `control_toBool` needs to reverse semantics (compilation success=false means no errors).

### 3. State Persistence

Each node outputs to intermediate files, ensuring:
- Compilation error logs are saved to `${compile_check result}`
- After failure, retry from `fix_deps` node
- Support checkpoint resumption without re-executing completed nodes

## Running the Process

```bash
# 1. Create workflow file (save to ~/agentflow/pipelines/module-migration/flow.yaml)
agentflow ui

# 2. Validate workflow structure
agentflow validate module-migration

# 3. Execute migration
agentflow apply module-migration

# 4. Monitor execution status
agentflow run-status module-migration <uuid>

# 5. Continue from checkpoint after failure
agentflow resume module-migration <uuid>

# 6. Retry a specific node
agentflow replay module-migration <uuid> fix_deps
```

## Extension Suggestions

### 1. Parallel Migration

For large modules, split into multiple migration nodes for parallel execution:
- `migrate_files_part1`, `migrate_files_part2` in parallel
- Use multiple `agent_subAgent` instances to migrate different files simultaneously

### 2. User Confirmation Points

Insert `tool_user_check` after critical nodes:
- After migration plan is generated, let user confirm
- Before compilation verification, let user confirm whether to proceed

### 3. Rollback Mechanism

Add `tool_save_key` + `tool_load_key` to record migration state:
- Save file list before migration
- Rollback to initial state on failure

## Real Case

Refer to the built-in example `builtin/pipelines/module-migrate` to view the complete workflow configuration.