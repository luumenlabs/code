/**
 * Renderer state. The transcript is built and persisted by the main process, so
 * this only mirrors it: entries arrive already stored, and reopening a thread
 * replays them from disk.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AskRequest, ChangeRecord, OutputEntry, RevertOutcome, ServerEvent } from "@luumen/code-protocol";
import type { AgentEvent, AgentState, Attachment, TranscriptEntry } from "../shared/agent.js";
import type { HarnessSnapshot } from "../shared/bridge.js";
import { setModelCatalogue } from "../shared/models.js";
import type { ModelInfo, ModelSelection } from "../shared/models.js";
import { DEFAULT_SETTINGS } from "../shared/settings.js";
import type { AppSettings } from "../shared/settings.js";
import type { ThreadIndex } from "../shared/threads.js";
import { agentBehind, pluginWaiting } from "../shared/update.js";
import type { VersionStatus } from "../shared/update.js";

export type TimelineItem = TranscriptEntry;
export type { Attachment };

const MAX_OUTPUT = 500;

/** The states that mean a turn is in flight. */
export function isBusyState(state: AgentState | undefined): boolean {
  return state === "starting" || state === "thinking" || state === "working";
}

/**
 * What inside Settings is asking to be dealt with. The mark on the Settings
 * button and the marks on its sections are the same arithmetic, so they are
 * worked out once. The app's own update has its own row and is not counted.
 */
export function settingsWaiting(harness: Harness): { providers: number; plugin: number; total: number } {
  const providers = (harness.snapshot?.agents ?? []).filter(agentBehind).length;
  const plugin =
    harness.versions && harness.snapshot && pluginWaiting(harness.versions.plugin, harness.snapshot.channel) ? 1 : 0;

  return { providers, plugin, total: providers + plugin };
}

/** The version buttons. Each one returns the whole status. */
export interface VersionActions {
  checkForUpdate: () => Promise<VersionStatus>;
  downloadUpdate: () => Promise<VersionStatus>;
  installUpdate: () => Promise<VersionStatus>;
  installPlugin: () => Promise<VersionStatus>;
  uninstallPlugin: () => Promise<VersionStatus>;
}

export interface Harness {
  snapshot: HarnessSnapshot | null;
  timeline: TimelineItem[];
  output: OutputEntry[];
  threads: ThreadIndex | null;
  activeThreadId: string | null;
  /** What the installed CLIs offer right now. */
  models: ModelInfo[];
  /** Why the Codex list is the built-in fallback, when it is. */
  modelProblem: string | null;
  settings: AppSettings;
  updateSettings(patch: Partial<AppSettings>): void;
  resetSettings(): void;
  /** App update, Studio plugin, and the MCP command. Null until it arrives. */
  versions: VersionStatus | null;
  /** Runs one of the version actions and folds the result back in. */
  versionAction(action: keyof VersionActions): Promise<void>;
  /** The open conversation has a turn in flight. */
  busy: boolean;
  /** Every conversation's agent state, including the ones nobody is looking at. */
  agentStates: Record<string, AgentState>;
  runBusy: boolean;
  /**
   * Every change in the connected Studio window, oldest first — not only this
   * chat's. The place is shared.
   */
  changes: ChangeRecord[];
  /**
   * What this conversation changed, as stored with its transcript. `changes` is
   * the live journal and goes with the Studio window; this is read back from
   * disk. A record only here can be read but not put back.
   */
  history: ChangeRecord[];
  /** Change ids currently being put back, so their rows can say so. */
  reverting: string[];
  /**
   * Puts changes back, newest first. Resolves with what actually happened —
   * a conflict is an outcome, not a thrown error.
   */
  revert(ids: string[], force?: boolean): Promise<RevertOutcome[]>;
  /**
   * The question the open conversation is waiting on. One at a time: the agent
   * is stopped on it.
   */
  pendingAsk: AskRequest | null;
  modelSelection: ModelSelection | null;
  /** Applies a model and its options together, and the CLI that serves it. */
  applyModel(selection: ModelSelection): void;
  send(text: string, attachments?: Attachment[]): Promise<void>;
  interrupt(): Promise<void>;
  refresh(): Promise<void>;
  run(op: string, params?: unknown): Promise<unknown>;
  clearOutput(): void;
  newThread(): Promise<void>;
  openThread(id: string): Promise<void>;
  renameThread(id: string, title: string): Promise<void>;
  archiveThread(id: string, archived: boolean): Promise<void>;
  deleteThread(id: string): Promise<void>;
}

