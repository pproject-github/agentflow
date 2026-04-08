import { ReactFlowProvider } from '@xyflow/react';
import FlowViewer from './FlowViewer.jsx';

export default function CodeBlock({ node, inline, className, children, ...props }) {
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';
  const codeContent = String(children).replace(/\n$/, '');

  const isFlowYaml = 
    (language === 'yaml' || language === 'yml') && 
    codeContent.includes('instances:') && 
    codeContent.includes('edges:');

  if (isFlowYaml) {
    return (
      <div className="my-6 rounded-2xl overflow-hidden border border-outline-variant/20 shadow-lg">
        <div className="flex items-center gap-2 px-4 py-3 bg-surface-container-high border-b border-outline-variant/10">
          <div className="w-3 h-3 rounded-full bg-error/40" />
          <div className="w-3 h-3 rounded-full bg-tertiary/40" />
          <div className="w-3 h-3 rounded-full bg-primary/40" />
          <span className="ml-3 text-xs text-on-surface-variant font-mono tracking-widest uppercase">
            flow.yaml
          </span>
        </div>
        <div className="h-[400px] bg-surface-container-lowest">
          <ReactFlowProvider>
            <FlowViewer 
              flowData={codeContent}
              isSimulating={false}
              simulationStep={null}
              nodeTimings={[]}
            />
          </ReactFlowProvider>
        </div>
      </div>
    );
  }

  if (inline) {
    return (
      <code className="bg-surface-container-lowest px-2 py-1 rounded-lg font-mono text-sm text-primary-fixed" {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="my-6 bg-surface-container-lowest rounded-2xl overflow-hidden border border-outline-variant/20">
      {language && (
        <div className="flex items-center justify-between px-4 py-2 bg-surface-container-high border-b border-outline-variant/10">
          <span className="text-xs text-on-surface-variant font-mono tracking-widest uppercase">
            {language}
          </span>
          <button
            onClick={() => navigator.clipboard.writeText(codeContent)}
            className="text-xs text-on-surface-variant hover:text-primary transition-colors flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-sm">content_copy</span>
            Copy
          </button>
        </div>
      )}
      <pre className="p-6 overflow-x-auto">
        <code className={`font-mono text-sm ${className || ''}`} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}