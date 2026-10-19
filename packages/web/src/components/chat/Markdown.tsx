import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeKatex]}
        components={{ div: ({ children }) => <div className="max-w-none">{children}</div> }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
