import { Reveal } from "@/components/Reveal";
import { AnthropicMark, OllamaMark, OpenAiMark } from "@app/components/ProviderIcon";

const AGENTS = [
  { mark: AnthropicMark, name: "Claude Code" },
  { mark: OpenAiMark, name: "Codex" },
  { mark: OllamaMark, name: "Ollama" },
];

const NOTES = ["No API key", "No credits", "No AI of its own"];

export function Agents() {
  return (
    <section id="agents" className="relative py-28 sm:py-36">
      <div className="mx-auto max-w-[1180px] px-6">
        <Reveal className="max-w-[620px]">
          <h2 className="text-[clamp(2rem,4.4vw,3.1rem)] leading-[1.05]">
            You bring the agent. Luu Code brings Studio.
          </h2>
          <p className="text-muted-foreground mt-5 text-[16.5px] leading-relaxed">
            Claude Code, Codex, or a model on your own machine through Ollama.
          </p>
        </Reveal>

        <Reveal delay={80} className="mt-12">
          <div className="border-border overflow-hidden rounded-2xl border">
            <div className="-ml-px grid grid-cols-1 sm:grid-cols-3">
              {AGENTS.map(({ mark: Mark, name }) => (
                <div
                  key={name}
                  className="group border-border hover:bg-accent/40 flex items-center gap-4 border-t border-l px-6 py-6 transition-colors duration-300 first:border-t-0 sm:border-t-0"
                >
                  <span className="border-border bg-accent/40 group-hover:border-input grid size-10 shrink-0 place-items-center rounded-xl border transition-colors duration-300">
                    <Mark className="size-[18px]" />
                  </span>
                  <span className="text-[15px] font-semibold tracking-[-0.01em]">{name}</span>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal delay={140}>
          <ul className="text-dim mt-8 flex flex-wrap items-center gap-x-8 gap-y-3 font-mono text-[11.5px]">
            {NOTES.map((note) => (
              <li key={note} className="flex items-center gap-2.5">
                <span className="bg-primary/70 size-1 rounded-full" />
                {note}
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
