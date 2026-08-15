/**
 * JSON representation of Roblox property values.
 *
 * Primitives stay primitive so agents can read and write them naturally.
 * Everything else is tagged with `$t` and mirrors the Roblox constructor
 * arguments, so the plugin can round-trip a value without extra context.
 */
import { z } from "zod";

export interface RbxUDim {
  scale: number;
  offset: number;
}

export type RbxValue =
  | null
  | boolean
  | number
  | string
  | RbxValue[]
  | { [key: string]: RbxValue }
  | RbxTagged;

export type RbxTagged =
  | { $t: "Vector2"; x: number; y: number }
  | { $t: "Vector3"; x: number; y: number; z: number }
  | { $t: "Vector2int16"; x: number; y: number }
  | { $t: "Vector3int16"; x: number; y: number; z: number }
  | { $t: "CFrame"; position: [number, number, number]; orientation: [number, number, number]; components?: number[] }
  | { $t: "UDim"; scale: number; offset: number }
  | { $t: "UDim2"; x: RbxUDim; y: RbxUDim }
  | { $t: "Color3"; r: number; g: number; b: number; hex: string }
  | { $t: "BrickColor"; name: string; number: number }
  | { $t: "Rect"; min: [number, number]; max: [number, number] }
  | { $t: "NumberRange"; min: number; max: number }
  | { $t: "NumberSequence"; keypoints: Array<{ time: number; value: number; envelope: number }> }
  | { $t: "ColorSequence"; keypoints: Array<{ time: number; color: { r: number; g: number; b: number } }> }
  | { $t: "Font"; family: string; weight: string; style: string }
  | { $t: "Enum"; enum: string; name: string; value: number }
  | { $t: "Instance"; ref: string | null; path: string | null; className: string | null }
  | { $t: "PhysicalProperties"; density: number; friction: number; elasticity: number; frictionWeight: number; elasticityWeight: number }
  | { $t: "Axes"; x: boolean; y: boolean; z: boolean }
  | { $t: "Faces"; top: boolean; bottom: boolean; left: boolean; right: boolean; back: boolean; front: boolean }
  | { $t: "Ray"; origin: [number, number, number]; direction: [number, number, number] }
  | { $t: "Region3"; min: [number, number, number]; max: [number, number, number] }
  /** Value exists but has no lossless JSON form. Read-only; writing it fails. */
  | { $t: "Opaque"; typeName: string; text: string };

const VALUE_DESCRIPTION = [
  "A Roblox value.",
  "Primitives are plain JSON: strings, numbers, and booleans.",
  'Everything else is tagged, mirroring the Roblox constructor: {"$t":"Vector3","x":0,"y":5,"z":0},',
  '{"$t":"UDim2","x":{"scale":0.5,"offset":0},"y":{"scale":0,"offset":40}},',
  '{"$t":"Color3","hex":"#FF8800"}, {"$t":"Enum","enum":"Material","name":"Neon"},',
  '{"$t":"Instance","ref":"@h12"}, {"$t":"CFrame","position":[0,5,0],"orientation":[0,90,0]}.',
  "Reading a property returns the same shape, so a value can be read and written back unchanged.",
].join(" ");

/**
 * Deliberately unconstrained. The authoritative decoder is in the Studio
 * plugin, which knows every datatype the running build supports and reports a
 * precise INVALID_PARAMS. A recursive union here would collapse to `any` in the
 * JSON Schema MCP clients read, replacing this description with nothing.
 */
export const rbxValueSchema = z.any().describe(VALUE_DESCRIPTION) as z.ZodType<RbxValue>;

export const rbxPropertyMapSchema = z
  .record(rbxValueSchema)
  .describe(`Property name to value. ${VALUE_DESCRIPTION}`);

export function isTagged(value: RbxValue): value is RbxTagged {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { $t?: unknown }).$t === "string";
}

/** Short, human-readable rendering used by the harness activity log. */
export function formatValue(value: RbxValue): string {
  if (value === null) return "nil";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (!isTagged(value)) {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${key} = ${formatValue(entry)}`)
      .join(", ")}}`;
  }

  switch (value.$t) {
    case "Vector2":
      return `Vector2(${round(value.x)}, ${round(value.y)})`;
    case "Vector3":
      return `Vector3(${round(value.x)}, ${round(value.y)}, ${round(value.z)})`;
    case "Vector2int16":
      return `Vector2int16(${value.x}, ${value.y})`;
    case "Vector3int16":
      return `Vector3int16(${value.x}, ${value.y}, ${value.z})`;
    case "CFrame":
      return `CFrame(${value.position.map(round).join(", ")})`;
    case "UDim":
      return `UDim(${round(value.scale)}, ${value.offset})`;
    case "UDim2":
      return `UDim2(${round(value.x.scale)}, ${value.x.offset}, ${round(value.y.scale)}, ${value.y.offset})`;
    case "Color3":
      return value.hex;
    case "BrickColor":
      return `BrickColor("${value.name}")`;
    case "Rect":
      return `Rect(${value.min.map(round).join(", ")}, ${value.max.map(round).join(", ")})`;
    case "NumberRange":
      return `NumberRange(${round(value.min)}, ${round(value.max)})`;
    case "NumberSequence":
      return `NumberSequence(${value.keypoints.length} keypoints)`;
    case "ColorSequence":
      return `ColorSequence(${value.keypoints.length} keypoints)`;
    case "Font":
      return `Font(${value.family}, ${value.weight}, ${value.style})`;
    case "Enum":
      return `Enum.${value.enum}.${value.name}`;
    case "Instance":
      return value.path ?? value.ref ?? "nil";
    case "PhysicalProperties":
      return `PhysicalProperties(${round(value.density)}, ${round(value.friction)}, ${round(value.elasticity)})`;
    case "Axes":
      return `Axes(${boolAxes(value)})`;
    case "Faces":
      return `Faces(${Object.entries(value)
        .filter(([key, on]) => key !== "$t" && on === true)
        .map(([key]) => key)
        .join(", ")})`;
    case "Ray":
      return `Ray(${value.origin.map(round).join(", ")} -> ${value.direction.map(round).join(", ")})`;
    case "Region3":
      return `Region3(${value.min.map(round).join(", ")}, ${value.max.map(round).join(", ")})`;
    case "Opaque":
      return `<${value.typeName}>`;
    default:
      return JSON.stringify(value);
  }
}

function boolAxes(value: { x: boolean; y: boolean; z: boolean }): string {
  return (["x", "y", "z"] as const).filter((axis) => value[axis]).join(", ");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
