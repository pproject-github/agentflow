import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from '../components/CodeBlock.jsx';

export default function DocDetail() {
  const { lang, slug } = useParams();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/docs/${slug}.md`)
      .then((res) => {
        if (!res.ok) throw new Error('Document not found');
        return res.text();
      })
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [slug]);

  return (
    <div className="pt-20 md:pt-24 min-h-screen">
      <div className="max-w-4xl mx-auto px-6 md:px-12 py-8 md:py-12">
        {/* Back Link */}
        <Link 
          to="/docs" 
          className="flex items-center gap-2 text-on-surface-variant hover:text-primary transition-colors mb-8"
        >
          <span className="material-symbols-outlined">arrow_back</span>
          <span className="font-headline font-medium">Back to Docs</span>
        </Link>

        {/* Document Content */}
        <div className="card-solid min-h-[60vh]">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-20">
              <span className="material-symbols-outlined text-6xl text-error mb-4">error</span>
              <p className="text-error font-headline text-xl">{error}</p>
            </div>
          ) : (
<div className="markdown-body">
            <ReactMarkdown 
              remarkPlugins={[remarkGfm]}
              components={{
                code: CodeBlock,
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}