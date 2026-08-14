/**
 * The Creator Store, over Roblox's own toolbox endpoints.
 *
 * Search answers with asset ids and nothing else, so every listing is a second
 * request for the details Studio's toolbox shows beside them. The two are kept
 * together here because a list of bare numbers is unusable: it cannot tell a
 * free two-hundred-triangle bush from a paid car with fourteen scripts in it,
 * and both of those decide whether the asset can be inserted at all.
 *
 * Unauthenticated. Nothing here reaches the user's account, so the store looks
 * the same as it does to a logged-out browser.
 */
import { ASSET_KINDS, LuuCodeError } from "@luumen/code-protocol";
import type { AssetKind, CommandResult, StoreAsset } from "@luumen/code-protocol";

const TOOLBOX = "https://apis.roblox.com/toolbox-service/v1";
const TIMEOUT_MS = 15_000;
/** Store descriptions run to essays. This is enough to tell two results apart. */
const MAX_DESCRIPTION = 280;

const KIND_BY_TYPE = new Map<number, AssetKind>(
  (Object.entries(ASSET_KINDS) as Array<[AssetKind, number]>).map(([kind, typeId]) => [typeId, kind]),
);

export interface StoreSearchRequest {
  query: string;
  kind: AssetKind;
  limit: number;
  cursor?: string | undefined;
  creatorId?: number | undefined;
  refine?: string | undefined;
}

export async function searchStore(request: StoreSearchRequest): Promise<CommandResult<"assets.search">> {
  const url = new URL(`${TOOLBOX}/marketplace/${ASSET_KINDS[request.kind]}`);
  url.searchParams.set("keyword", request.query);
  url.searchParams.set("limit", String(request.limit));
  if (request.cursor) url.searchParams.set("cursor", request.cursor);
  if (request.creatorId !== undefined) url.searchParams.set("creatorTargetId", String(request.creatorId));
  if (request.refine) url.searchParams.set("facets", request.refine);

  const page = await get<SearchPage>(url, "search the Creator Store");
  const ids = (page.data ?? []).map((entry) => entry.id).filter((id): id is number => typeof id === "number");
  const { assets, missing } = await describe(ids);

  return {
    assets,
    cursor: page.nextPageCursor ?? null,
    total: page.totalResults ?? assets.length,
    refinements: page.queryFacets?.availableFacets ?? [],
    refined: page.queryFacets?.appliedFacets ?? [],
    missing,
  };
}

export async function lookUpStoreAssets(ids: number[]): Promise<CommandResult<"assets.info">> {
  return describe(ids);
}

/**
 * Details for a set of ids, in the order asked for.
 *
 * The endpoint drops ids it cannot describe and answers 404 only when it can
 * describe none of them, so both shapes mean the same thing here: whatever did
 * not come back is named rather than left as a shorter list.
 */
async function describe(ids: number[]): Promise<{ assets: StoreAsset[]; missing: number[] }> {
  if (ids.length === 0) return { assets: [], missing: [] };

  const url = new URL(`${TOOLBOX}/items/details`);
  url.searchParams.set("assetIds", ids.join(","));

  const page = await get<DetailsPage>(url, "read Creator Store listings", { emptyOn404: true });
  const described = new Map<number, StoreAsset>();

  for (const entry of page.data ?? []) {
    const asset = toStoreAsset(entry);
    if (asset) described.set(asset.id, asset);
  }

  return {
    assets: ids.flatMap((id) => {
      const asset = described.get(id);
      return asset ? [asset] : [];
    }),
    missing: ids.filter((id) => !described.has(id)),
  };
}

