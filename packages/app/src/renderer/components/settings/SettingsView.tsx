/**
 * Settings.
 *
 * Deliberately short: every row here is something a user has a reason to
 * change. Anything Luu Code can work out for itself — which CLIs exist, which
 * models they offer, which place is connected — is shown as fact, not asked as
 * a question.
 */
import * as React from "react";
import {
  ArrowLeft,
  Blocks,
  Bot,
  Check,
  CircleCheck,
  CircleX,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Link2,
  Loader2,
  RefreshCw,
  RotateCcw,
  Settings2,
  Shield,
  Sparkles,
} from "lucide-react";
import { PERMISSION_GROUPS } from "@luumen/code-protocol";
import type { PermissionGroup } from "@luumen/code-protocol";
import { DEFAULT_TITLE_MODEL, autoTitleProvider } from "../../../shared/settings.js";
import type { Channel, PluginStatus, UpdateStatus } from "../../../shared/update.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Hint } from "@/components/ui/tooltip";
import { PROVIDER_LABEL, ProviderIcon } from "@/components/ProviderIcon";
import { cn } from "@/lib/utils";
import type { Harness } from "@/state";

export type Section = "general" | "providers" | "permissions" | "connection" | "updates";

const SECTIONS: Array<{ id: Section; label: string; icon: React.ElementType }> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "providers", label: "Providers", icon: Bot },
  { id: "permissions", label: "Permissions", icon: Shield },
  { id: "connection", label: "Connection", icon: Link2 },
  { id: "updates", label: "Updates", icon: Download },
];

const PERMISSION_COPY: Record<PermissionGroup, { label: string; detail: string }> = {
  inspect: { label: "Look around", detail: "Read your instances, scripts, and what the game is doing" },
  edit: { label: "Change the place", detail: "Create, edit, and delete instances and scripts" },
  playtest: { label: "Playtest", detail: "Start and stop the game" },
  exec: { label: "Run Luau", detail: "Run code inside your Studio session" },
  input: { label: "Play the game", detail: "Click and type in the running game" },
  screenshot: { label: "Screenshots", detail: "See your Studio window" },
};

export function SettingsView({
  harness,
  section,
  onSectionChange,
  onClose,
}: {
  harness: Harness;
  /** Controlled, so the update notice in the sidebar can open straight here. */
  section: Section;
  onSectionChange: (section: Section) => void;
  onClose: () => void;
}): React.JSX.Element {
  const setSection = onSectionChange;

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* The thread list stays where it is, so the sections run across the top
          rather than adding a second sidebar beside the first. */}
      <div className="flex h-topbar shrink-0 items-center gap-1 border-b px-3">
        <Button variant="ghost" size="icon-sm" onClick={onClose} title="Back to chat">
          <ArrowLeft />
        </Button>

        <span className="mx-1 h-4 w-px bg-border" />

        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setSection(id)}
            data-active={section === id}
            className="row flex items-center gap-1.5 px-2 py-1 text-[13.5px]"
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            {label}
          </button>
        ))}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-[640px] px-8 py-8">
          {section === "general" && <General harness={harness} />}
          {section === "providers" && <Providers harness={harness} />}
          {section === "permissions" && <Permissions harness={harness} />}
          {section === "connection" && <Connection harness={harness} />}
          {section === "updates" && <Updates harness={harness} />}
        </div>
      </ScrollArea>
    </main>
  );
}

