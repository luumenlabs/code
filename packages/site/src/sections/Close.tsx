import { WindowsMark } from "@/components/Marks";
import { Reveal } from "@/components/Reveal";
import { LINKS } from "@/lib/utils";

/** The composer's own examples, drawn as its example chips. */
const EXAMPLES = [
  "Fix the error when I click Buy",
  "Make the inventory UI open and close",
  "Brighten the lobby, then screenshot it",
];

export function Close() {
  return (
    <section className="relative isolate overflow-hidden py-32 sm:py-44">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div
          className="grid-lines absolute inset-0"
          style={{ maskImage: "radial-gradient(ellipse 60% 70% at 50% 60%, #000 10%, transparent 70%)" }}
        />
        <div
          className="absolute bottom-[-340px] left-1/2 h-[640px] w-[1000px] -translate-x-1/2 rounded-[50%] blur-[110px]"
          style={{
            background:
              "radial-gradient(closest-side, color-mix(in srgb, var(--primary) 24%, transparent), transparent)",
            animation: "pulse-glow 7s ease-in-out infinite",
          }}
        />
      </div>

      <div className="mx-auto max-w-[1180px] px-6 text-center">
        <Reveal>
          <h2 className="mx-auto max-w-[760px] text-[clamp(2.3rem,6vw,4.1rem)] leading-[1.02]">
            Open your place. Say what you want changed.
          </h2>

          <div className="mt-9 flex flex-wrap justify-center gap-1.5">
            {EXAMPLES.map((example) => (
              <span
                key={example}
                className="text-muted-foreground rounded-full border px-3 py-1.5 text-[13px]"
              >
                {example}
              </span>
            ))}
          </div>
        </Reveal>

        <Reveal delay={120}>
          <div className="mt-12 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a href={LINKS.download} className="btn-primary w-full sm:w-auto">
              <WindowsMark className="size-[15px]" />
              Download for Windows
            </a>
            <a href={LINKS.releases} className="btn-ghost w-full sm:w-auto">
              Nightly builds
            </a>
          </div>
          <p className="text-dim mt-6 font-mono text-[11.5px] tracking-wide">Windows · MIT licensed</p>
        </Reveal>
      </div>
    </section>
  );
}
