import {
  Activity,
  Camera,
  Eye,
  Gamepad2,
  MonitorPlay,
  Pencil,
  ScrollText,
  SquareTerminal,
  Store,
  type LucideIcon,
} from "lucide-react";
import { Reveal } from "@/components/Reveal";

/** The nine groups from the README, with the app's glyph for each. */
const CAPABILITIES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Eye,
    title: "Look around",
    body: "Services, instance trees, properties, attributes, tags, your selection, script source, what a class actually has.",
  },
  {
    icon: Pencil,
    title: "Change things",
    body: "Create, delete, rename, reparent, clone, set properties, edit scripts, replace a pattern across every script at once.",
  },
  {
    icon: MonitorPlay,
    title: "Playtest",
    body: "Start and stop Play and Run mode, restart, wait for the game to be ready, give the link real latency.",
  },
  {
    icon: ScrollText,
    title: "Read output",
    body: "Everything Studio prints, including the error your last change caused and the ones from before it connected.",
  },
  {
    icon: Activity,
    title: "Work out why",
    body: "Log any line without touching the script, and profile which functions the frame time went into.",
  },
  {
    icon: SquareTerminal,
    title: "Poke the game",
    body: "Players, characters, PlayerGui, the camera, and Luau it runs live.",
  },
  { icon: Camera, title: "See the screen", body: "Screenshots of Studio, handed straight to the agent." },
  { icon: Gamepad2, title: "Play the game", body: "Keyboard, mouse, and clicks on real on-screen buttons." },
  {
    icon: Store,
    title: "Bring things in",
    body: "Search the Creator Store and drop models, meshes, images, audio, and animations into the place.",
  },
];

export function Capabilities() {
  return (
    <section id="capabilities" className="relative py-28 sm:py-36">
      <div className="mx-auto max-w-[1180px] px-6">
        <Reveal>
          <h2 className="max-w-[640px] text-[clamp(2rem,4.4vw,3.1rem)] leading-[1.05]">What the agent can do</h2>
        </Reveal>

        {/* Hairlines instead of gaps: one instrument, not nine cards. */}
        <Reveal delay={80} className="mt-12">
          <div className="border-border overflow-hidden rounded-2xl border">
            {/* The negative offset tucks the first row and column under the
                container's own border, so no line is ever drawn twice. */}
            <div className="-mt-px -ml-px grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map(({ icon: Icon, title, body }, i) => (
                <article
                  key={title}
                  className="group border-border hover:bg-accent/40 border-t border-l p-7 transition-colors duration-300"
                >
                  <div className="flex items-center justify-between">
                    <Icon
                      className="text-muted-foreground group-hover:text-primary size-[19px] transition-colors duration-300"
                      strokeWidth={1.5}
                    />
                    <span className="text-dim group-hover:text-primary/70 font-mono text-[11px] tabular-nums transition-colors duration-300">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <h3 className="mt-5 text-[17px] font-semibold tracking-[-0.01em]">{title}</h3>
                  <p className="text-muted-foreground mt-2 text-[14.5px] leading-relaxed">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
