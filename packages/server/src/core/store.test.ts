/**
 * The Creator Store client, against a stubbed Roblox.
 *
 * Two behaviours are worth pinning. Search returns ids and the details call
 * returns them in whatever order it likes, so the fold has to put the ranking
 * back; and the details endpoint drops ids it will not describe, so what came
 * back short has to say so rather than reading as a thinner set of results.
 */
import { LuuCodeError } from "@luumen/code-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lookUpStoreAssets, searchStore } from "./store.js";

function detail(id: number, over: Record<string, unknown> = {}): unknown {
  return {
    asset: { id, name: `asset ${id}`, typeId: 10, scriptCount: 0, updatedUtc: "2024-01-01T00:00:00Z", ...over },
    creator: { id: 7, name: "someone", isVerifiedCreator: true },
    voting: { upVotes: 10, downVotes: 0, upVotePercent: 100 },
    fiatProduct: { isFree: true },
  };
}

/** Answers the search endpoint and the details endpoint by URL. */
function roblox(pages: { search?: unknown; details?: unknown; status?: number }): void {
  vi.stubGlobal("fetch", async (input: URL) => {
    const url = input.toString();
    const status = pages.status ?? 200;
    const body = url.includes("/items/details") ? pages.details : pages.search;

    return new Response(status === 200 ? JSON.stringify(body ?? {}) : "nope", {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

const search = { query: "tree", kind: "model", limit: 3 } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searching the store", () => {
  it("returns listings in the order Roblox ranked them, not the order it described them", async () => {
    roblox({
      search: { data: [{ id: 3 }, { id: 1 }, { id: 2 }], totalResults: 900, nextPageCursor: "next" },
      details: { data: [detail(1), detail(2), detail(3)] },
    });

    const result = await searchStore({ ...search });

    expect(result.assets.map((asset) => asset.id)).toEqual([3, 1, 2]);
    expect(result.cursor).toBe("next");
    expect(result.total).toBe(900);
  });

  it("names the ids it could not describe rather than returning a shorter list", async () => {
    roblox({ search: { data: [{ id: 1 }, { id: 2 }] }, details: { data: [detail(1)] } });

    const result = await searchStore({ ...search });

    expect(result.assets.map((asset) => asset.id)).toEqual([1]);
    expect(result.missing).toEqual([2]);
  });

  it("carries the fields an insert decision turns on", async () => {
    roblox({
      search: { data: [{ id: 5 }] },
      details: {
        data: [
          detail(5, {
            scriptCount: 4,
            modelTechnicalDetails: { objectMeshSummary: { triangles: 900, vertices: 1200 } },
          }),
        ],
      },
    });

    const [asset] = (await searchStore({ ...search })).assets;

    expect(asset?.scriptCount).toBe(4);
    expect(asset?.mesh).toEqual({ triangles: 900, vertices: 1200 });
    expect(asset?.free).toBe(true);
    expect(asset?.uri).toBe("rbxassetid://5");
  });

  it("reports an asset type it does not offer as unknown instead of calling it a model", async () => {
    roblox({ search: { data: [{ id: 9 }] }, details: { data: [detail(9, { typeId: 38 })] } });

    const [asset] = (await searchStore({ ...search })).assets;

    expect(asset?.kind).toBeNull();
    expect(asset?.typeId).toBe(38);
  });

  /**
   * Its own code because the recovery is its own: nothing about the place or
   * the request is wrong, and the agent's next move is to build the thing.
   */
  it("fails with STORE_UNAVAILABLE when Roblox cannot be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });

    await expect(searchStore({ ...search })).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  });

  it("fails with STORE_UNAVAILABLE when Roblox answers with an error status", async () => {
    roblox({ status: 503 });

    const error = await searchStore({ ...search }).catch((value: unknown) => LuuCodeError.from(value));

    expect(error).toMatchObject({ code: "STORE_UNAVAILABLE" });
  });
});

describe("looking assets up by id", () => {
  /** What a private, deleted, or moderated asset looks like from outside. */
  it("treats a 404 as every id being missing rather than as a failure", async () => {
    roblox({ status: 404 });

    expect(await lookUpStoreAssets([1, 2])).toEqual({ assets: [], missing: [1, 2] });
  });

  it("asks nothing of Roblox for an empty list", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    expect(await lookUpStoreAssets([])).toEqual({ assets: [], missing: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
});
