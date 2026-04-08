import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from './LanguageSwitcher.jsx';

export default function Navbar() {
  const { t } = useTranslation();
  const location = useLocation();

  const navItems = [
    { path: '/', label: t('nav.home') },
    { path: '/docs', label: t('nav.docs') },
    { path: '/demo', label: t('nav.demo') },
  ];

  return (
    <nav className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-xl border-b border-outline-variant/10">
      <div className="max-w-7xl mx-auto px-6 md:px-12 py-4 md:py-6 flex justify-between items-center">
        <Link to="/" className="flex items-center gap-3 group">
          <img 
            src="/agentflow/logo-64.png" 
            alt="AgentFlow" 
            className="w-10 h-10 md:w-12 md:h-12 rounded-xl group-hover:scale-105 transition-transform"
          />
          <div className="hidden sm:block text-xl md:text-2xl font-black tracking-tighter font-headline text-on-surface">
            AgentFlow
          </div>
        </Link>

        <div className="hidden md:flex gap-8 md:gap-12">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`nav-link ${location.pathname === item.path ? 'text-primary' : ''}`}
            >
              {item.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-4 md:gap-6">
          <LanguageSwitcher />
          <a
            href="https://github.com/pproject-github/agentflow"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-on-surface-variant hover:text-on-surface transition-colors font-headline font-medium"
          >
            <span className="material-symbols-outlined text-xl">code</span>
            <span className="hidden sm:inline">{t('nav.github')}</span>
          </a>
        </div>
      </div>
    </nav>
  );
}