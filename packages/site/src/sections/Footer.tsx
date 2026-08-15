import { GithubMark } from "@/components/Marks";
import { Wordmark } from "@app/components/Brand";
import { LINKS } from "@/lib/utils";

const NAV = [
  { label: "Download", href: LINKS.download },
  { label: "Releases", href: LINKS.releases },
  { label: "Source", href: LINKS.repo },
  { label: "Contributing", href: LINKS.contributing },
  { label: "Luumen", href: LINKS.luumen },
];

export function Footer() {
  return (
    <footer className="border-border border-t">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Wordmark />
          <span className="text-dim font-mono text-[11.5px]">MIT · Luumen Labs</span>
        </div>

        <nav className="flex flex-wrap items-center gap-x-7 gap-y-3">
          {NAV.map(({ label, href }) => (
            <a
              key={label}
              href={href}
              className="text-muted-foreground hover:text-foreground text-[13.5px] transition-colors"
            >
              {label}
            </a>
          ))}
          <a
            href={LINKS.repo}
            aria-label="GitHub"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <GithubMark className="size-4" />
          </a>
        </nav>
      </div>
    </footer>
  );
}
