/**
 * Renderer state.
 *
 * The transcript is built and persisted by the main process, so this only
 * mirrors it: entries arrive already stored, and reopening a thread replays
 * them from disk. That keeps what the user sees and what survives a restart
 * identical. Spec sections 33 and 45.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { OutputEntry, PairingRequest, ServerEvent } from "@luumen/code-protocol";
import type { AgentEvent, Attachment, TranscriptEntry } from "../shared/agent.js";
import type { HarnessSnapshot } from "../shared/bridge.js";
import { createSelection, findModel, setModelCatalogue } from "../shared/models.js";
import type { ModelInfo, ModelSelection } from "../shared/models.js";
import { DEFAULT_SETTINGS } from "../shared/settings.js";
import type { AppSettings } from "../shared/settings.js";
import type { ThreadIndex } from "../shared/threads.js";

export type TimelineItem = TranscriptEntry;
export type { Attachment };

const MAX_OUTPUT = 500;

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
  busy: boolean;
  runBusy: boolean;
  pendingPairing: PairingRequest | null;
  modelSelection: ModelSelection | null;
  setModelSelection(selection: ModelSelection): void;
  /** Picks a model, and with it the CLI that serves it. */
  chooseModel(slug: string): void;
  send(text: string, attachments?: Attachment[]): Promise<void>;
  interrupt(): Promise<void>;
  refresh(): Promise<void>;
  run(op: string, params?: unknown): Promise<unknown>;
  clearOutput(): void;
  newThread(): Promise<void>;
  openThread(id: string): Promise<void>;
  renameThread(id: string, title: string): Promise<void>;
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

  const refresh = useCallback(async () => {
    const next = await window.luuCode.snapshot();
    setSnapshot(next);
    setThreads(next.threads);
    setActiveThreadId(next.thread?.id ?? null);
    setTimeline(next.thread?.items ?? []);
    setSelection(next.modelSelection);
    setSettings(next.settings);
    setModelProblem(next.modelProblem);

    if (next.models.length > 0) {
      // Adapters and helpers resolve slugs through the shared catalogue, so
      // the renderer's copy has to match what the main process discovered.
      setModelCatalogue(next.models);
      setModels(next.models);
    }
  }, []);

  const setModelSelection = useCallback((selection: ModelSelection) => {
    // Optimistic: the picker should feel instant, and the main process is
    // writing the same value to the thread.
    setSelection(selection);
    void window.luuCode.setModel(selection).catch(() => undefined);
  }, []);

  /** Insert or replace by id, so an updated activity replaces its own row. */
  const upsert = useCallback((entry: TimelineItem) => {
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

    const offServer = window.luuCode.onServerEvent((event: ServerEvent) => {
      if (event.type === "status") {
        setSnapshot((current) => (current ? { ...current, status: event.status } : current));
      } else if (event.type === "capabilities") {
        setSnapshot((current) => (current ? { ...current, capabilities: event.report } : current));
      } else if (event.type === "output") {
        setOutput((current) => [...current, ...event.entries].slice(-MAX_OUTPUT));
      } else if (event.type === "session.connected" || event.type === "session.disconnected" || event.type === "pairing.requested") {
        void refresh();
      }
    });

    const offAgent = window.luuCode.onAgentEvent((event: AgentEvent) => {
      // The transcript arrives separately, already persisted; this only tracks
      // the session's live state.
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

    return () => {
      offServer();
      offAgent();
      offTranscript();
      offThreads();
      offCatalogue();
      offSettings();
      offSelection();
    };
  }, [refresh, upsert]);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((current) => ({ ...current, ...patch }) as AppSettings);
    void window.luuCode.updateSettings(patch).then(setSettings).catch(() => undefined);
  }, []);

  const resetSettings = useCallback(() => {
    void window.luuCode.resetSettings().then(setSettings).catch(() => undefined);
  }, []);

  const chooseModel = useCallback((slug: string) => {
    // Optimistic, like setModelSelection: the picker should close on the value
    // the user just clicked, not a round trip later.
    setSelection(createSelection(findModel(slug)?.provider ?? "claude", slug));
    void window.luuCode.chooseModel(slug).then(setSelection).catch(() => undefined);
  }, []);

  const send = useCallback(async (text: string, attachments?: Attachment[]) => {
    await window.luuCode.sendMessage(text, attachments);
  }, []);

  const interrupt = useCallback(async () => {
    await window.luuCode.interruptAgent();
  }, []);

  const run = useCallback(async (op: string, params?: unknown) => {
    const isRunOp = op.startsWith("run.");
    if (isRunOp) setRunBusy(true);

    try {
      return await window.luuCode.execute(op, params);
    } finally {
      if (isRunOp) setRunBusy(false);
    }
  }, []);

  const clearOutput = useCallback(() => {
    setOutput([]);
    void window.luuCode.execute("output.clear", {}).catch(() => undefined);
  }, []);

  const newThread = useCallback(async () => {
    await window.luuCode.newThread();
    // A draft has no stored transcript to replay, and the model carries over.
    setTimeline([]);
    setActiveThreadId(null);
  }, []);

  const openThread = useCallback(
    async (id: string) => {
      const thread = await window.luuCode.openThread(id);
      if (!thread) return;
      setTimeline(thread.items);
      setActiveThreadId(thread.id);
      setSelection(thread.modelSelection);
      await refresh();
    },
    [refresh],
  );

  const renameThread = useCallback(async (id: string, title: string) => {
    setThreads(await window.luuCode.renameThread(id, title));
  }, []);

  const deleteThread = useCallback(
    async (id: string) => {
      const index = await window.luuCode.deleteThread(id);
      setThreads(index);
      if (activeThreadId === id) {
        setTimeline([]);
        setActiveThreadId(index.activeThreadId);
      }
      await refresh();
    },
    [activeThreadId, refresh],
  );

  const busy = useMemo(() => {
    const state = snapshot?.session.state;
    return state === "thinking" || state === "working" || state === "starting";
  }, [snapshot?.session.state]);

  const pendingPairing = useMemo(() => snapshot?.status.pending[0] ?? null, [snapshot?.status.pending]);

  return {
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
    busy,
    runBusy,
    pendingPairing,
    modelSelection,
    setModelSelection,
    chooseModel,
    send,
    interrupt,
    refresh,
    run,
    clearOutput,
    newThread,
    openThread,
    renameThread,
    deleteThread,
  };
}
