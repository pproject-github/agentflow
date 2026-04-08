import { Handle, Position } from '@xyflow/react';

const HANDLE_COLORS = {
  node: '#9ecaff',
  text: '#e8deff',
  file: '#9ecaff',
  bool: '#00e475',
};

function getHandleColor(type) {
  return HANDLE_COLORS[type] || HANDLE_COLORS.node;
}

export default function DemoFlowNode({ data, id }) {
  const inputs = data?.inputs ?? [];
  const outputs = data?.outputs ?? [];
  const schemaType = (data?.schemaType ?? 'agent').toLowerCase();
  const typeLabel = data?.definitionId?.replace(/^(control_|agent_|tool_|provide_)/, '') || schemaType;
  
  const nodeStatus = data?.nodeStatus ?? null;
  const nodeElapsed = data?.nodeElapsed ?? null;

  const statusClass = {
    running: 'pulse-running',
    success: 'bg-primary-container',
    failed: 'bg-error-container',
  };

  return (
    <div
      className={`
        bg-surface-container-high rounded-2xl border border-outline-variant/20
        min-w-[180px] shadow-lg transition-all duration-300
        ${nodeStatus === 'running' ? 'pulse-running border-primary/30' : ''}
        ${nodeStatus === 'success' ? 'border-primary/40 shadow-primary/10' : ''}
        ${nodeStatus === 'failed' ? 'border-error/40 shadow-error/10' : ''}
      `}
      data-schema={schemaType}
    >
      {/* Node Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-surface-container-highest rounded-t-2xl border-b border-outline-variant/10">
        <span className="text-xs font-bold text-on-surface-variant uppercase tracking-wider truncate">
          {typeLabel}
        </span>
        {nodeStatus && (
          <div className={`
            text-xs font-bold px-2 py-1 rounded-lg
            ${nodeStatus === 'running' ? 'text-primary animate-pulse' : ''}
            ${nodeStatus === 'success' ? 'text-primary bg-primary/10' : ''}
            ${nodeStatus === 'failed' ? 'text-error bg-error/10' : ''}
          `}>
            {nodeStatus === 'success' && nodeElapsed != null ? `${nodeElapsed}ms` : nodeStatus.toUpperCase()}
          </div>
        )}
      </div>

      {/* Node Body */}
      <div className="flex items-center gap-3 px-4 py-4">
        {/* Input Ports */}
        <div className="flex flex-col gap-2">
          {inputs.map((slot, i) => (
            <div key={`in-${i}`} className="relative h-3 flex items-center">
              <Handle
                type="target"
                position={Position.Left}
                id={`input-${i}`}
                className="w-3 h-3 rounded-full border-2 border-surface"
                style={{ background: getHandleColor(slot.type) }}
              />
            </div>
          ))}
        </div>

        {/* Label */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-on-surface truncate">
            {data?.label || id}
          </div>
          {data?.body && (
            <div className="text-xs text-on-surface-variant mt-1 truncate max-w-[120px]">
              {data.body.substring(0, 30)}...
            </div>
          )}
        </div>

        {/* Output Ports */}
        <div className="flex flex-col gap-2">
          {outputs.map((slot, i) => (
            <div key={`out-${i}`} className="relative h-3 flex items-center justify-end">
              <Handle
                type="source"
                position={Position.Right}
                id={`output-${i}`}
                className="w-3 h-3 rounded-full border-2 border-surface"
                style={{ background: getHandleColor(slot.type) }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}