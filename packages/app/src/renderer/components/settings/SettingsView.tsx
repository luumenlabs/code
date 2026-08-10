/**
 * Settings.
 *
 * Sectioned rather than a single scrolling wall, and deliberately short: every
 * row here is something a user has a reason to change. Anything Luu Code can
 * work out for itself — which CLIs exist, which models they offer, which place
 * is connected — is shown as fact, not asked as a question.
 */
import * as React from "react";
import {
  ArrowLeft,
  Bot,
  CircleCheck,
  CircleX,
  Link2,
  Loader2,
  RotateCcw,
  Settings2,
  Shield,
  Sparkles,
} from "lucide-react";
import { PERMISSION_GROUPS } from "@luumen/code-protocol";
import type { PermissionGroup } from "@luumen/code-protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { PROVIDER_LABEL, ProviderIcon } from "@/components/ProviderIcon";
import { cn } from "@/lib/utils";
import type { AgentId } from "../../../shared/agent.js";
import { DEFAULT_TITLE_MODEL } from "../../../shared/settings.js";
import type { Harness } from "@/state";

type Section = "general" | "providers" | "permissions" | "connection";

const SECTIONS: Array<{ id: Section; label: string; icon: React.ElementType }> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "providers", label: "Providers", icon: Bot },
  { id: "permissions", label: "Permissions", icon: Shield },
  { id: "connection", label: "Connection", icon: Link2 },
];

const PERMISSION_COPY: Record<PermissionGroup, { label: string; detail: string }> = {
  inspect: { label: "Inspect Studio", detail: "Read the DataModel, scripts, and runtime state" },
  edit: { label: "Edit the place", detail: "Create, change, and delete instances and scripts" },
  playtest: { label: "Playtest", detail: "Start and stop the game" },
  exec: { label: "Run Luau", detail: "Execute code inside your Studio session" },
  input: { label: "Send input", detail: "Click and type in the running game" },
  screenshot: { label: "Screenshots", detail: "Capture the Studio window" },
};

export function SettingsView({ harness, onClose }: { harness: Harness; onClose: () => void }): React.JSX.Element {
  const [section, setSection] = React.useState<Section>("general");

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="flex w-sidebar shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-2">
        <div className="flex flex-col gap-0.5">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              data-active={section === id}
              className="row flex items-center gap-2 px-2 py-1.5 text-left text-[12.5px]"
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <Button variant="ghost" size="sm" className="justify-start" onClick={onClose}>
          <ArrowLeft />
          Back to chat
        </Button>
      </aside>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-[640px] px-8 py-8">
          {section === "general" && <General harness={harness} />}
          {section === "providers" && <Providers harness={harness} />}
          {section === "permissions" && <Permissions harness={harness} />}
          {section === "connection" && <Connection harness={harness} />}
        </div>
      </ScrollArea>
    </div>
  );
}

function General({ harness }: { harness: Harness }): React.JSX.Element {
  const { settings, models } = harness;
  const title = settings.titleGeneration;

  // Only offer models from a CLI that is actually here, and prefer the small
  // ones: a title is not worth a frontier model's time or the user's.
  const installed = harness.snapshot?.agents.filter((agent) => agent.installed).map((agent) => agent.id) ?? [];
  const candidates = models.filter((model) => installed.includes(model.provider));

  const provider: AgentId | null =
    title.provider !== "auto" ? title.provider : (candidates[0]?.provider ?? null);

  return (
    <Panel
      title="General"
      action={
        <Button variant="ghost" size="sm" onClick={harness.resetSettings}>
          <RotateCcw />
          Restore defaults
        </Button>
      }
    >
      <Row
        label="Name conversations automatically"
        detail="After the first message, a small model reads it once and names the thread. Costs one cheap call per conversation."
      >
        <Switch
          checked={title.enabled}
          onCheckedChange={(enabled) =>
            harness.updateSettings({ titleGeneration: { ...title, enabled } })
          }
        />
      </Row>

      {title.enabled && (
        <>
          <Row label="Naming runs on" detail="Which CLI makes the call. Automatic uses the one the thread is already using.">
            <Select
              value={title.provider}
              onChange={(value) =>
                harness.updateSettings({
                  titleGeneration: { ...title, provider: value as AgentId | "auto", model: null },
                })
              }
              options={[
                { value: "auto", label: "Automatic" },
                ...installed.map((id) => ({ value: id, label: PROVIDER_LABEL[id] })),
              ]}
            />
          </Row>

          <Row label="Naming model" detail="Small and fast is the right trade here; the title is three words.">
            <Select
              value={title.model ?? ""}
              onChange={(value) =>
                harness.updateSettings({ titleGeneration: { ...title, model: value === "" ? null : value } })
              }
              options={[
                {
                  value: "",
                  label: provider ? `Default (${DEFAULT_TITLE_MODEL[provider]})` : "Default",
                },
                ...candidates
                  .filter((model) => title.provider === "auto" || model.provider === title.provider)
                  .map((model) => ({ value: model.slug, label: model.name })),
              ]}
            />
          </Row>
        </>
      )}

      <Row label="Show the agent's reasoning" detail="Thinking appears in the transcript instead of being folded away.">
        <Switch
          checked={settings.showThinking}
          onCheckedChange={(showThinking) => harness.updateSettings({ showThinking })}
        />
      </Row>

      <Row
        label="Jump to output on the first error"
        detail="A runtime error opens the Output tab, since it is usually what the agent is about to react to."
      >
        <Switch
          checked={settings.followRuntimeErrors}
          onCheckedChange={(followRuntimeErrors) => harness.updateSettings({ followRuntimeErrors })}
        />
      </Row>
    </Panel>
  );
}