function toStoreAsset(entry: DetailEntry): StoreAsset | null {
  const asset = entry.asset;
  if (!asset || typeof asset.id !== "number") return null;

  const typeId = asset.typeId ?? 0;
  const kind = KIND_BY_TYPE.get(typeId) ?? null;
  const mesh = asset.modelTechnicalDetails?.objectMeshSummary;
  const price = entry.fiatProduct?.purchasePrice;
  const free = entry.fiatProduct?.isFree !== false;

  return {
    id: asset.id,
    name: asset.name ?? "",
    description: cut(asset.description ?? ""),
    kind,
    typeId,
    uri: `rbxassetid://${asset.id}`,
    url: `https://create.roblox.com/store/asset/${asset.id}`,
    creator: {
      id: entry.creator?.id ?? 0,
      name: entry.creator?.name ?? "",
      verified: entry.creator?.isVerifiedCreator === true,
    },
    free,
    price: free || !price ? null : { currency: price.currencyCode ?? "USD", amount: decimal(price.quantity) },
    endorsed: asset.isEndorsed === true,
    scriptCount: asset.scriptCount ?? 0,
    mesh: mesh ? { triangles: mesh.triangles ?? 0, vertices: mesh.vertices ?? 0 } : null,
    // Keyed off the kind rather than off the number being non-zero: Roblox
    // rounds to whole seconds, so a footstep is a 0 that means "under a second"
    // rather than a 0 that means "this is not audio".
    duration: kind === "audio" ? (asset.duration ?? 0) : null,
    votes: {
      up: entry.voting?.upVotes ?? 0,
      down: entry.voting?.downVotes ?? 0,
      percent: entry.voting?.upVotePercent ?? 0,
    },
    updatedAt: asset.updatedUtc ?? asset.createdUtc ?? "",
  };
}

/** Roblox quotes money as a significand and a power of ten. */
function decimal(quantity: { significand?: number; exponent?: number } | undefined): number {
  if (!quantity) return 0;
  return (quantity.significand ?? 0) * 10 ** (quantity.exponent ?? 0);
}

function cut(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DESCRIPTION ? `${trimmed.slice(0, MAX_DESCRIPTION)}…` : trimmed;
}

/**
 * One store request, with every way it can fail carrying the same code.
 *
 * The agent's recovery is the same for a timeout, a 500, and a body that is not
 * the JSON it should be: none of them are about the place or the request, and
 * the next move is to build the thing rather than to fix a parameter.
 */
async function get<T>(url: URL, what: string, options: { emptyOn404?: boolean } = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new LuuCodeError("STORE_UNAVAILABLE", `Could not ${what}: ${describeFetchFailure(error)}.`, {
      hint: "Roblox's store endpoints are not reachable from this machine right now. Build what you need instead of importing it, or try again later.",
      cause: error,
    });
  }

  if (response.status === 404 && options.emptyOn404) return {} as T;

  if (!response.ok) {
    throw new LuuCodeError("STORE_UNAVAILABLE", `Could not ${what}: Roblox answered ${response.status}.`, {
      details: { status: response.status, url: url.toString() },
    });
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new LuuCodeError("STORE_UNAVAILABLE", `Could not ${what}: Roblox did not answer with JSON.`, { cause: error });
  }
}

function describeFetchFailure(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return `no answer in ${TIMEOUT_MS / 1000}s`;
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The shapes Roblox sends back, as far as anything here reads them.
// ---------------------------------------------------------------------------

interface SearchPage {
  data?: Array<{ id?: number }>;
  totalResults?: number;
  nextPageCursor?: string | null;
  queryFacets?: { appliedFacets?: string[]; availableFacets?: string[] };
}

interface DetailsPage {
  data?: DetailEntry[];
}

interface DetailEntry {
  asset?: {
    id?: number;
    name?: string;
    description?: string;
    typeId?: number;
    duration?: number;
    scriptCount?: number;
    isEndorsed?: boolean;
    createdUtc?: string;
    updatedUtc?: string;
    modelTechnicalDetails?: { objectMeshSummary?: { triangles?: number; vertices?: number } };
  };
  creator?: { id?: number; name?: string; isVerifiedCreator?: boolean };
  voting?: { upVotes?: number; downVotes?: number; upVotePercent?: number };
  fiatProduct?: {
    isFree?: boolean;
    purchasePrice?: { currencyCode?: string; quantity?: { significand?: number; exponent?: number } };
  };
}
