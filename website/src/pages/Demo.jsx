import { useState, useEffect, useCallback } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import yaml from 'js-yaml';
import FlowViewer from '../components/FlowViewer.jsx';

const SIMULATION_SPEED = 1500;

export default function Demo() {
  const { t } = useTranslation();
  const [flowData, setFlowData] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationStep, setSimulationStep] = useState(null);
  const [nodeTimings, setNodeTimings] = useState([]);
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    setLoading(true);
    fetch('/demo-flow.yaml')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load flow');
        return res.text();
      })
      .then((text) => {
        setFlowData(text);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const startSimulation = useCallback(() => {
    if (loading || !flowData) return;

    const yamlData = yaml.load(flowData);
    const nodeCount = Object.keys(yamlData?.instances || {}).length;
    const timings = Array.from({ length: nodeCount }, () => Math.floor(Math.random() * 800 + 200));

    setNodeTimings(timings);
    setSimulationStep(0);
    setIsSimulating(true);
    setStatus('running');

    const interval = setInterval(() => {
      setSimulationStep((prev) => {
        if (prev === null || prev >= nodeCount - 1) {
          clearInterval(interval);
          setIsSimulating(false);
          setStatus('completed');
          return prev;
        }
        return prev + 1;
      });
    }, SIMULATION_SPEED);
  }, [loading, flowData]);

  const resetSimulation = useCallback(() => {
    setIsSimulating(false);
    setSimulationStep(null);
    setNodeTimings([]);
    setStatus('idle');
  }, []);

  return (
    <div className="pt-20 md:pt-24 min-h-screen">
      <div className="max-w-7xl mx-auto px-6 md:px-12 py-8 md:py-12">
        {/* Header */}
        <div className="mb-8 md:mb-12">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 md:gap-6">
            <div>
              <span className="text-primary font-headline text-xs md:text-sm font-bold tracking-[0.3em] uppercase mb-2 block">
                {t('demo.subtitle')}
              </span>
              <h1 className="font-headline text-4xl md:text-5xl font-bold tracking-tight text-on-surface">
                {t('demo.title')}
              </h1>
            </div>

            {/* Status Badge */}
            <div className={`
              px-4 py-2 rounded-xl font-headline font-bold text-sm
              ${status === 'running' ? 'bg-primary/20 text-primary animate-pulse' : ''}
              ${status === 'completed' ? 'bg-primary-container/20 text-primary' : ''}
              ${status === 'idle' ? 'bg-surface-container-high text-on-surface-variant' : ''}
            `}>
              {status === 'running' && t('demo.running')}
              {status === 'completed' && t('demo.completed')}
              {status === 'idle' && t('demo.ready')}
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap gap-3 md:gap-4 mt-6 md:mt-8">
            <button
              onClick={startSimulation}
              disabled={loading || status === 'running'}
              className={`
                btn-primary flex items-center gap-2
                ${loading || status === 'running' ? 'opacity-50 cursor-not-allowed' : ''}
              `}
            >
              <span className="material-symbols-outlined">play_arrow</span>
              {status === 'idle' ? t('demo.start') : t('demo.restart')}
            </button>

            {status === 'running' && (
              <button
                onClick={resetSimulation}
                className="btn-ghost flex items-center gap-2"
              >
                <span className="material-symbols-outlined">stop</span>
                {t('demo.pause')}
              </button>
            )}

            {status === 'completed' && (
              <button
                onClick={resetSimulation}
                className="btn-ghost flex items-center gap-2"
              >
                <span className="material-symbols-outlined">refresh</span>
                {t('demo.reset')}
              </button>
            )}
          </div>
        </div>

        {/* Flow Container */}
        <div className="bg-surface-container-low rounded-2xl md:rounded-3xl overflow-hidden shadow-2xl border border-outline-variant/10">
          {/* Window Chrome */}
          <div className="flex items-center gap-2 px-4 md:px-6 py-3 border-b border-outline-variant/10 bg-surface-container">
            <div className="w-3 h-3 rounded-full bg-error/40" />
            <div className="w-3 h-3 rounded-full bg-tertiary/40" />
            <div className="w-3 h-3 rounded-full bg-primary/40" />
            <span className="ml-4 text-xs text-on-surface-variant font-mono tracking-widest uppercase">
              demo_flow.yaml
            </span>
          </div>

          {/* Flow Canvas */}
          <div className="h-[500px] md:h-[700px] relative">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary" />
              </div>
            ) : error ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-error text-center">
                  <span className="material-symbols-outlined text-6xl mb-4">error</span>
                  <p className="font-headline text-xl">{error}</p>
                </div>
              </div>
            ) : (
              <ReactFlowProvider>
                <FlowViewer
                  flowData={flowData}
                  isSimulating={isSimulating}
                  simulationStep={simulationStep}
                  nodeTimings={nodeTimings}
                />
              </ReactFlowProvider>
            )}
          </div>
        </div>

        {/* Info Section */}
        <div className="mt-8 md:mt-12 grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
          <div className="card-glass">
            <span className="material-symbols-outlined text-primary text-3xl mb-4">info</span>
            <h3 className="font-headline text-xl font-bold mb-3 text-on-surface">
              {t('demo.infoTitle')}
            </h3>
            <p className="text-on-surface-variant text-sm leading-relaxed">
              {t('demo.infoDesc')}
            </p>
          </div>

          <div className="card-solid">
            <span className="material-symbols-outlined text-primary text-3xl mb-4">speed</span>
            <h3 className="font-headline text-xl font-bold mb-3 text-on-surface">
              {t('demo.realtimeTitle')}
            </h3>
            <p className="text-on-surface-variant text-sm leading-relaxed">
              {t('demo.realtimeDesc')}
            </p>
          </div>

          <div className="card-solid">
            <span className="material-symbols-outlined text-primary text-3xl mb-4">description</span>
            <h3 className="font-headline text-xl font-bold mb-3 text-on-surface">
              {t('demo.yamlTitle')}
            </h3>
            <p className="text-on-surface-variant text-sm leading-relaxed">
              {t('demo.yamlDesc')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}