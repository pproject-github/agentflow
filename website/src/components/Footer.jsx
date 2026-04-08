import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function Footer() {
  const { t } = useTranslation();

  return (
    <footer className="w-full border-t border-outline-variant/10 bg-surface-container-low">
      <div className="max-w-7xl mx-auto px-6 md:px-12 py-12 md:py-16 flex flex-col md:flex-row justify-between items-center gap-6 md:gap-8">
        <div className="flex flex-col gap-3 md:gap-4">
          <Link to="/" className="flex items-center gap-2">
            <img src="/agentflow/logo-64.png" alt="AgentFlow" className="w-8 h-8 rounded-lg" />
            <div className="text-lg md:text-xl font-bold font-headline text-on-surface">
              AgentFlow
            </div>
          </Link>
          <p className="text-xs md:text-sm text-on-surface-variant uppercase tracking-widest">
            {t('footer.copyright')}
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-6 md:gap-12 text-xs md:text-sm uppercase tracking-widest">
          <Link 
            to="#" 
            className="text-on-surface-variant hover:text-primary transition-colors"
          >
            {t('footer.links.privacy')}
          </Link>
          <Link 
            to="#" 
            className="text-on-surface-variant hover:text-primary transition-colors"
          >
            {t('footer.links.terms')}
          </Link>
          <a 
            href="https://github.com/pproject-github/agentflow"
            target="_blank"
            rel="noopener noreferrer"
            className="text-on-surface-variant hover:text-primary transition-colors"
          >
            {t('footer.links.github')}
          </a>
        </div>
      </div>
    </footer>
  );
}