# How to Create a Figma UI Implementation Workflow

## Background

Converting Figma designs to frontend code is a common development task. For complex UIs (such as multi-page applications, complex interactive components), one-time implementation faces the following challenges:

1. **High design complexity**: Multiple pages, deep component hierarchies, many style details
2. **Tech stack adaptation**: Need to convert to specific framework code (React/Vue/Mini Program)
3. **Interaction logic implementation**: Static designs need dynamic interactions added
4. **Detail refinement**: Post-implementation requires multiple iterations to adjust details

The traditional approach is manual implementation page by page, which is inefficient and difficult to ensure consistency. Using AgentFlow, you can orchestrate an automated implementation process, supporting one-time processing of complex UIs with continuous iterative optimization.

## Workflow Design Concept

The core process of Figma UI implementation:

```
Parse Design → Extract Components → Generate Code → Compile Verification → UI Comparison Check → Discover Differences → Adjust Code → Compile Verification → ... → Complete
```

This also adopts the "check-fix-check" loop pattern, but focuses on accuracy verification of UI implementation.

## Workflow Node Design

### 1. Entry Node

- **control_start**: Process entry point

### 2. Design Parsing Phase

- **agent_parse_figma**: Parse Figma design link or exported files, identify page structure
- **agent_extract_components**: Extract reusable components, establish component hierarchy

### 3. Code Generation Phase

- **agent_generate_structure**: Generate page structure and layout code
- **agent_generate_styles**: Generate style code (CSS/Tailwind/styled-components)
- **agent_generate_components**: Generate component code (React/Vue functional components)

### 4. Tech Stack Adaptation

- **tool_nodejs**: Execute build commands (e.g., `npm run dev` to start dev server)
- **agent_add_interactions**: Add interaction logic (click, swipe, animation, etc.)

### 5. UI Verification Phase

- **tool_nodejs**: Screenshot comparison (using Playwright/Puppeteer)
- **agent_compare_ui**: Compare implemented UI with design, identify differences

### 6. Loop Control Nodes

- **control_anyOne**: Merge "first generation" and "re-check after adjustment"
- **control_toBool**: Convert UI comparison result to boolean value
- **control_if**: Decide whether to continue optimization based on implementation accuracy

### 7. Adjustment Optimization Phase

- **agent_fix_ui_differences**: Adjust code details based on difference report

### 8. End Node

- **control_end**: Process exit point

## flow.yaml Example

```yaml
instances:
  start:
    definitionId: control_start
    label: Start
    
  parse_figma:
    definitionId: agent_subAgent
    label: Parse Figma Design
    role: Parse Figma design, identify page structure and component hierarchy
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: figmaUrl, value: 'https://figma.com/file/xxx' }
      - { type: 文本, name: techStack, value: 'react' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: structure, value: 'output/structure.json' }
      
  extract_components:
    definitionId: agent_subAgent
    label: Extract Components
    role: Extract reusable components from design
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: structure, value: '${parse_figma structure}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: components, value: 'output/components.json' }
      
  generate_structure:
    definitionId: agent_subAgent
    label: Generate Page Structure
    role: Generate page layout code based on design structure
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: structure, value: '${parse_figma structure}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: layoutCode, value: 'src/pages/layout.tsx' }
      
  generate_styles:
    definitionId: agent_subAgent
    label: Generate Styles
    role: Generate style code based on design
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: structure, value: '${parse_figma structure}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: styleCode, value: 'src/styles/main.css' }
      
  generate_components:
    definitionId: agent_subAgent
    label: Generate Components
    role: Generate React component code based on component definitions
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: components, value: '${extract_components components}' }
    output:
      - { type: 节点, name: next, value: '' }
      
  start_dev_server:
    definitionId: tool_nodejs
    label: Start Dev Server
    script: npm run dev &
    input:
      - { type: 节点, name: prev, value: '' }
    output:
      - { type: 节点, name: next, value: '' }
      
  add_interactions:
    definitionId: agent_subAgent
    label: Add Interaction Logic
    role: Add interaction logic to components (click, animation, etc.)
    input:
      - { type: 节点, name: prev, value: '' }
    output:
      - { type: 节点, name: next, value: '' }
      
  capture_screenshot:
    definitionId: tool_nodejs
    label: Screenshot Comparison
    script: |
      node scripts/capture-ui.mjs \
        --url http://localhost:3000 \
        --output output/ui_screenshot.png \
        --figma ${figmaUrl}
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: figmaUrl, value: '${parse_figma figmaUrl}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: screenshot, value: 'output/ui_screenshot.png' }
      
  compare_ui:
    definitionId: agent_subAgent
    label: UI Comparison Check
    role: Compare implemented UI with design, identify differences
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: screenshot, value: '${capture_screenshot screenshot}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: differences, value: 'output/ui_differences.md' }
      
  check_accuracy:
    definitionId: agent_subAgent
    label: Check Implementation Accuracy
    role: Analyze difference report, determine if optimization is needed
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: differences, value: '${compare_ui differences}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: needFix, value: 'output/need_fix.txt' }
      
  to_bool:
    definitionId: control_toBool
    label: Convert to Boolean
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: value, value: '${check_accuracy needFix}' }
    output:
      - { type: 节点, name: next, value: '' }
      - { type: 文本, name: prediction, value: '' }
      
  accuracy_branch:
    definitionId: control_if
    label: Need Adjustment
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: prediction, value: '${to_bool prediction}' }
    output:
      - { type: 节点, name: next1, value: '' }  # No differences → End
      - { type: 节点, name: next2, value: '' }  # Has differences → Adjust
      
  fix_ui:
    definitionId: agent_subAgent
    label: Adjust UI Differences
    role: Adjust style and layout code based on difference report
    input:
      - { type: 节点, name: prev, value: '' }
      - { type: 文本, name: differences, value: '${compare_ui differences}' }
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
  - { source: start, target: parse_figma }
  - { source: parse_figma, target: extract_components }
  - { source: extract_components, target: generate_structure }
  - { source: generate_structure, target: generate_styles }
  - { source: generate_styles, target: generate_components }
  - { source: generate_components, target: start_dev_server }
  - { source: start_dev_server, target: add_interactions }
  - { source: add_interactions, target: loop_entry, sourceHandle: output-0, targetHandle: input-0 }
  - { source: loop_entry, target: capture_screenshot }
  - { source: capture_screenshot, target: compare_ui }
  - { source: compare_ui, target: check_accuracy }
  - { source: check_accuracy, target: to_bool }
  - { source: to_bool, target: accuracy_branch, sourceHandle: output-1, targetHandle: input-1 }
  - { source: accuracy_branch, target: end, sourceHandle: output-0, targetHandle: input-0 }
  - { source: accuracy_branch, target: fix_ui, sourceHandle: output-1, targetHandle: input-0 }
  - { source: fix_ui, target: loop_entry, sourceHandle: output-0, targetHandle: input-1 }

ui:
  nodePositions:
    start: { x: 100, y: 100 }
    parse_figma: { x: 250, y: 100 }
    extract_components: { x: 400, y: 100 }
    generate_structure: { x: 550, y: 100 }
    generate_styles: { x: 700, y: 100 }
    generate_components: { x: 850, y: 100 }
    start_dev_server: { x: 1000, y: 100 }
    add_interactions: { x: 1150, y: 100 }
    loop_entry: { x: 1300, y: 100 }
    capture_screenshot: { x: 1300, y: 250 }
    compare_ui: { x: 1300, y: 400 }
    check_accuracy: { x: 1300, y: 550 }
    to_bool: { x: 1300, y: 700 }
    accuracy_branch: { x: 1300, y: 850 }
    fix_ui: { x: 1500, y: 850 }
    end: { x: 1150, y: 850 }
```

