import * as React from "react";
import { Camera, ChevronDown, Eye, Gamepad2, MonitorPlay, Pencil, ShieldCheck, SlidersHorizontal, SquareTerminal, Store } from "lucide-react";
import { Reveal } from "@/components/Reveal";
import { Switch } from "@app/components/ui/switch";

/** The composer's own permission list. Mirrors AccessChip. */
const PERMISSIONS: { label: string; detail: string; icon: React.ElementType; on: boolean }[] = [
  { label: "Look around", detail: "Read instances, scripts, and runtime state", icon: Eye, on: true },
  { label: "Change the place", detail: "Create, edit, and delete", icon: Pencil, on: true },
  { label: "Playtest", detail: "Start, stop, and run tests", icon: MonitorPlay, on: true },
  { label: "Run Luau", detail: "Execute code in your session", icon: SquareTerminal, on: true },
  { label: "Play the game", detail: "Click and type in the running game", icon: Gamepad2, on: true },
  { label: "See your place", detail: "Screenshots and camera", icon: Camera, on: true },
  { label: "Use the store", detail: "Search the Creator Store and insert assets", icon: Store, on: false },
];

const FACTS = [
  ["127.0.0.1", "The plugin connects to the server on this machine."],
  ["Nothing is sent anywhere", "No telemetry, no relay, no account."],
  ["No files touched", "Luu Code works through Studio. It does not read or write your files."],
];

export function Access() {
  return (
    <section id="access" className="relative py-28 sm:py-36">
      <div className="mx-auto max-w-[1180px] px-6">
        <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-20">
          <Reveal>
            <h2 className="text-[clamp(2rem,4.4vw,3.1rem)] leading-[1.05]">Turn anything off, mid-conversation.</h2>
            <p className="text-muted-foreground mt-5 max-w-[460px] text-[16.5px] leading-relaxed">
              The agent is told what it no longer has.
            </p>
          </Reveal>

          <Reveal delay={100}>
            <AccessCard />
          </Reveal>
        </div>

        <Reveal delay={60} className="mt-16">
          <div className="border-border overflow-hidden rounded-2xl border">
            <div className="-ml-px grid grid-cols-1 sm:grid-cols-3">
              {FACTS.map(([head, body]) => (
                <div key={head} className="border-border border-t border-l px-6 py-6 first:border-t-0 sm:border-t-0">
                  <p className="text-primary font-mono text-[12px] tracking-wide">{head}</p>
                  <p className="text-muted-foreground mt-2 text-[14.5px] leading-relaxed">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/** The chip, open. */
function AccessCard() {
  return (
    <div className="mx-auto flex max-w-[340px] flex-col items-start gap-2">
      <div className="bg-popover border-border overflow-hidden rounded-lg border shadow-lg">
        <div className="flex items-center justify-between gap-2 border-b py-1.5 pr-1.5 pl-3">
          <span className="text-[13px] font-medium">Agent access</span>
          <span className="text-muted-foreground flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px]">
            <SlidersHorizontal className="size-3" />
            Advanced
          </span>
        </div>

        <div className="p-1">
          {PERMISSIONS.map(({ label, detail, icon: Icon, on }) => (
            <div key={label} className="hover:bg-accent/60 flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors">
              <Icon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-tight">{label}</span>
                <span className="text-muted-foreground mt-0.5 block text-[11.5px] leading-tight">{detail}</span>
              </span>
              <Switch className="shrink-0" checked={on} tabIndex={-1} aria-hidden onCheckedChange={() => {}} />
            </div>
          ))}
        </div>
      </div>

      {/* The trigger, as the composer shows it. */}
      <span className="text-muted-foreground flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px]">
        <ShieldCheck className="size-3.5" />
        6 of 7
        <ChevronDown className="size-3 opacity-60" />
      </span>
    </div>
  );
}
