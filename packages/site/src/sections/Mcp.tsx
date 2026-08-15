import { Reveal } from "@/components/Reveal";

export function Mcp() {
  return (
    <section id="mcp" className="relative pb-28 sm:pb-36">
      <div className="mx-auto max-w-[1180px] px-6">
        <Reveal>
          <div className="panel grid gap-10 rounded-2xl p-7 sm:p-10 lg:grid-cols-[1fr_1.05fr] lg:items-center lg:gap-14">
            <div>
              <h2 className="text-[clamp(1.7rem,3.2vw,2.4rem)] leading-[1.08]">The same tools, over MCP.</h2>
              <p className="text-muted-foreground mt-4 max-w-[430px] text-[15.5px] leading-relaxed">
                The server ships inside Luu Code. <span className="text-foreground">Settings → Connection</span> has
                the command for your install. Only Studio has to be open.
              </p>
            </div>

            <div className="border-border overflow-hidden rounded-xl border bg-black/40">
              <div className="border-border flex items-center gap-1.5 border-b px-4 py-2.5">
                <span className="bg-foreground/15 size-2.5 rounded-full" />
                <span className="bg-foreground/15 size-2.5 rounded-full" />
                <span className="bg-foreground/15 size-2.5 rounded-full" />
              </div>
              <pre className="overflow-x-auto px-5 py-5 font-mono text-[12.5px] leading-[1.9]">
                <code>
                  <span className="text-dim">$ </span>
                  <span>claude mcp add luu-code </span>
                  <span className="text-dim">\</span>
                  {"\n"}
                  <span>    -e ELECTRON_RUN_AS_NODE=1 -- </span>
                  <span className="text-primary">&lt;your install&gt;</span>
                  {"\n\n"}
                  <span className="text-[var(--success)]">✓ </span>
                  <span className="text-muted-foreground">luu-code · connected</span>
                </code>
              </pre>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
