import screenshot from "@assets/screenshot.webp";
import { WindowsMark } from "@/components/Marks";
import { LINKS } from "@/lib/utils";

export function Hero() {
  return (
    <section id="top" className="relative isolate overflow-hidden pb-20 sm:pb-28">
      <Backdrop />

      <div className="relative mx-auto max-w-[760px] px-6 pt-36 text-center sm:pt-44">
        <h1 className="rise text-[clamp(2.6rem,7.4vw,4.9rem)] leading-[0.96]" style={{ animationDelay: "40ms" }}>
          The agent that
          <br />
          can press{" "}
          <span className="relative whitespace-nowrap">
            Play
            <span className="from-primary/0 via-primary to-primary/0 absolute -bottom-1 left-0 h-px w-full bg-gradient-to-r" />
          </span>
          .
        </h1>

        <p
          className="rise text-muted-foreground mx-auto mt-7 max-w-[560px] text-[17px] leading-relaxed text-balance"
          style={{ animationDelay: "140ms" }}
        >
          Luu Code hands Claude Code, Codex, or a model on your own machine the keys to your open place. It reads the
          DataModel, edits scripts, playtests, and fixes what it broke.
        </p>

        <div
          className="rise mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
          style={{ animationDelay: "240ms" }}
        >
          <a href={LINKS.download} className="btn-primary w-full sm:w-auto">
            <WindowsMark className="size-[15px]" />
            Download for Windows
          </a>
          <a href={LINKS.repo} className="btn-ghost w-full sm:w-auto">
            Source
          </a>
        </div>
      </div>

      <Shot />
    </section>
  );
}

/** Grid, filament and bloom. Nothing here is interactive. */
function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
      <div
        className="grid-lines absolute inset-x-0 top-0 h-[900px]"
        style={{ maskImage: "radial-gradient(ellipse 76% 62% at 50% 8%, #000 15%, transparent 72%)" }}
      />
      <div
        className="absolute top-[-260px] left-1/2 h-[620px] w-[1100px] -translate-x-1/2 rounded-[50%] blur-[110px]"
        style={{
          background: "radial-gradient(closest-side, color-mix(in srgb, var(--primary) 26%, transparent), transparent)",
          animation: "pulse-glow 7s ease-in-out infinite",
        }}
      />
      <div className="from-background absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t to-transparent" />
    </div>
  );
}

function Shot() {
  return (
    <div className="relative mx-auto mt-16 max-w-[1120px] px-6 sm:mt-20">
      <div
        aria-hidden
        className="absolute inset-x-16 top-8 bottom-8 -z-10 rounded-full blur-[90px]"
        style={{
          background: "radial-gradient(closest-side, color-mix(in srgb, var(--primary) 22%, transparent), transparent)",
        }}
      />
      <div
        className="rise grain panel relative overflow-hidden rounded-2xl p-1.5 shadow-[0_40px_120px_-30px_rgb(0_0_0/0.9)]"
        style={{ animationDelay: "400ms", animationDuration: "1.4s" }}
      >
        <img
          src={screenshot}
          width={1440}
          height={900}
          alt="Luu Code with a Roblox place open: a thread on the left, an agent mid-turn editing a script and starting a playtest, and the diffs it has made to the place in the panel on the right"
          className="border-border block w-full rounded-xl border"
        />
      </div>
    </div>
  );
}
