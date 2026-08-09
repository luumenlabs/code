/**
 * JSON null handling across the Studio boundary.
 *
 * Roblox's JSON decoder drops keys whose value is null, because Lua tables
 * cannot hold a nil value. A request like `{"attributes": {"Owner": null}}`
 * would therefore arrive in Studio as an empty table, and "remove this
 * attribute" would silently do nothing.
 *
 * Outbound nulls become the `{"$t":"Nil"}` tag the plugin understands, and
 * inbound Nil tags become plain null again so agents only ever see JSON.
 */
export function nullsToNilTags(value: unknown): unknown {
  if (value === null) return { $t: "Nil" };

  if (Array.isArray(value)) return value.map(nullsToNilTags);

  if (typeof value === "object" && value !== undefined) {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (entry === undefined) continue;
      result[key] = nullsToNilTags(entry);
    }
    return result;
  }

  return value;
}

export function nilTagsToNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nilTagsToNulls);

  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    if (source.$t === "Nil") return null;

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      result[key] = nilTagsToNulls(entry);
    }
    return result;
  }

  return value;
}
