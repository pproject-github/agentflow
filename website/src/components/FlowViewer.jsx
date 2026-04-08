import { useState, useEffect, useMemo, useCallback } from 'react';
import { ReactFlow, Background, Controls, MiniMap, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import yaml from 'js-yaml';
import DemoFlowNode from './DemoFlowNode.jsx';

const nodeTypes = { demoFlowNode: DemoFlowNode };

function deserializeFlowYaml(flowYamlContent) {
  if (!flowYamlContent?.trim()) {
    return { nodes: [], edges: [] };
  }

  try {
    const raw = yaml.load(flowYamlContent);
    const instances = raw?.instances || {};
    const edgesRaw = Array.isArray(raw?.edges) ? raw.edges : [];
    const nodePositions = raw?.ui?.nodePositions || {};

    const nodes = Object.keys(instances).map((id) => {
      const inst = instances[id];
      const position = nodePositions[id] || { x: 0, y: 0 };
      const definitionId = inst?.definitionId || id;

      return {
        id,
        type: 'demoFlowNode',
        position,
        data: {
          label: inst?.label || id,
          definitionId,
          schemaType: definitionId.startsWith('control_') ? 'control' : 'agent',
          body: inst?.body || '',
          inputs: inst?.input || [],
          outputs: inst?.output || [],
          nodeStatus: null,
          nodeElapsed: null,
        },
      };
    });

    const edges = edgesRaw
      .filter((e) => e?.source && e?.target)
      .map((e, i) => ({
        id: `e-${e.source}-${e.target}-${i}`,
        source: String(e.source),
        target: String(e.target),
        sourceHandle: e.sourceHandle || 'output-0',
        targetHandle: e.targetHandle || 'input-0',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#d0bcff' },
        style: { stroke: '#d0bcff', strokeWidth: 2 },
        type: 'smoothstep',
      }));

    return { nodes, edges };
  } catch (err) {
    console.error('Failed to parse flow.yaml:', err);
    return { nodes: [], edges: [] };
  }
}

export default function FlowViewer({ flowData, isSimulating, simulationStep, nodeTimings }) {
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);

  useEffect(() => {
    const { nodes: parsedNodes, edges: parsedEdges } = deserializeFlowYaml(flowData);
    setNodes(parsedNodes);
    setEdges(parsedEdges);
  }, [flowData]);

  const animatedNodes = useMemo(() => {
    if (!isSimulating || simulationStep === null) {
      return nodes.map((n) => ({
        ...n,
        data: { ...n.data, nodeStatus: null, nodeElapsed: null },
      }));
    }

    return nodes.map((n, idx) => {
      if (idx < simulationStep) {
        return {
          ...n,
          data: {
            ...n.data,
            nodeStatus: 'success',
            nodeElapsed: nodeTimings[idx] || Math.floor(Math.random() * 500 + 100),
          },
        };
      } else if (idx === simulationStep) {
        return {
          ...n,
          data: { ...n.data, nodeStatus: 'running' },
        };
      }
      return {
        ...n,
        data: { ...n.data, nodeStatus: null },
      };
    });
  }, [nodes, isSimulating, simulationStep, nodeTimings]);

  return (
    <ReactFlow
      nodes={animatedNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.3}
      maxZoom={1.5}
      defaultEdgeOptions={{
        type: 'smoothstep',
        animated: isSimulating,
      }}
    >
      <Background color="#2d3449" gap={20} />
      <Controls showInteractive={false} />
      <MiniMap 
        nodeColor="#8252ec"
        maskColor="rgba(11, 19, 38, 0.8)"
        style={{ background: '#171f33' }}
      />
    </ReactFlow>
  );
}