function General({ harness }: { harness: Harness }): React.JSX.Element {
  const { settings, models } = harness;
  const title = settings.titleGeneration;

  // Only offer models from a CLI that is actually here.
  const installed = harness.snapshot?.agents.filter((agent) => agent.installed).map((agent) => agent.id) ?? [];
  const candidates = models.filter((model) => installed.includes(model.provider));

  /**
   * What "leave it to Luu Code" actually resolves to.
   *
   * The default is a specific model, so it says which one. Hiding it behind
   * "Automatic" only raises the question it was trying to avoid.
   */
  const autoProvider = autoTitleProvider(installed) ?? "codex";
  const autoSlug = DEFAULT_TITLE_MODEL[autoProvider];
  const autoLabel = `${models.find((model) => model.slug === autoSlug)?.name ?? autoSlug} · default`;

  // The model implies the CLI, here as everywhere else: picking GPT means Codex
  // runs the call, picking Claude means Claude Code does.
  const chooseTitleModel = (slug: string): void => {
    const provider = models.find((model) => model.slug === slug)?.provider;
    harness.updateSettings({
      titleGeneration: { ...title, provider: provider ?? "auto", model: slug === "" ? null : slug },
    });
  };

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
      <Row label="Name chats automatically" detail="Writes a title from your first message.">
        <Switch
          checked={title.enabled}
          onCheckedChange={(enabled) =>
            harness.updateSettings({ titleGeneration: { ...title, enabled } })
          }
        />
      </Row>

      {title.enabled && (
        <Row label="Naming model" detail="A small, fast one is plenty.">
          <Select
            value={title.model ?? ""}
            onChange={chooseTitleModel}
            options={[
              { value: "", label: autoLabel },
              ...candidates.map((model) => ({
                value: model.slug,
                label: `${model.name} · ${PROVIDER_LABEL[model.provider]}`,
              })),
            ]}
          />
        </Row>
      )}

      <Row label="Show the agent's thinking" detail="Its reasoning appears in the chat as it works.">
        <Switch
          checked={settings.showThinking}
          onCheckedChange={(showThinking) => harness.updateSettings({ showThinking })}
        />
      </Row>

      <Row label="Jump to output on an error" detail="Opens the Output tab when the running game throws.">
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
      description="Luu Code drives the coding agents already on this machine. No API key, ever."
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
              <span className="text-[14px] font-medium">{agent.label}</span>
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

            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
              {agent.installed
                ? `${models.length} model${models.length === 1 ? "" : "s"} available.`
                : `${agent.problem ?? ""} ${agent.installHint}`}
            </p>

            {agent.installed && models.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {models.map((model) => (
                  <span
                    key={model.slug}
                    className={cn(
                      "rounded border px-1.5 py-px font-mono text-[11px] text-muted-foreground",
                      model.legacy && "opacity-55",
                    )}
                  >
                    {model.slug}
                  </span>
                ))}
              </div>
            )}

            {agent.id === "codex" && harness.modelProblem && (
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--warning)]">
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
      description="What the agent is allowed to do to your place. Also on the chip beside the send button."
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

/**
 * Versions, in one place.
 *
 * The app, the Studio plugin, and the MCP command are three copies of the same
 * release, and every confusing failure in this product comes from them being
 * three different ones. So they are shown together, with the same version
 * number visible on each.
 */
