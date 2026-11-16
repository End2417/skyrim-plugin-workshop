import { describe, expect, it } from "vitest";
import {
  CHECK_EVERY_MS,
  checkForUpdate,
  compareVersions,
  fetchJson,
  isNewer,
  parseRelease,
  plainNotes,
  RETRY_AFTER_MS,
  setUpdateCheckEnabled,
  updateCheckEnabled,
  type CheckOptions,
  type KeyValueStore,
} from "./update";
import { APP_VERSION, cleanVersion } from "./version";

const REPO = "https://github.com/End2417/skyrim-plugin-workshop";
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `ESP Editor ${tag.replace(/^v/, "")}`,
  html_url: `${REPO}/releases/tag/${tag}`,
  body: "## What's new\n- **Undo** and `redo`\n- See [the notes](https://example.com)",
  published_at: "2026-11-15T10:00:00Z",
  assets: [
    { name: "notes.txt", browser_download_url: `${REPO}/releases/download/${tag}/notes.txt` },
    { name: "ESP-Editor.apk", browser_download_url: `${REPO}/releases/download/${tag}/ESP-Editor.apk` },
  ],
  ...extra,
});

const memory = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe("versions", () => {
  it("compares numbers, not text", () => {
    expect(compareVersions("1.5.1", "1.5.0")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.4.9", "1.5.0")).toBeLessThan(0);
    expect(compareVersions("1.5", "1.5.0")).toBe(0);
    expect(compareVersions("v1.5.0", "1.5.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("puts a pre-release before the release, and refuses what is not a version", () => {
    expect(compareVersions("1.5.0-test", "1.5.0")).toBeLessThan(0);
    expect(compareVersions("1.5.0", "1.5.0-test")).toBeGreaterThan(0);
    expect(compareVersions("1.5.0", "banana")).toBeNull();
    expect(isNewer("1.5.1", "1.5.0")).toBe(true);
    expect(isNewer("1.5.0", "1.5.0")).toBe(false);
    expect(isNewer("junk", "1.5.0")).toBe(false);
  });

  it("cleans the version a build is given", () => {
    expect(cleanVersion("v1.5.0")).toBe("1.5.0");
    expect(cleanVersion(" 1.5.0 ")).toBe("1.5.0");
    expect(cleanVersion("1.5.0-test")).toBeNull();
    expect(cleanVersion("")).toBeNull();
    expect(cleanVersion(undefined)).toBeNull();
    expect(cleanVersion("1")).toBeNull();
    expect(cleanVersion(APP_VERSION)).toBe(APP_VERSION);
  });
});

describe("parseRelease", () => {
  it("reads a release, picks the APK, and makes the notes plain", () => {
    const r = parseRelease(release("v1.5.1"))!;
    expect(r.version).toBe("1.5.1");
    expect(r.name).toBe("ESP Editor 1.5.1");
    expect(r.pageUrl).toBe(`${REPO}/releases/tag/v1.5.1`);
    expect(r.apkUrl).toBe(`${REPO}/releases/download/v1.5.1/ESP-Editor.apk`);
    expect(r.notes).toBe("What's new\n• Undo and redo\n• See the notes");
  });

  it("has no APK link when the release has none, and falls back to a title", () => {
    const r = parseRelease(release("1.5.1", { assets: [], name: "" }))!;
    expect(r.apkUrl).toBeNull();
    expect(r.name).toBe("ESP Editor 1.5.1");
  });

  it("refuses drafts, pre-releases, unreadable tags and links outside this project", () => {
    expect(parseRelease(release("v1.5.1", { draft: true }))).toBeNull();
    expect(parseRelease(release("v1.5.1", { prerelease: true }))).toBeNull();
    expect(parseRelease(release("latest"))).toBeNull();
    expect(parseRelease(release("v1.5.1", { html_url: "https://evil.example/x" }))).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease("nope")).toBeNull();
    const foreign = parseRelease(release("v1.5.1", { assets: [{ name: "x.apk", browser_download_url: "https://evil.example/x.apk" }] }))!;
    expect(foreign.apkUrl).toBeNull(); // never links to an APK from somewhere else
  });
});

describe("plainNotes", () => {
  it("shortens long text at a word and handles missing text", () => {
    const long = Array.from({ length: 400 }, () => "word").join(" ");
    const t = plainNotes(long, 100);
    expect(t.length).toBeLessThanOrEqual(101);
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toMatch(/wor…$/);
    expect(plainNotes(null)).toBe("");
    expect(plainNotes("a\n\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("checkForUpdate", () => {
  const run = (over: { store?: KeyValueStore; latest?: unknown }) => {
    const store: KeyValueStore = over.store ?? memory();
    const calls: string[] = [];
    let t = 1_000_000;
    return {
      store,
      calls,
      at: (ms: number) => (t = ms),
      check: (o: Partial<CheckOptions> = {}) =>
        checkForUpdate({
          current: "1.5.0",
          store,
          now: () => t,
          fetchJson: async (u) => {
            calls.push(u);
            if (over.latest instanceof Error) throw over.latest;
            return over.latest ?? release("v1.5.1");
          },
          ...o,
        }),
    };
  };

  it("offers a newer release, then leaves the person alone for a day", async () => {
    const c = run({});
    const first = await c.check();
    expect(first.status).toBe("update");
    expect(first.status === "update" && first.release.version).toBe("1.5.1");
    expect((await c.check()).status).toBe("too-soon");
    c.at(1_000_000 + CHECK_EVERY_MS - 1000);
    expect((await c.check()).status).toBe("too-soon");
    c.at(1_000_000 + CHECK_EVERY_MS + 1000);
    expect((await c.check()).status).toBe("update"); // still not installed: offered again
    expect(c.calls).toHaveLength(2);
  });

  it("says nothing when the app is up to date or newer than the release", async () => {
    expect((await run({ latest: release("v1.5.0") }).check()).status).toBe("current");
    expect((await run({ latest: release("v1.4.0") }).check()).status).toBe("current");
  });

  it("does nothing, and asks nothing of GitHub, when switched off", async () => {
    const store = memory();
    setUpdateCheckEnabled(store, false);
    expect(updateCheckEnabled(store)).toBe(false);
    const c = run({ store });
    expect((await c.check()).status).toBe("disabled");
    expect(c.calls).toHaveLength(0);
    setUpdateCheckEnabled(store, true);
    expect(updateCheckEnabled(store)).toBe(true);
  });

  it("fails quietly and tries again after an hour, not at every launch", async () => {
    const c = run({ latest: new Error("The request timed out") });
    const out = await c.check();
    expect(out).toEqual({ status: "failed", reason: "The request timed out" });
    expect((await c.check()).status).toBe("too-soon");
    c.at(1_000_000 + RETRY_AFTER_MS + 1000);
    expect((await c.check()).status).toBe("failed");
    expect(c.calls).toHaveLength(2);
    expect((c.store as ReturnType<typeof memory>).data.has("esp-editor-update-checked")).toBe(false); // a failure is not a check
  });

  it("treats an answer that is not a release as a failure", async () => {
    const out = await run({ latest: { message: "Not Found" } }).check();
    expect(out.status).toBe("failed");
  });

  it("a check the person asks for ignores the daily limit and the switch", async () => {
    const store = memory();
    setUpdateCheckEnabled(store, false);
    const c = run({ store });
    await c.check({ manual: true });
    const again = await c.check({ manual: true });
    expect(again.status).toBe("update");
    expect(c.calls).toHaveLength(2);
  });

  it("keeps working when storage is unavailable", async () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect((await run({ store: broken }).check()).status).toBe("update");
  });
});

describe("fetchJson", () => {
  const response = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

  it("returns the parsed answer", async () => {
    expect(await fetchJson("https://x", 1000, (async () => response(200, { a: 1 })) as typeof fetch)).toEqual({ a: 1 });
  });

  it("explains failures in a few words", async () => {
    await expect(fetchJson("https://x", 1000, (async () => response(403)) as typeof fetch)).rejects.toThrow("limiting requests");
    await expect(fetchJson("https://x", 1000, (async () => response(500)) as typeof fetch)).rejects.toThrow("GitHub answered 500");
  });

  it("gives up after the time limit", async () => {
    const never = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(fetchJson("https://x", 20, never)).rejects.toThrow("timed out");
  });
});

describe("browserStore", () => {
  it("returns a store that works, even where there is no localStorage", async () => {
    const { browserStore } = await import("./update");
    const s = browserStore();
    s.setItem("a", "b");
    expect(() => s.getItem("a")).not.toThrow();
  });
});
