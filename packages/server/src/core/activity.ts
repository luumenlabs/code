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
};

const MUTATING_PREFIXES = ["dm.set", "dm.create", "dm.delete", "dm.rename", "dm.reparent", "dm.clone", "dm.attributes", "dm.tags", "script.set", "script.patch", "script.create"];

export function categoryFor(op: Op): Category {
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

    case "script.list":
      return "Listing scripts";
    case "script.get":
      return `Reading ${targetName(params)}`;
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
    case "view.screenshot":
      return "Capturing a screenshot";

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
    case "script.get":
      return `${data.totalLines} lines`;
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
      return `${data.width}x${data.height}`;
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