function Updates({ harness }: { harness: Harness }): React.JSX.Element {
  const versions = harness.versions;

  if (!versions) {
    return (
      <Panel title="Updates">
        <p className="py-3 text-[13px] text-muted-foreground">Reading versions…</p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Updates"
      description="The app, the Studio plugin, and the MCP command ship together, so they can never disagree on a version."
    >
      <AppUpdate harness={harness} status={versions.update} />
      <StudioPlugin harness={harness} status={versions.plugin} />
    </Panel>
  );
}

const CHANNEL_LABEL: Record<Channel, string> = {
  release: "Release",
  nightly: "Nightly",
  dev: "Dev",
};

/**
 * Only the surprising channels say anything.
 *
 * A release build explaining that it updates from the release channel is a
 * sentence every user reads once and learns nothing from. A nightly that never
 * offers a release, and a dev build with its own chats, are the two cases where
 * someone would otherwise think something is broken.
 */
const CHANNEL_NOTE: Partial<Record<Channel, string>> = {
  nightly: "Nightly builds only update to other nightlies, and install beside a release build.",
  dev: "Running from source, with its own chats, settings, and Studio plugin.",
};

function AppUpdate({ harness, status }: { harness: Harness; status: UpdateStatus }): React.JSX.Element {
  const [busy, setBusy] = React.useState<string | null>(null);

  const run = async (action: "checkForUpdate" | "downloadUpdate" | "installUpdate"): Promise<void> => {
    setBusy(action);
    try {
      await harness.versionAction(action);
    } finally {
      setBusy(null);
    }
  };

  const detail =
    status.state === "ready"
      ? `${status.availableVersion} is downloaded and installs on restart.`
      : status.state === "downloading"
        ? `Downloading ${status.availableVersion}… ${status.percent}%`
        : status.state === "available"
          ? `${status.availableVersion} is available.`
          : status.state === "checking"
            ? "Checking…"
            : status.state === "unsupported"
              ? (status.message ?? "")
              : status.checkedAt
                ? `Up to date. Last checked ${relative(status.checkedAt)}.`
                : "Up to date.";

  return (
    <div className="border-b py-4">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-medium">Luu Code {status.currentVersion}</span>
            <Badge variant={status.channel === "release" ? "outline" : "primary"}>{CHANNEL_LABEL[status.channel]}</Badge>
          </div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{detail}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          {status.state === "ready" ? (
            <Button size="sm" onClick={() => void run("installUpdate")} disabled={busy !== null}>
              Restart and install
            </Button>
          ) : status.state === "available" ? (
            <Button size="sm" onClick={() => void run("downloadUpdate")} disabled={busy !== null}>
              {busy === "downloadUpdate" ? <Loader2 className="animate-spin" /> : <Download />}
              Download
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void run("checkForUpdate")}
              disabled={busy !== null || status.state === "unsupported" || status.state === "downloading"}
            >
              {busy === "checkForUpdate" || status.state === "checking" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              Check for updates
            </Button>
          )}
        </div>
      </div>

      {CHANNEL_NOTE[status.channel] && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{CHANNEL_NOTE[status.channel]}</p>
      )}

      {status.state === "downloading" && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${status.percent}%` }} />
        </div>
      )}

      {status.state === "error" && status.message && (
        <div className="mt-2 flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2">
          <p className="text-[12.5px] leading-relaxed text-destructive">{status.message}</p>
          <Button variant="ghost" size="sm" onClick={() => void window.luuCode.openReleases()}>
            <ExternalLink />
            Releases
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The plugin, installed by the app rather than downloaded by hand.
 *
 * This writes into the user's Roblox Studio folder, which is not the app's
 * property, so nothing happens here until a button is pressed or the switch is
 * turned on.
 */
function StudioPlugin({ harness, status }: { harness: Harness; status: PluginStatus }): React.JSX.Element {
  const [busy, setBusy] = React.useState(false);

  const install = async (): Promise<void> => {
    setBusy(true);
    try {
      await harness.versionAction("installPlugin");
    } finally {
      setBusy(false);
    }
  };

  const matched = status.installed && status.installedVersion === status.bundledVersion;
  const canInstall = status.supported && status.bundledVersion !== null;
  const isDev = harness.snapshot?.channel === "dev";

  // The main process already says why it cannot install, when it cannot. The
  // renderer used to carry its own copy of one of those sentences, which meant
  // two places could disagree about the reason.
  const detail =
    status.message ??
    (!status.installed
      ? `Not installed yet. This build carries ${status.bundledVersion}.`
      : matched
        ? `${status.installedVersion} installed — the same version as the app.`
        : `${status.installedVersion ?? "An older build"} installed. This app carries ${status.bundledVersion}.`);

  return (
    <div className="py-4">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Blocks className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-[13.5px] font-medium">Studio plugin</span>
            {matched && (
              <Badge variant="success">
                <CircleCheck className="size-3" />
                Matched
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{detail}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          {status.directory && (
            <Hint label="Plugins folder">
              <Button variant="ghost" size="icon-sm" onClick={() => void window.luuCode.revealPluginFolder()}>
                <FolderOpen />
              </Button>
            </Hint>
          )}
          <Button
            size="sm"
            variant={matched ? "outline" : "default"}
            onClick={() => void install()}
            disabled={busy || !canInstall}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Download />}
            {!status.installed ? "Install" : matched ? "Reinstall" : "Update plugin"}
          </Button>
        </div>
      </div>

      {status.directory && (
        <p className="mt-1.5 truncate font-mono text-[11.5px] text-muted-foreground">
          {/* Windows and macOS disagree about the separator, and this is a real
              path the user may want to go and look at. */}
          {status.directory}
          {status.directory.includes("\\") ? "\\" : "/"}
          {status.fileName}
        </p>
      )}

      <div className="mt-3 flex items-start justify-between gap-6 border-t pt-3">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium">Keep the plugin matching the app</div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {/* On a dev build the plugin belongs to `luu dev`, which rebuilds it
                on every save. Reinstalling over that would undo the watch. */}
            {isDev
              ? "Off on a dev build: `luu dev` owns the plugin here and rebuilds it on every save."
              : "Reinstalls it whenever Luu Code updates. Studio loads the new one next time it starts."}
          </p>
        </div>
        <div className="shrink-0 pt-0.5">
          <Switch
            checked={harness.settings.plugin.autoInstall && !isDev}
            disabled={!canInstall || isDev}
            onCheckedChange={(autoInstall) => harness.updateSettings({ plugin: { autoInstall } })}
          />
        </div>
      </div>
    </div>
  );
}

/** Rough, and only used for "last checked" — minutes are as precise as it gets. */
function relative(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function Connection({ harness }: { harness: Harness }): React.JSX.Element {
  const snapshot = harness.snapshot;
  const sessions = snapshot?.status.sessions ?? [];

  return (
    <Panel
      title="Connection"
      description="Studio talks to a server running inside this app. Nothing leaves your machine."
    >
      <Fact label="Server" value={`127.0.0.1:${snapshot?.serverPort ?? "—"}`} />
      <Fact label="Studio windows" value={sessions.length === 0 ? "None connected" : `${sessions.length} connected`} />

      {/* The MCP server ships inside the app, so these point at the app's own
          copy. Nothing to install, and it can never be a different version
          from the app that printed it. */}
      <div className="border-b py-4">
        <div className="text-[13.5px] font-medium">Use these tools from your own terminal</div>
        <p className="mt-0.5 mb-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
          Any MCP-capable agent can drive the same Roblox operations. Nothing to install — this runs the copy that
          shipped with the app.
        </p>

        <Snippet
          label="Claude Code"
          value={`claude mcp add luu-code -e ELECTRON_RUN_AS_NODE=1 -- ${snapshot?.mcpCommand ?? ""}`}
        />
        <Snippet
          label="Codex — ~/.codex/config.toml"
          value={codexSnippet(snapshot?.mcpCommand ?? "")}
        />
      </div>

      {sessions.map((session) => (
        <div key={session.id} className="border-b py-3 last:border-b-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-primary" />
            <span className="text-[13.5px] font-medium">{session.place.name}</span>
            {session.active && <Badge variant="outline">Active</Badge>}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">
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
          <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-1 max-w-[46ch] text-[13px] leading-relaxed text-muted-foreground">{description}</p>
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
        <div className="text-[13.5px] font-medium">{label}</div>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{detail}</p>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

/**
 * The command line as a TOML table.
 *
 * The command and its script are two separate values to Codex, so the single
 * quoted string the Claude form uses has to be taken back apart.
 */
function codexSnippet(command: string): string {
  const parts = command.match(/"[^"]*"|\S+/g) ?? [];
  const unquote = (value: string): string => value.replace(/^"|"$/g, "");
  const [executable, ...args] = parts.map(unquote);

  return [
    "[mcp_servers.luu-code]",
    `command = ${JSON.stringify(executable ?? "")}`,
    `args = [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    'env = { ELECTRON_RUN_AS_NODE = "1" }',
  ].join("\n");
}

function Snippet({ label, value }: { label: string; value: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="mt-2 first:mt-0">
      <div className="eyebrow mb-1">{label}</div>
      <div className="flex items-start gap-1 rounded-md border bg-background p-1.5">
        <code className="selectable min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-muted-foreground">
          {value}
        </code>
        <Button variant="ghost" size="icon-sm" onClick={() => void copy()}>
          {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 border-b py-2.5">
      <span className="text-[13.5px]">{label}</span>
      <span className="font-mono text-[12.5px] text-muted-foreground">{value}</span>
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
        "h-7 min-w-[160px] rounded-md border bg-background px-2 text-[13px] outline-none",
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
