/**
 * Turning protocol operations into Roblox language. Spec section 33.
 *
 * The user should read "Changed Source on ServerScriptService.Shop", not
 * "script.patch ok". Titles are produced from the request so they can be shown
 * the moment an operation starts, and refined from the result when it lands.
 */
import type { ActivityEvent, InstanceRef, Op } from "@luumen/code-protocol";
import { formatValue } from "@luumen/code-protocol";

type Category = ActivityEvent["category"];

const CATEGORIES: Record<string, Category> = {
  dm: "inspect",
  script: "inspect",
  run: "playtest",
  output: "output",
  runtime: "runtime",
  input: "input",
  view: "visual",
  session: "inspect",
  changes: "edit",
  perf: "inspect",
  test: "runtime",
};

const MUTATING_PREFIXES = ["dm.set", "dm.create", "dm.delete", "dm.rename", "dm.reparent", "dm.clone", "dm.attributes", "dm.tags", "dm.batch", "script.set", "script.patch", "script.create"];

export function categoryFor(op: Op): Category {
  // Reading the journal is a read, whatever its namespace suggests.
  if (op === "changes.list") return "inspect";
  if (MUTATING_PREFIXES.some((prefix) => op.startsWith(prefix))) return "edit";
  if (op === "dm.selection.set") return "edit";
  if (op === "view.screenshot") return "visual";
  const namespace = op.split(".")[0] ?? "";
  return CATEGORIES[namespace] ?? "inspect";
}

function targetName(params: Record<string, unknown>): string {
  const target = params.target ?? params.parent ?? params.scope;
  return typeof target === "string" ? target : "the DataModel";
}

/** Short label shown while the operation is still running. */
export function titleFor(op: Op, params: Record<string, unknown>): string {
  switch (op) {
    case "dm.services":
      return "Listing Studio services";
    case "dm.get":
      return `Inspecting ${targetName(params)}`;
    case "dm.children":
      return `Listing children of ${targetName(params)}`;
    case "dm.tree":
      return `Reading the tree under ${targetName(params)}`;
    case "dm.search": {
      const parts = [params.name, params.className, params.tag].filter(Boolean).join(" ");
      return `Searching for ${parts || "instances"}`;
    }
    case "dm.properties":
      return `Reading properties of ${targetName(params)}`;
    case "dm.selection.get":
      return "Reading the Studio selection";
    case "dm.selection.set":
      return "Selecting instances in Studio";
    case "dm.set_properties": {
      const names = Object.keys((params.properties as Record<string, unknown>) ?? {});
      return `Setting ${formatList(names)} on ${targetName(params)}`;
    }
    case "dm.create":
      return `Creating a ${String(params.className ?? "instance")} in ${targetName(params)}`;
    case "dm.delete": {
      const targets = (params.targets as string[]) ?? [];
      return targets.length === 1 ? `Deleting ${targets[0]}` : `Deleting ${targets.length} instances`;
    }
    case "dm.rename":
      return `Renaming ${targetName(params)} to ${String(params.name)}`;
    case "dm.reparent":
      return `Moving ${String(params.target)} into ${String(params.parent)}`;
    case "dm.clone":
      return `Cloning ${targetName(params)}`;
    case "dm.attributes.set":
      return `Setting attributes on ${targetName(params)}`;
    case "dm.tags.set":
      return `Changing tags on ${targetName(params)}`;
    case "dm.batch": {
      const count = ((params.operations as unknown[]) ?? []).length;
      return count === 1 ? "Making an edit" : `Making ${count} edits`;
    }

    case "script.list":
      return "Listing scripts";
    case "script.get":
      return `Reading ${targetName(params)}`;
    case "script.grep":
      return `Searching scripts for "${String(params.pattern)}"`;
    case "script.set":
      return `Rewriting ${targetName(params)}`;
    case "script.patch":
      return `Editing ${targetName(params)}`;
    case "script.create":
      return `Creating ${String(params.className)} ${String(params.name)}`;

    case "run.state":
      return "Checking the playtest state";
    case "run.start":
      return params.mode === "run" ? "Starting the place in Run mode" : "Starting a playtest";
    case "run.stop":
      return "Stopping the playtest";
    case "run.restart":
      return "Restarting the playtest";
    case "run.wait_ready":
      return "Waiting for the experience to be ready";
    case "run.multiplayer":
      switch (params.action) {
        case "start":
          return `Starting a ${String(params.players)}-player test session`;
        case "status":
          return "Checking the multiplayer test";
        case "add_players":
          return `Adding ${String(params.players)} player(s) to the test`;
        case "leave_client":
          return `Removing client ${String(params.client ?? 1)} from the test`;
        default:
          return "Ending the multiplayer test";
      }

    case "output.get":
      return "Reading Studio output";
    case "output.mark":
      return "Marking the output position";
    case "output.clear":
      return "Clearing buffered output";

    case "runtime.exec":
      return "Running Luau in Studio";

    case "input.key":
      return `Pressing ${String(params.key)}`;
    case "input.text":
      return "Typing into the game";
    case "input.mouse":
      return `Mouse ${String(params.action ?? "input")}`;
    case "input.gui_click":
      return params.text ? `Clicking "${String(params.text)}"` : `Clicking ${targetName(params)}`;

    case "view.viewport_info":
      return "Reading the viewport and camera";
    case "view.gui":
      return "Reading the on-screen interface";
    case "view.focus":
      return params.restore ? "Putting the camera back" : `Framing ${targetName(params)}`;
    case "view.highlight": {
      const count = ((params.targets as unknown[]) ?? []).length;
      return count === 0 ? "Clearing viewport marks" : count === 1 ? "Marking an instance" : `Marking ${count} instances`;
    }

    case "perf.sample":
      return "Measuring performance";
    case "perf.count":
      return "Counting what is in the place";

    case "test.run":
      return "Running the tests";

    case "view.screenshot":
      return params.source === "viewport" || params.source === undefined ? "Capturing the viewport" : "Capturing the Studio window";

    case "changes.list":
      return "Reading the change history";
    case "changes.revert":
    case "changes.apply": {
      const count = ((params.ids ?? params.records) as unknown[] | undefined)?.length ?? 0;
      return count === 1 ? "Putting a change back" : `Putting ${count} changes back`;
    }

    case "session.status":
      return "Checking the Studio connection";
    case "session.capabilities":
      return "Checking available capabilities";
    case "session.select":
      return "Switching Studio session";

    default:
      return op;
  }
}