## Key Design Points

### 1. Phased Generation

Split code generation into multiple nodes:
- **Structure generation**: Ensure layout correctness first
- **Style generation**: Then handle visual details
- **Component generation**: Finally generate reusable units

Each phase outputs to intermediate files, facilitating problem identification and checkpoint resumption.

### 2. UI Verification Mechanism

Use screenshot comparison technology to verify implementation accuracy:
- **Playwright/Puppeteer**: Automated screenshots
- **Visual comparison tools**: Pixel-level comparison or AI comparison
- **Difference report**: Generate specific list of differences

### 3. Continuous Optimization Loop

Enter fix loop after discovering differences:
- Read difference report
- Locate corresponding code files
- Adjust style/layout parameters
- Re-screenshot for verification

Until satisfactory implementation accuracy is achieved.

### 4. Tech Stack Adaptation

Support different tech stacks through parameterized configuration:
- React/Vue/Mini Program
- CSS/Tailwind/styled-components
- TypeScript/JavaScript

Configure tech stack at entry node, downstream nodes generate corresponding code based on configuration.

## Running the Process

```bash
# 1. Create workflow file
agentflow ui

# 2. Configure Figma URL and tech stack
# Edit input parameters of parse_figma node in UI

# 3. Validate workflow structure
agentflow validate figma-ui-implementation

# 4. Execute implementation
agentflow apply figma-ui-implementation

# 5. Monitor execution status
agentflow run-status figma-ui-implementation <uuid>

# 6. View difference report
cat .workspace/agentflow/runBuild/figma-ui-implementation/<uuid>/output/ui_differences.md

# 7. Continue from checkpoint after failure
agentflow resume figma-ui-implementation <uuid>
```

## Auxiliary Scripts

### capture-ui.mjs

Screenshot comparison script example:

```javascript
import puppeteer from 'puppeteer';
import { program } from 'commander';

program
  .option('--url <url>', 'UI address')
  .option('--output <path>', 'Screenshot output path')
  .option('--figma <url>', 'Figma design URL')
  .parse();

const { url, output, figma } = program.opts();

const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle0' });
await page.screenshot({ path: output, fullPage: true });
await browser.close();

console.log(JSON.stringify({
  err_code: 0,
  message: { screenshot: output, figmaUrl: figma }
}));
```

### UI Comparison Tool Suggestions

- **pixelmatch**: Pixel-level comparison
- **Applitools**: AI visual comparison
- **BackstopJS**: Automated visual regression testing

## Extension Suggestions

### 1. Multi-page Parallel Implementation

For multi-page applications:
- Split multiple `parse_figma_page` instances for parallel execution
- Use `tool_save_key` to share component library information

### 2. Responsive Adaptation

Add responsive verification nodes:
- Multi-resolution screenshot comparison
- Mobile/desktop verification separately

### 3. User Confirmation Points

Insert `tool_user_check` at critical phases:
- Component structure confirmation
- Style preview confirmation
- Interaction logic confirmation

### 4. Code Quality Check

Add static check nodes:
- ESLint/TSLint code standard check
- TypeScript type check
- Unit test generation

## Real Case

See complete example at `builtin/pipelines/figma-ui-demo` (if available), including:
- React + Tailwind tech stack configuration
- Multi-page parallel implementation example
- Playwright screenshot comparison script