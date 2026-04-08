import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SPACING_X = 320;
const SPACING_Y = 240;
const MIN_GAP = 280;

function calculateNodeSpacing(nodes, edges) {
  const graph = {};
  
  nodes.forEach(node => {
    graph[node.id] = {
      x: node.position.x,
      y: node.position.y,
      width: 200,
      height: 100,
    };
  });

  return graph;
}

function adjustPositions(nodePositions) {
  const entries = Object.entries(nodePositions);
  
  if (entries.length === 0) return nodePositions;

  const nodes = entries.map(([id, pos]) => ({
    id,
    x: typeof pos.x === 'number' ? pos.x : parseFloat(pos.x) || 0,
    y: typeof pos.y === 'number' ? pos.y : parseFloat(pos.y) || 0,
  }));

  nodes.sort((a, b) => a.x - b.x || a.y - b.y);

  const adjustedNodes = nodes.map((node, index) => {
    const col = index % 5;
    const row = Math.floor(index / 5);
    
    return {
      id: node.id,
      x: col * SPACING_X + (row % 2 === 1 ? SPACING_X / 2 : 0),
      y: row * SPACING_Y,
    };
  });

  const result = {};
  adjustedNodes.forEach(node => {
    result[node.id] = {
      x: node.x,
      y: node.y,
    };
  });

  return result;
}

function processFlowYaml(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const flow = yaml.load(content);

  if (!flow.ui || !flow.ui.nodePositions) {
    console.log(`No node positions found in ${filePath}`);
    return;
  }

  console.log(`\nProcessing: ${filePath}`);
  console.log(`Nodes count: ${Object.keys(flow.ui.nodePositions).length}`);

  const oldPositions = { ...flow.ui.nodePositions };
  flow.ui.nodePositions = adjustPositions(flow.ui.nodePositions);

  const backupPath = filePath + '.backup';
  fs.writeFileSync(backupPath, content);
  console.log(`Backup saved to: ${backupPath}`);

  const newContent = yaml.dump(flow, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  });

  fs.writeFileSync(filePath, newContent);
  console.log(`Updated: ${filePath}`);
}

function main() {
  const pipelinesDir = path.join(__dirname, '..', '..', 'builtin', 'pipelines');
  
  const flows = [
    path.join(pipelinesDir, 'new', 'flow.yaml'),
    path.join(pipelinesDir, 'module-migrate', 'flow.yaml'),
  ];

  flows.forEach(flowPath => {
    if (fs.existsSync(flowPath)) {
      processFlowYaml(flowPath);
    } else {
      console.log(`File not found: ${flowPath}`);
    }
  });

  console.log('\n✅ Node positions adjusted successfully!');
}

main();