/** Extra line shown once the result is known. */
export function detailFor(op: Op, result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const data = result as Record<string, any>;

  switch (op) {
    case "dm.get":
      return `${data.className} with ${data.childCount} child${data.childCount === 1 ? "" : "ren"}`;
    case "dm.tree":
      return `${data.nodeCount} instances${data.truncated ? " (truncated)" : ""}`;
    case "dm.search":
      return `${data.matches?.length ?? 0} match${(data.matches?.length ?? 0) === 1 ? "" : "es"}${data.truncated ? " (truncated)" : ""}`;
    case "dm.set_properties": {
      const applied = (data.applied as string[]) ?? [];
      const rejected = Object.keys((data.rejected as Record<string, string>) ?? {});
      const parts = [`set ${formatList(applied)}`];
      if (rejected.length > 0) parts.push(`rejected ${formatList(rejected)}`);
      return parts.join("; ");
    }
    case "dm.create":
      return firstPath(data.instances);
    case "dm.delete":
      return `${data.deleted} deleted`;
    case "dm.batch": {
      const parts = [`${data.applied} applied`];
      if (data.failed > 0) parts.push(`${data.failed} failed`);
      if (data.skipped > 0) parts.push(`${data.skipped} skipped`);
      return parts.join(", ");
    }
    case "script.get":
      return `${data.totalLines} lines`;
    case "script.grep": {
      const files = ((data.files as unknown[]) ?? []).length;
      if (files === 0) return `no matches in ${data.scriptsSearched} scripts`;
      return `${data.matchCount} match${data.matchCount === 1 ? "" : "es"} in ${files} script${files === 1 ? "" : "s"}${data.truncated ? " (truncated)" : ""}`;
    }
    case "script.set":
    case "script.create":
      return `${data.lineCount} lines`;
    case "script.patch":
      return typeof data.diff === "string" ? data.diff : `${data.applied} edit(s)`;
    case "run.start":
    case "run.restart":
    case "run.wait_ready":
      return data.running ? `running in the ${data.realm} DataModel${data.ready ? ", ready" : ""}` : "not running";
    case "run.stop":
      return "back in edit mode";
    case "run.multiplayer": {
      const connected = ((data.connected as unknown[]) ?? []).length;
      if (data.phase === "failed") return `failed: ${String(data.error ?? "unknown")}`;
      if (data.phase === "completed") return "finished";
      return `${data.phase}, ${connected} player${connected === 1 ? "" : "s"} connected`;
    }
    case "output.get": {
      const entries = (data.entries as unknown[]) ?? [];
      const errors = ((data.entries as Array<{ type: string }>) ?? []).filter((entry) => entry.type === "error").length;
      return `${entries.length} entries${errors > 0 ? `, ${errors} error${errors === 1 ? "" : "s"}` : ""}`;
    }
    case "runtime.exec":
      return `returned ${formatValue(data.value)}`;
    case "input.gui_click":
      return data.clicked?.path ? `clicked ${data.clicked.path}` : null;
    case "view.screenshot":
      return data.source === "viewport" ? `${data.width}x${data.height} of the ${data.realm} viewport` : `${data.width}x${data.height}`;
    case "view.gui": {
      const nodes = ((data.nodes as unknown[]) ?? []).length;
      const blocked = ((data.nodes as Array<{ visible: boolean; clickable: boolean }>) ?? []).filter(
        (node) => node.visible && !node.clickable,
      ).length;
      // The covered count is the finding, not a footnote: it is the reason to
      // have asked, and it is invisible in a screenshot.
      return `${nodes} element${nodes === 1 ? "" : "s"}${data.hitTested && blocked > 0 ? `, ${blocked} covered` : ""}`;
    }
    case "view.focus":
      return data.framed?.path ? `looking at ${data.framed.path}` : "camera restored";
    case "view.highlight": {
      const marked = ((data.marked as unknown[]) ?? []).length;
      return marked > 0 ? `${marked} marked` : `${data.cleared} cleared`;
    }
    case "perf.sample":
      return `${Math.round(data.fps)} fps, worst frame ${(data.frameTime?.worst * 1000).toFixed(1)}ms`;
    case "perf.count":
      return `${data.total} instances, ${data.parts} parts, ${data.scripts} scripts`;
    case "test.run": {
      const parts = [`${data.passed} passed`];
      if (data.failed > 0) parts.push(`${data.failed} failed`);
      if (data.timedOut) parts.push("timed out");
      return parts.join(", ");
    }
    case "changes.revert": {
      const outcomes = (data.outcomes as Array<{ status: string }>) ?? [];
      const reverted = data.reverted ?? 0;
      const refused = outcomes.filter((entry) => entry.status !== "reverted").length;
      // A revert that put half of what was asked back is not a revert that
      // worked, and the count in front of the reason is the only honest summary.
      const parts = [`${reverted} put back`];
      if (refused > 0) parts.push(`${refused} refused`);
      return parts.join(", ");
    }
    default:
      return null;
  }
}

/** Instances the operation touched, so the harness can link to them. */
export function instancesFor(result: unknown): InstanceRef[] {
  if (result === null || typeof result !== "object") return [];
  const data = result as Record<string, any>;

  if (Array.isArray(data.instances)) return data.instances as InstanceRef[];
  if (data.instance && typeof data.instance === "object") return [data.instance as InstanceRef];
  if (data.clicked && typeof data.clicked === "object") return [data.clicked as InstanceRef];
  if (data.handle && data.path) {
    return [{ handle: data.handle, path: data.path, name: data.name, className: data.className, childCount: data.childCount ?? 0 }];
  }
  return [];
}

function firstPath(instances: unknown): string | null {
  if (!Array.isArray(instances) || instances.length === 0) return null;
  const first = instances[0] as InstanceRef;
  return first?.path ?? null;
}

function formatList(values: string[]): string {
  if (values.length === 0) return "nothing";
  if (values.length <= 3) return values.join(", ");
  return `${values.slice(0, 3).join(", ")} and ${values.length - 3} more`;
}