function Providers({ harness }: { harness: Harness }): React.JSX.Element {
  const [refreshing, setRefreshing] = React.useState(false);
  const agents = harness.snapshot?.agents ?? [];

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await window.luuCode.refreshAgents();
      await harness.refresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Panel
      title="Providers"
      description="Luu Code drives the coding agents you already have. It never asks for an API key and never proxies a model."
      action={
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          Refresh
        </Button>
      }
    >
      {agents.map((agent) => {
        const models = harness.models.filter((model) => model.provider === agent.id);

        return (
          <div key={agent.id} className="border-b py-4 last:border-b-0">
            <div className="flex items-center gap-2.5">
              <ProviderIcon provider={agent.id} className="size-4 shrink-0" />
              <span className="text-[13px] font-medium">{agent.label}</span>
              {agent.installed ? (
                <Badge variant="success">
                  <CircleCheck className="size-3" />
                  {agent.version ?? "installed"}
                </Badge>
              ) : (
                <Badge variant="warning">
                  <CircleX className="size-3" />
                  Not installed
                </Badge>
              )}
            </div>

            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
              {agent.installed
                ? `${models.length} model${models.length === 1 ? "" : "s"} available${
                    agent.id === "codex" ? ", read from the CLI itself" : ", filtered by your CLI version"
                  }.`
                : `${agent.problem ?? ""} ${agent.installHint}`}
            </p>

            {agent.installed && models.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {models.map((model) => (
                  <span
                    key={model.slug}
                    className={cn(
                      "rounded border px-1.5 py-px font-mono text-[10px] text-muted-foreground",
                      model.legacy && "opacity-55",
                    )}
                  >
                    {model.slug}
                  </span>
                ))}
              </div>
            )}

            {agent.id === "codex" && harness.modelProblem && (
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--warning)]">
                Showing built-in defaults: {harness.modelProblem}
              </p>
            )}
          </div>
        );
      })}
    </Panel>
  );
}

function Permissions({ harness }: { harness: Harness }): React.JSX.Element {
  const permissions = harness.snapshot?.capabilities.permissions;

  return (
    <Panel
      title="Permissions"
      description="What the agent may do to the connected place. These apply to every conversation and can also be changed from the composer."
    >
      {PERMISSION_GROUPS.map((group) => (
        <Row key={group} label={PERMISSION_COPY[group].label} detail={PERMISSION_COPY[group].detail}>
          <Switch
            checked={permissions?.[group] !== false}
            onCheckedChange={(allowed) => void window.luuCode.setPermission(group, allowed)}
          />
        </Row>
      ))}
    </Panel>
  );
}

function Connection({ harness }: { harness: Harness }): React.JSX.Element {
  const snapshot = harness.snapshot;
  const sessions = snapshot?.status.sessions ?? [];

  return (
    <Panel
      title="Connection"
      description="Studio connects to a server running inside this app. Nothing leaves your machine."
    >
      <Fact label="Server" value={`127.0.0.1:${snapshot?.serverPort ?? "—"}`} />
      <Fact label="MCP command" value={snapshot?.mcpCommand ?? "—"} />
      <Fact label="Plugin sessions" value={sessions.length === 0 ? "None connected" : `${sessions.length} connected`} />

      {sessions.map((session) => (
        <div key={session.id} className="border-b py-3 last:border-b-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-primary" />
            <span className="text-[12.5px] font-medium">{session.place.name}</span>
            {session.active && <Badge variant="outline">Active</Badge>}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {session.place.placeId > 0 ? `Place ${session.place.placeId}` : "Unsaved place"} · Studio{" "}
            {session.studioVersion} · plugin {session.pluginVersion} ·{" "}
            {session.endpoints.map((endpoint) => endpoint.realm).join(", ")}
          </p>
        </div>
      ))}
    </Panel>
  );
}

function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section>
      <header className="flex items-start justify-between gap-4 pb-1">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-1 max-w-[46ch] text-[12px] leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </header>

      <div className="mt-4">{children}</div>
    </section>
  );
}

function Row({
  label,
  detail,
  children,
}: {
  label: string;
  detail: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-6 border-b py-3.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium">{label}</div>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{detail}</p>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 border-b py-2.5">
      <span className="text-[12.5px]">{label}</span>
      <span className="font-mono text-[11.5px] text-muted-foreground">{value}</span>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}): React.JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "h-7 min-w-[160px] rounded-md border bg-background px-2 text-[12px] outline-none",
        "focus-visible:ring-[2px] focus-visible:ring-ring/60",
      )}
      style={{ cursor: "pointer" }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
