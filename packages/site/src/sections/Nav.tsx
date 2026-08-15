import { useEffect, useState } from "react";
import { GithubMark } from "@/components/Marks";
import { Wordmark } from "@app/components/Brand";
import { LINKS, cn } from "@/lib/utils";

export function Nav() {
  const [lifted, setLifted] = useState(false);

  useEffect(() => {
    const onScroll = () => setLifted(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        lifted && "border-border bg-background/70 border-b backdrop-blur-xl",
      )}
    >
      <nav className="mx-auto flex h-16 max-w-[1180px] items-center justify-between px-6">
        <a href="#top" className="transition-opacity hover:opacity-70">
          <Wordmark />
        </a>

        <div className="flex items-center gap-1.5">
          <a
            href={LINKS.repo}
            aria-label="Source on GitHub"
            className="text-muted-foreground hover:text-foreground rounded-lg px-3 py-2 transition-colors"
          >
            <GithubMark className="size-[15px]" />
          </a>
          <a href={LINKS.download} className="btn-primary h-9 px-4 text-[13.5px]">
            Download
          </a>
        </div>
      </nav>
    </header>
  );
}
