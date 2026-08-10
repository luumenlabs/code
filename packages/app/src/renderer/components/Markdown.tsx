import * as React from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * Agent output, rendered as the Markdown it actually is.
 *
 * Both CLIs write Markdown — headings, lists, tables, inline code — and the
 * earlier hand-rolled pass understood only fenced blocks, so everything else
 * arrived as literal `**bold**` and `- ` bullets. That was a deliberate call to
 * avoid a parser and its attack surface; `react-markdown` answers the second
 * half of it, because it builds React elements from an AST and never sets
 * innerHTML. Raw HTML in the source is escaped rather than parsed, so a model
 * emitting a `<script>` tag produces the text of one.
 *
 * `remark-breaks` is here to preserve what the old renderer did: Markdown folds
 * a single newline into a space, which would silently reflow a two-line answer
 * into one. In a chat transcript the line the model wrote is the line to show.
 *
 * The element map keeps the app's own scale. Prose defaults are built for
 * articles, and an `h1` sized for one would tower over a 14px conversation.
 */
const MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks];

const MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <p className="my-0">{children}</p>,

  h1: ({ children }) => <h1 className="mt-1 text-[16px] font-semibold tracking-tight">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-1 text-[15px] font-semibold tracking-tight">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-1 text-[14px] font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-1 text-[14px] font-medium">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-1 text-[13.5px] font-medium">{children}</h5>,
  h6: ({ children }) => (
    <h6 className="mt-1 text-[13px] font-medium text-muted-foreground">{children}</h6>
  ),

  ul: ({ children }) => <ul className="my-0 list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>,
  ol: ({ children }) => <ol className="my-0 list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>,
  li: ({ children }) => <li className="[&>ul]:mt-1 [&>ol]:mt-1">{children}</li>,

  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),

  hr: () => <hr className="border-border" />,

  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,

  /**
   * Off to the browser, never into this window.
   *
   * `target="_blank"` routes the click through the main process's window-open
   * handler, which hands it to the OS and denies the window. A bare href would
   * be a same-window navigation, and the app has no way back from one.
   */
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-primary underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),

  /**
   * Inline code and fenced blocks arrive as the same element; only a block has
   * a language class or a newline in it.
   */
  code: ({ className, children }) => {
    const text = String(children);
    const fenced = /language-/.test(className ?? "") || text.includes("\n");

    if (!fenced) {
      return (
        <code className="rounded bg-muted px-1 py-px font-mono text-[12.5px] break-words">{children}</code>
      );
    }

    return (
      <code className="block font-mono text-[12.5px] leading-relaxed">{text.replace(/\n$/, "")}</code>
    );
  },

  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2.5">{children}</pre>
  ),

  // GitHub-flavoured tables. Scrolled rather than squeezed: the column is only
  // ~800px, and a wrapped table cell is harder to read than a sideways one.
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/40">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b px-2.5 py-1.5 text-left font-medium whitespace-nowrap">{children}</th>
  ),
  td: ({ children }) => <td className="border-b px-2.5 py-1.5 align-top last:border-r-0">{children}</td>,
};

export function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="selectable flex flex-col gap-2 text-[14px] leading-relaxed">
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
