import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from '../components/CodeBlock.jsx';

const docsStructure = {
  en: [
    { slug: 'quickstart-pr-workflow.en', title: 'Quickstart: PR Workflow' },
    { slug: 'module-migration-workflow.en', title: 'Module Migration Workflow' },
    { slug: 'figma-ui-implementation-workflow.en', title: 'Figma UI Implementation' },
  ],
  zh: [
    { slug: 'quickstart-pr-workflow.zh-CN', title: '快速开始：PR 工作流' },
    { slug: 'module-migration-workflow.zh-CN', title: '模块迁移工作流' },
    { slug: 'figma-ui-implementation-workflow.zh-CN', title: 'Figma UI 实现' },
  ],
};

export default function Docs() {
  const { i18n } = useTranslation();
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [docContent, setDocContent] = useState('');
  const [loading, setLoading] = useState(false);

  const currentLang = i18n.language === 'zh' ? 'zh' : 'en';
  const docs = docsStructure[currentLang];

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    if (!selectedDoc) {
      setSelectedDoc(docs[0]);
    }
  }, [currentLang, docs]);

  useEffect(() => {
    if (selectedDoc) {
      setLoading(true);
      fetch(`/docs/${selectedDoc.slug}.md`)
        .then((res) => res.text())
        .then((text) => {
          setDocContent(text);
          setLoading(false);
        })
        .catch(() => {
          setDocContent('# Document not found');
          setLoading(false);
        });
    }
  }, [selectedDoc]);

  return (
    <div className="pt-20 md:pt-24 min-h-screen">
      <div className="max-w-7xl mx-auto px-6 md:px-12 py-8 md:py-12">
        <div className="flex flex-col lg:flex-row gap-8 md:gap-12">
          {/* Sidebar Navigation */}
          <div className="lg:w-64 flex-shrink-0">
            <div className="glass-panel rounded-2xl p-6 sticky top-24">
              <h2 className="font-headline text-xl font-bold mb-6 text-on-surface">
                {i18n.language === 'zh' ? '文档目录' : 'Documentation'}
              </h2>
              <nav className="space-y-2">
                {docs.map((doc) => (
                  <button
                    key={doc.slug}
                    onClick={() => setSelectedDoc(doc)}
                    className={`w-full text-left px-4 py-3 rounded-xl transition-colors ${
                      selectedDoc?.slug === doc.slug
                        ? 'bg-primary/20 text-primary font-bold'
                        : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-lg">description</span>
                      <span className="text-sm font-medium">{doc.title}</span>
                    </div>
                  </button>
                ))}
              </nav>

              {/* External Links */}
              <div className="mt-8 pt-6 border-t border-outline-variant/20">
                <h3 className="text-xs uppercase tracking-widest text-on-surface-variant mb-4">
                  {i18n.language === 'zh' ? '外部链接' : 'External Links'}
                </h3>
                <div className="space-y-2">
                  <a
                    href="https://github.com/pproject-github/agentflow"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-on-surface-variant hover:text-primary transition-colors"
                  >
                    <span className="material-symbols-outlined text-lg">code</span>
                    GitHub Repo
                  </a>
                  <Link
                    to="/demo"
                    className="flex items-center gap-2 text-sm text-on-surface-variant hover:text-primary transition-colors"
                  >
                    <span className="material-symbols-outlined text-lg">play_arrow</span>
                    {i18n.language === 'zh' ? '交互演示' : 'Live Demo'}
                  </Link>
                </div>
              </div>
            </div>
          </div>

          {/* Main Content */}
          <div className="flex-1 min-w-0">
            <div className="card-solid min-h-[60vh]">
              {loading ? (
                <div className="flex items-center justify-center py-20">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
                </div>
              ) : (
                <div className="markdown-body">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      code: CodeBlock,
                    }}
                  >
                    {docContent}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}