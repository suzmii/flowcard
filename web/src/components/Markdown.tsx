/**
 * 正文/评论的 markdown 渲染。
 *
 * XSS 面（刻意收窄）：
 * - 只开 `remark-gfm`（表格/删除线/任务列表这类语法糖），**不开 `rehype-raw`**：
 *   正文里的 `<script>`、`<img onerror=…>` 一律当纯文本转义输出，不会变成 DOM。
 * - `react-markdown` 自带的 `defaultUrlTransform` 会把 `javascript:`/`data:`(非图片) 之类的 href 抹掉，
 *   这里不额外放宽。
 * - 图片走 `<img>`（不是 dangerouslySetInnerHTML），相对地址 `/api/attachments/<id>` 在 dev 下由 vite proxy 转发、
 *   在生产下与服务同源，两种情况都能显示；若配了 `VITE_FLOWCARD_API` 绝对前缀，则把相对地址补成绝对。
 */
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1.5 leading-relaxed">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="break-all text-sky-700 underline underline-offset-2"
    >
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <img
      src={typeof src === "string" && src.startsWith("/") ? apiUrl(src) : src}
      alt={alt ?? ""}
      loading="lazy"
      className="my-2 max-w-full rounded-md border"
    />
  ),
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => <h1 className="mt-3 mb-1 text-sm font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1 text-sm font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 text-xs font-semibold">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 pl-2 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-border" />,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border bg-muted/50 p-2 text-[11px] [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{children}</code>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border bg-muted/60 px-1.5 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border px-1.5 py-1 align-top">{children}</td>,
};

/** 只渲染 markdown；原始 HTML 不解析（见文件头 XSS 说明）。 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("text-xs break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
