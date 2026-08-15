import { Camera, Eye, Gamepad2, MonitorPlay, Pencil, ScrollText } from "lucide-react";
import { Reveal } from "@/components/Reveal";
import { BrandMark } from "@app/components/Brand";
import { Badge } from "@app/components/ui/badge";
import { cn } from "@/lib/utils";

/** Category glyph and tone, as the transcript draws them. */
const CATEGORY = {
  inspect: { icon: Eye, tone: "text-sky-400/90" },
  edit: { icon: Pencil, tone: "text-violet-400/90" },
  playtest: { icon: MonitorPlay, tone: "text-[var(--success)]" },
  output: { icon: ScrollText, tone: "text-muted-foreground" },
  visual: { icon: Camera, tone: "text-[var(--warning)]" },
  input: { icon: Gamepad2, tone: "text-cyan-400/90" },
} as const;

const TURN: { category: keyof typeof CATEGORY; title: string; detail: string }[] = [
  { category: "inspect", title: "Read Source on Pollen.PollenLeaderstats", detail: "88 lines" },
  { category: "edit", title: "Changed Source on Pollen.PollenLeaderstats", detail: "Seeds the counter from the profile" },
  { category: "playtest", title: "Started a playtest", detail: "Server and one client" },
  { category: "input", title: "Clicked Buy", detail: "ShopGui.Buy" },
  { category: "output", title: "Read output", detail: "No errors" },
  { category: "visual", title: "Screenshot", detail: "Studio" },
];

export function Playtest() {
  return (
    <section id="playtest" className="relative py-28 sm:py-36">
      <div className="mx-auto grid max-w-[1180px] items-center gap-14 px-6 lg:grid-cols-2 lg:gap-20">
        <Reveal>
          <TurnCard />
        </Reveal>

        <Reveal delay={100} className="lg:pl-4">
          <h2 className="text-[clamp(2rem,4.4vw,3.1rem)] leading-[1.05]">It plays the game it just changed.</h2>
          <p className="text-muted-foreground mt-5 max-w-[460px] text-[16.5px] leading-relaxed">
            It presses Play, waits for the game to be ready, reads what Studio printed, clicks the button that broke,
            and goes again.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/** One turn, in the transcript's own rows. */
function TurnCard() {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="absolute inset-6 -z-10 rounded-full blur-[80px]"
        style={{
          background: "radial-gradient(closest-side, color-mix(in srgb, var(--primary) 16%, transparent), transparent)",
        }}
      />
      <div className="panel overflow-hidden rounded-2xl">
        <header className="border-border flex items-center gap-2 border-b px-4 py-2.5">
          <BrandMark className="size-4" />
          <span className="text-[13.5px] font-medium">Pollen counter desyncs</span>
          <span className="flex-1" />
          <Badge variant="success">Done</Badge>
        </header>

        <ol className="flex flex-col gap-0.5 p-2.5">
          {TURN.map(({ category, title, detail }, i) => {
            const { icon: Icon, tone } = CATEGORY[category];
            return (
              <Reveal key={title} as="li" delay={160 + i * 90}>
                <div className="bg-card/60 hover:bg-card flex items-center gap-2 rounded-lg py-1.5 pr-2.5 pl-2.5 transition-colors">
                  <Icon className={cn("size-3.5 shrink-0", tone)} />
                  <span className="min-w-0 shrink truncate text-[13.5px] font-medium">{title}</span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-[12px]">{detail}</span>
                </div>
              </Reveal>
            );
          })}
        </ol>

        <footer className="border-border flex items-center gap-2 border-t px-4 py-2.5">
          <span className="text-muted-foreground text-[12px]">3 of 3 applied</span>
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
            <span className="text-[var(--success)]">+12</span>
            <span className="text-destructive">−4</span>
          </span>
        </footer>
      </div>
    </div>
  );
}
