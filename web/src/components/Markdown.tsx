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
 * - `blockRemoteImages`（远端评论用）：**第三方图片只给可点链接、不给 `src`** —— 自动加载等于把
 *   "这台机器看过这条评论" 发给第三方（IP / Referer / cookie 都跟着走）。本地附件不受影响。
 */
import type { ReactNode } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageOff } from "lucide-react";
import { apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * 图片：本地附件（`/api/attachments/…`）正常显示；
 * `blockRemoteImages` 下**第三方图片不自动加载**（一加载就等于告诉第三方"这台机器看过这条评论"），
 * 渲染成占位 + 可点链接，人想看图自己点。
 * 第三方 = 绝对 http(s) 或协议相对 `//host/...`；本地 `/api/…` 相对地址不算。
 */
function renderImage(
  src: string | undefined,
  alt: string | undefined,
  blockRemoteImages: boolean,
): ReactNode {
  if (typeof src !== "string" || src === "") return null;
  if (blockRemoteImages && /^(https?:)?\/\//i.test(src)) {
    return (
      <span className="my-2 flex flex-wrap items-center gap-1.5 rounded-md border border-dashed bg-muted/40 p-1.5 text-[11px] text-muted-foreground">
        <ImageOff className="size-3.5 shrink-0" />
        <span>远端图片默认不自动加载（隐私），要看请点链接：</span>
        <a
          href={src}
          target="_blank"
          rel="noreferrer noopener"
          className="break-all text-sky-700 underline underline-offset-2"
          data-testid="remote-image-link"
        >
          {alt && alt.trim() !== "" ? alt : src}
        </a>
      </span>
    );
  }
  return (
    <img
      src={src.startsWith("/") ? apiUrl(src) : src}
      alt={alt ?? ""}
      loading="lazy"
      className="my-2 max-w-full rounded-md border"
    />
  );
}

function makeComponents(blockRemoteImages: boolean): Components {
  return {
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
    img: ({ src, alt }) => renderImage(typeof src === "string" ? src : undefined, alt, blockRemoteImages),
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
}

const LOCAL_COMPONENTS = makeComponents(false);
const REMOTE_COMPONENTS = makeComponents(true);

/**
 * 只渲染 markdown；原始 HTML 不解析（见文件头 XSS 说明）。
 * `blockRemoteImages`：远端内容（别人写的评论）用，第三方图片只给链接不给 `src`。
 */
export function Markdown({
  text,
  className,
  blockRemoteImages,
}: {
  text: string;
  className?: string;
  blockRemoteImages?: boolean;
}) {
  return (
    <div className={cn("text-xs break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={blockRemoteImages ? REMOTE_COMPONENTS : LOCAL_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
