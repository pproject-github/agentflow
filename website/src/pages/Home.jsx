import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import FeatureCard from '../components/FeatureCard.jsx';

function CodeBlock({ code, label }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-surface-container-high border-b border-outline-variant/10">
        <span className="text-xs text-on-surface-variant font-mono">{label}</span>
        <button
          onClick={handleCopy}
          className="text-xs text-on-surface-variant hover:text-primary transition-colors flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-sm">
            {copied ? 'check' : 'content_copy'}
          </span>
          {copied ? t('install.copied') : t('install.copy')}
        </button>
      </div>
      <div className="px-4 py-3">
        <code className="font-mono text-sm text-primary-fixed">{code}</code>
      </div>
    </div>
  );
}

export default function Home() {
  const { t } = useTranslation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const features = [
    {
      icon: 'hub',
      title: t('features.stability.title'),
      desc: t('features.stability.desc'),
      variant: 'glass',
      span: 8,
    },
    {
      icon: 'timer',
      title: t('features.resilience.title'),
      desc: t('features.resilience.desc'),
      variant: 'solid',
      span: 4,
    },
    {
      icon: 'history',
      title: t('features.recovery.title'),
      desc: t('features.recovery.desc'),
      variant: 'solid',
      span: 4,
    },
    {
      icon: 'insights',
      title: t('features.visual.title'),
      desc: t('features.visual.desc'),
      variant: 'glass',
      span: 8,
      badges: ['Node.js', 'React Flow', 'YAML'],
    },
  ];

  return (
    <div className="pt-20 md:pt-24">
      {/* Hero Section */}
      <section className="relative min-h-[90vh] md:min-h-screen flex items-center overflow-hidden">
        <div className="max-w-7xl mx-auto px-6 md:px-12 w-full grid grid-cols-12 gap-4 md:gap-8 relative z-10">
          <div className="col-span-12 lg:col-span-7">
            <h1 className="font-headline text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tighter mb-6 md:mb-8 leading-[0.9]">
              {t('hero.title')}
              <br />
              <span className="text-gradient">{t('hero.titleGradient')}</span>
            </h1>
            <p className="text-on-surface-variant text-lg md:text-xl lg:text-2xl max-w-xl leading-relaxed mb-8 md:mb-12 font-light">
              {t('hero.subtitle')}
            </p>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 md:gap-6">
              <Link to="/demo" className="btn-primary">
                {t('hero.cta')}
              </Link>
              <Link 
                to="/docs" 
                className="group flex items-center gap-2 text-on-surface font-headline font-medium hover:text-primary transition-colors"
              >
                <span>{t('hero.docs')}</span>
                <span className="material-symbols-outlined transition-transform group-hover:translate-x-1">
                  arrow_forward
                </span>
              </Link>
            </div>
          </div>

          {/* Asymmetric Design Element */}
          <div className="hidden lg:block lg:col-span-5 relative">
            <div className="absolute inset-0 bg-gradient-to-tr from-primary/10 to-transparent blur-3xl rounded-full" />
            <div className="relative w-3/4 aspect-square glass-panel rounded-full flex items-center justify-center p-8 overflow-hidden mx-auto">
              <img 
                src="/logo-512.png" 
                alt="AgentFlow Logo" 
                className="w-3/4 h-3/4 object-contain rounded-full opacity-80 animate-pulse-slow"
              />
            </div>
          </div>
        </div>

        {/* Structural background element */}
        <div className="absolute right-0 bottom-0 w-1/3 h-2/3 bg-surface-container-low -z-10 transform translate-x-1/4 skew-x-12 opacity-50" />
      </section>

      {/* Quick Start Section */}
      <section className="py-16 md:py-24 bg-surface-container">
        <div className="max-w-7xl mx-auto px-6 md:px-12">
          <div className="text-center mb-12 md:mb-16">
            <h2 className="font-headline text-3xl md:text-5xl font-bold tracking-tight text-on-surface mb-4">
              {t('install.title')}
            </h2>
            <p className="text-on-surface-variant text-lg md:text-xl">
              {t('install.subtitle')}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
            <div className="card-glass">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center">
                  <span className="text-on-primary font-bold font-headline">1</span>
                </div>
                <h3 className="font-headline text-lg font-bold text-on-surface">
                  {t('install.step1')}
                </h3>
              </div>
              <CodeBlock code="npm install -g agentflow" label="Terminal" />
            </div>

            <div className="card-glass">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center">
                  <span className="text-on-primary font-bold font-headline">2</span>
                </div>
                <h3 className="font-headline text-lg font-bold text-on-surface">
                  {t('install.step2')}
                </h3>
              </div>
              <CodeBlock code="agentflow ui" label="Terminal" />
            </div>

            <div className="card-glass">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center">
                  <span className="text-on-primary font-bold font-headline">3</span>
                </div>
                <h3 className="font-headline text-lg font-bold text-on-surface">
                  {t('install.step3')}
                </h3>
              </div>
              <CodeBlock code="agentflow apply my-flow" label="Terminal" />
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-16 md:py-32 bg-surface-container-low">
        <div className="max-w-7xl mx-auto px-6 md:px-12">
          <div className="grid grid-cols-12 gap-4 md:gap-6">
            {features.map((feature, idx) => (
              <div key={idx} className={`col-span-12 md:col-span-${feature.span}`}>
                <FeatureCard
                  icon={feature.icon}
                  title={feature.title}
                  desc={feature.desc}
                  variant={feature.variant}
                  badges={feature.badges}
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Demo Preview Section */}
      <section className="py-16 md:py-32 relative overflow-hidden">
        <div className="max-w-7xl mx-auto px-6 md:px-12">
          <div className="mb-8 md:mb-16">
            <span className="text-primary font-headline text-xs md:text-sm font-bold tracking-[0.3em] uppercase mb-2 md:mb-4 block">
              {t('demo.experienceLive')}
            </span>
            <h2 className="font-headline text-3xl md:text-5xl font-bold tracking-tight text-on-surface">
              {t('demo.title')}
            </h2>
          </div>

          {/* Simulated Flow UI Preview */}
          <div className="bg-surface-container-low rounded-2xl md:rounded-3xl p-4 md:p-6 shadow-2xl relative overflow-hidden">
            <div className="flex items-center gap-2 mb-4 px-4 py-2 border-b border-outline-variant/10">
              <div className="w-3 h-3 rounded-full bg-error/40" />
              <div className="w-3 h-3 rounded-full bg-tertiary/40" />
              <div className="w-3 h-3 rounded-full bg-primary/40" />
              <span className="ml-4 text-[10px] md:text-xs text-on-surface-variant font-mono tracking-widest uppercase">
                flow.yaml
              </span>
            </div>
            <div className="aspect-video relative overflow-hidden rounded-lg md:rounded-xl bg-surface-container-lowest">
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <div className="glass-panel p-6 md:p-8 rounded-xl md:rounded-2xl border border-primary/20 animate-bounce-subtle mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[10px] md:text-xs font-bold text-primary uppercase tracking-widest">
                      {t('demo.nodeActive')}
                    </span>
                    <span className="material-symbols-outlined text-primary text-base md:text-lg animate-pulse">
                      settings_input_component
                    </span>
                  </div>
                  <div className="h-2 w-32 md:w-48 bg-surface-container-highest rounded-full overflow-hidden">
                    <div className="h-full w-3/4 bg-gradient-primary rounded-full animate-pulse-slow" />
                  </div>
                  <p className="text-[11px] md:text-xs mt-3 md:mt-4 text-on-surface-variant font-mono">
                    {t('demo.processing')}
                  </p>
                </div>
                
                <Link 
                  to="/demo" 
                  className="btn-primary text-lg md:text-xl py-5 px-12 md:px-16 flex items-center gap-3 shadow-2xl"
                >
                  <span className="material-symbols-outlined text-2xl">play_arrow</span>
                  {t('demo.start')}
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-16 md:py-40 bg-gradient-to-b from-surface-container-low to-background">
        <div className="max-w-4xl mx-auto px-6 md:px-12 text-center">
          <h2 className="font-headline text-4xl md:text-6xl font-bold tracking-tighter mb-8 md:mb-10 text-on-surface leading-tight">
            {t('cta.title')}
            <br />
            <span className="text-gradient">{t('cta.titleGradient')}</span>
          </h2>
          <div className="flex flex-col sm:flex-row justify-center gap-4 md:gap-6">
            <a
              href="https://github.com/pproject-github/agentflow"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary"
            >
              {t('cta.primary')}
              <span className="material-symbols-outlined ml-2">arrow_forward</span>
            </a>
            <Link to="/docs" className="btn-ghost">
              {t('cta.secondary')}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}