export function useHarness(): Harness {
  const [snapshot, setSnapshot] = useState<HarnessSnapshot | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [output, setOutput] = useState<OutputEntry[]>([]);
  const [threads, setThreads] = useState<ThreadIndex | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [modelSelection, setSelection] = useState<ModelSelection | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelProblem, setModelProblem] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [versions, setVersions] = useState<VersionStatus | null>(null);
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});
  const [changes, setChanges] = useState<ChangeRecord[]>([]);
  const [history, setHistory] = useState<ChangeRecord[]>([]);
  const [reverting, setReverting] = useState<string[]>([]);
  const [asks, setAsks] = useState<Record<string, AskRequest[]>>({});

  // Read through a ref so the subscription is set up once and still sees the
  // chat that is open now.
  const openThreadId = useRef<string | null>(null);
  openThreadId.current = activeThreadId;

  const refresh = useCallback(async () => {
    const next = await window.luuCode.snapshot();
    setSnapshot(next);
    setThreads(next.threads);
    setActiveThreadId(next.thread?.id ?? null);
    setTimeline(next.thread?.items ?? []);
    setHistory(next.thread?.changes ?? []);
    setAgentStates(next.agentStates);
    setSelection(next.modelSelection);
    setSettings(next.settings);
    setVersions(next.versions);
    setModelProblem(next.modelProblem);
    setAsks(next.pendingAsks);

    if (next.models.length > 0) {
      // Helpers resolve slugs through the shared catalogue.
      setModelCatalogue(next.models);
      setModels(next.models);
    }
  }, []);

  /**
   * Reads the journal for the window the open chat is working in. No `chat`
   * filter in the params: the routing argument picks the window, and the answer
   * is everything done to that place.
   */
  const loadChanges = useCallback(async (chat: string | null) => {
    try {
      const result = (await window.luuCode.execute("changes.list", {}, chat ?? undefined)) as {
        records?: ChangeRecord[];
      };
      setChanges(result?.records ?? []);
    } catch {
      // Studio not connected, or no window bound yet. The panel says so.
      setChanges([]);
    }
  }, []);

  /**
   * Insert or replace by id, keeping the list in the order things happened.
   * Applied to the stored copy as well as the live one, which the main process
   * is already writing to the thread file.
   */
  const mergeChanges = useCallback((incoming: ChangeRecord[]) => {
    const merge =
      (records: ChangeRecord[]) =>
      (current: ChangeRecord[]): ChangeRecord[] => {
        const byId = new Map(current.map((record) => [record.id, record]));
        for (const record of records) byId.set(record.id, record);
        return [...byId.values()].sort((left, right) => left.at - right.at);
      };

    setChanges(merge(incoming));

    // Only this chat's own; the journal covers every conversation in the
    // window. A record with no chat came from an external MCP client, and is
    // filed against whichever conversation is open.
    const mine = incoming.filter((record) => record.chat === null || record.chat === openThreadId.current);
    if (mine.length > 0) setHistory(merge(mine));
  }, []);

  const applyModel = useCallback(
    (selection: ModelSelection) => {
      // Optimistic: the picker settles on the click, not a round trip later.
      // A refused switch puts the chip back to what is actually running.
      const previous = modelSelection;

      setSelection(selection);
      void window.luuCode
        .applyModel(selection)
        .then(setSelection)
        .catch(() => setSelection(previous));
    },
    [modelSelection],
  );

  /**
   * Insert or replace by id, so an updated activity replaces its own row. An
   * entry for a chat that is not on screen is dropped; it is already on disk.
   */
  const upsert = useCallback(({ threadId, entry }: { threadId: string; entry: TimelineItem }) => {
    if (threadId !== openThreadId.current) return;

    setTimeline((current) => {
      const index = current.findIndex((item) => item.id === entry.id);
      if (index === -1) return [...current, entry];

      const updated = [...current];
      updated[index] = entry;
      return updated;
    });
  }, []);

  useEffect(() => {
    void refresh();
    void loadChanges(openThreadId.current);

    const offServer = window.luuCode.onServerEvent((event: ServerEvent) => {
      if (event.type === "status") {
        setSnapshot((current) => (current ? { ...current, status: event.status } : current));
      } else if (event.type === "capabilities") {
        setSnapshot((current) => (current ? { ...current, capabilities: event.report } : current));
      } else if (event.type === "output") {
        setOutput((current) => [...current, ...event.entries].slice(-MAX_OUTPUT));
      } else if (event.type === "changes") {
        mergeChanges(event.records);
      } else if (event.type === "changes.dropped") {
        // The window went away and took its journal with it. A second connected
        // place keeps its own.
        setChanges((current) => current.filter((record) => record.session !== event.session));
      } else if (event.type === "session.connected" || event.type === "session.disconnected") {
        void refresh();
        void loadChanges(openThreadId.current);
      }
    });

    const offAgent = window.luuCode.onAgentEvent(({ threadId, event }: { threadId: string; event: AgentEvent }) => {
      // Only the live state of the session on screen; the states map covers the
      // rest, and the transcript arrives separately.
      if (threadId !== openThreadId.current) return;

      if (event.type === "state") {
        setSnapshot((current) =>
          current ? { ...current, session: { ...current.session, state: event.state, message: event.message ?? null } } : current,
        );
      } else if (event.type === "session") {
        setSnapshot((current) =>
          current ? { ...current, session: { ...current.session, sessionId: event.sessionId, model: event.model } } : current,
        );
      }
    });

    const offAgentStates = window.luuCode.onAgentStates(setAgentStates);
    const offAsks = window.luuCode.onAsks(setAsks);

    const offTranscript = window.luuCode.onTranscript(upsert);
    const offThreads = window.luuCode.onThreadsChanged((index) => {
      setThreads(index);
      setActiveThreadId(index.activeThreadId);
    });

    // Discovery runs after the window opens, so the catalogue arrives late.
    const offCatalogue = window.luuCode.onCatalogue(({ models: discovered, problem }) => {
      setModelProblem(problem);
      if (discovered.length === 0) return;
      setModelCatalogue(discovered);
      setModels(discovered);
    });

    const offSettings = window.luuCode.onSettingsChanged(setSettings);
    const offSelection = window.luuCode.onModelSelectionChanged(setSelection);
    const offVersions = window.luuCode.onVersionStatus(setVersions);

    return () => {
      offServer();
      offAgent();
      offAgentStates();
      offAsks();
      offTranscript();
      offThreads();
      offCatalogue();
      offSettings();
      offSelection();
      offVersions();
    };
  }, [refresh, upsert, loadChanges, mergeChanges]);

  const versionAction = useCallback(async (action: keyof VersionActions) => {
    // Each answers with the whole status, so a failure leaves what is on screen.
    const next = await window.luuCode[action]().catch(() => null);
    if (next) setVersions(next);
  }, []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((current) => ({ ...current, ...patch }) as AppSettings);
    void window.luuCode.updateSettings(patch).then(setSettings).catch(() => undefined);
  }, []);

  const resetSettings = useCallback(() => {
    void window.luuCode.resetSettings().then(setSettings).catch(() => undefined);
  }, []);

  const send = useCallback(async (text: string, attachments?: Attachment[]) => {
    await window.luuCode.sendMessage(text, attachments);
  }, []);

  const interrupt = useCallback(async () => {
    await window.luuCode.interruptAgent();
  }, []);

  // Routed through the open chat, so Play starts the playtest in the Studio
  // window that chat's agent reaches.
  const run = useCallback(
    async (op: string, params?: unknown) => {
      const isRunOp = op.startsWith("run.");
      if (isRunOp) setRunBusy(true);

      try {
        return await window.luuCode.execute(op, params, activeThreadId ?? undefined);
      } finally {
        if (isRunOp) setRunBusy(false);
      }
    },
    [activeThreadId],
  );

  /**
   * Puts changes back. The server orders them and sends the touched records
   * over the event stream, so all that is kept here is which rows are
   * mid-flight. A conflict resolves with a conflict outcome, not a throw.
   */
  const revert = useCallback(
    async (ids: string[], force = false): Promise<RevertOutcome[]> => {
      if (ids.length === 0) return [];
      setReverting((current) => [...current, ...ids]);

      try {
        const result = (await window.luuCode.execute(
          "changes.revert",
          { ids, force },
          activeThreadId ?? undefined,
        )) as { outcomes?: RevertOutcome[] };
        return result?.outcomes ?? [];
      } catch (error) {
        // A throw is the whole call failing, so it applies to every id.
        const reason = error instanceof Error ? error.message : String(error);
        return ids.map((id) => ({ id, status: "failed" as const, reason }));
      } finally {
        setReverting((current) => current.filter((id) => !ids.includes(id)));
      }
    },
    [activeThreadId],
  );

  const clearOutput = useCallback(() => {
    setOutput([]);
    void window.luuCode.clearStudioOutput(activeThreadId ?? undefined).catch(() => undefined);
  }, [activeThreadId]);

  const newThread = useCallback(async () => {
    // Set first: entries still arriving from the chat being left must not land
    // in the empty draft.
    openThreadId.current = null;
    setActiveThreadId(null);
    // A draft has no stored transcript to replay, and the model carries over.
    setTimeline([]);
    setHistory([]);
    await window.luuCode.newThread();
  }, []);

  const openThread = useCallback(
    async (id: string) => {
      // Claim the id before awaiting: a chat that is still working streams
      // entries the whole time.
      openThreadId.current = id;

      const thread = await window.luuCode.openThread(id);
      if (!thread) return;

      setTimeline(thread.items);
      setHistory(thread.changes ?? []);
      setActiveThreadId(thread.id);
      setSelection(thread.modelSelection);
      await refresh();
      // Chats can be bound to different Studio windows, so the journal is read
      // again for the one this conversation works in.
      await loadChanges(id);
    },
    [refresh, loadChanges],
  );

  const renameThread = useCallback(async (id: string, title: string) => {
    setThreads(await window.luuCode.renameThread(id, title));
  }, []);

  const archiveThread = useCallback(async (id: string, archived: boolean) => {
    setThreads(await window.luuCode.archiveThread(id, archived));
  }, []);

  const deleteThread = useCallback(
    async (id: string) => {
      const index = await window.luuCode.deleteThread(id);
      setThreads(index);
      if (activeThreadId === id) {
        setTimeline([]);
        setHistory([]);
        setActiveThreadId(index.activeThreadId);
      }
      await refresh();
    },
    [activeThreadId, refresh],
  );

  // The states map is the authority: keyed by conversation and updated for
  // every session. A draft has no session yet, so it is never busy.
  const busy = useMemo(
    () => isBusyState(activeThreadId ? agentStates[activeThreadId] : undefined),
    [activeThreadId, agentStates],
  );

  const pendingAsk = useMemo(
    () => (activeThreadId ? (asks[activeThreadId]?.[0] ?? null) : null),
    [asks, activeThreadId],
  );

  /*
    One object, rebuilt only when something in it actually changed. It is passed
    whole to most of the tree, so a fresh literal every render defeats every
    `React.memo` and `useMemo` downstream that takes it as a dependency.
  */
  return useMemo<Harness>(() => ({
    snapshot,
    timeline,
    output,
    threads,
    activeThreadId,
    models,
    modelProblem,
    settings,
    updateSettings,
    resetSettings,
    versions,
    versionAction,
    busy,
    agentStates,
    runBusy,
    changes,
    history,
    reverting,
    revert,
    pendingAsk,
    modelSelection,
    applyModel,
    send,
    interrupt,
    refresh,
    run,
    clearOutput,
    newThread,
    openThread,
    renameThread,
    archiveThread,
    deleteThread,
  }), [
    snapshot,
    timeline,
    output,
    threads,
    activeThreadId,
    models,
    modelProblem,
    settings,
    updateSettings,
    resetSettings,
    versions,
    versionAction,
    busy,
    agentStates,
    runBusy,
    changes,
    history,
    reverting,
    revert,
    pendingAsk,
    modelSelection,
    applyModel,
    send,
    interrupt,
    refresh,
    run,
    clearOutput,
    newThread,
    openThread,
    renameThread,
    archiveThread,
    deleteThread,
  ]);
}
