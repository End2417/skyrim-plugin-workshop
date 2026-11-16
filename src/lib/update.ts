// Update check: asks GitHub for the latest published release and says whether it is newer than this app. UI-free, with the
// network and the storage passed in, so it can be tested. Nothing is sent but the request itself (GitHub sees the phone's
// IP address, as with any web request); no information about the plugins or the person leaves the device.
import { cleanVersion } from "./version";

export const REPO_URL = "https://github.com/End2417/skyrim-plugin-workshop";
export const LATEST_RELEASE_API = "https://api.github.com/repos/End2417/skyrim-plugin-workshop/releases/latest";
export const LATEST_RELEASE_PAGE = `${REPO_URL}/releases/latest`;

export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** After a check that failed (offline, rate limit), try again no sooner than this. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;

// ---------- versions ----------

/** Compares two versions. Positive if `a` is newer, negative if older, 0 if the same, null if either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  const n = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < n; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  // 1.5.0-test is older than 1.5.0
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

function parse(v: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+(?:\.\d+){1,3})(?:-([0-9A-Za-z.-]+))?$/i.exec(v.trim());
  return m ? { nums: m[1]!.split(".").map(Number), pre: m[2] ?? "" } : null;
}

export const isNewer = (latest: string, current: string) => (compareVersions(latest, current) ?? 0) > 0;

// ---------- the release ----------

export interface ReleaseInfo {
  /** "1.5.1" */
  version: string;
  /** Release title, for example "ESP Editor 1.5.1". */
  name: string;
  /** Release text as plain text, shortened. */
  notes: string;
  /** The release's page on GitHub. */
  pageUrl: string;
  /** Direct link to the APK, if the release has one. */
  apkUrl: string | null;
  publishedAt: string | null;
}

const ownUrl = (u: unknown, prefix: string): u is string => typeof u === "string" && u.startsWith(`${REPO_URL}${prefix}`);

/**
 * Reads GitHub's answer. Returns null if it is not a usable published release: a draft, a pre-release, a version that
 * cannot be read, or links that do not point into this project.
 */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  if (j["draft"] === true || j["prerelease"] === true) return null;
  const version = cleanVersion(j["tag_name"]);
  if (!version || !ownUrl(j["html_url"], "/")) return null;
  let apkUrl: string | null = null;
  if (Array.isArray(j["assets"])) {
    for (const a of j["assets"] as unknown[]) {
      const asset = a as Record<string, unknown> | null;
      const name = asset?.["name"];
      const url = asset?.["browser_download_url"];
      if (typeof name === "string" && /\.apk$/i.test(name) && ownUrl(url, "/releases/download/")) {
        apkUrl = url;
        break;
      }
    }
  }
  return {
    version,
    name: typeof j["name"] === "string" && j["name"].trim() ? j["name"].trim() : `ESP Editor ${version}`,
    notes: plainNotes(typeof j["body"] === "string" ? j["body"] : null),
    pageUrl: j["html_url"] as string,
    apkUrl,
    publishedAt: typeof j["published_at"] === "string" ? j["published_at"] : null,
  };
}

/** Release text without the Markdown marks, cut to a length that fits a dialog. */
export function plainNotes(body: string | null, max = 1800): string {
  if (!body) return "";
  let t = body
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length > max) t = `${t.slice(0, max).replace(/\s+\S*$/, "")}…`;
  return t;
}

// ---------- settings ----------

/** What the check needs from storage; localStorage fits. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY_ENABLED = "esp-editor-update-check";
const KEY_CHECKED = "esp-editor-update-checked";
const KEY_ATTEMPT = "esp-editor-update-attempt";

const read = (s: KeyValueStore, k: string): string | null => {
  try {
    return s.getItem(k);
  } catch {
    return null;
  }
};
const write = (s: KeyValueStore, k: string, v: string): void => {
  try {
    s.setItem(k, v);
  } catch {
    /* storage unavailable: the check just runs more often */
  }
};
/** When something last happened, or null if it never did (or the value is unreadable). */
const readTime = (s: KeyValueStore, k: string): number | null => {
  const raw = read(s, k);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
};
const within = (last: number | null, now: number, ms: number) => last !== null && now - last < ms;

/** On unless the person turned it off. */
export const updateCheckEnabled = (s: KeyValueStore): boolean => read(s, KEY_ENABLED) !== "off";
export const setUpdateCheckEnabled = (s: KeyValueStore, on: boolean): void => write(s, KEY_ENABLED, on ? "on" : "off");

// ---------- the check ----------

export type CheckOutcome =
  | { status: "update"; release: ReleaseInfo }
  | { status: "current"; latest: string }
  | { status: "too-soon" }
  | { status: "disabled" }
  | { status: "failed"; reason: string };

export interface CheckOptions {
  /** This app's version. */
  current: string;
  store: KeyValueStore;
  /** Gets the parsed JSON of a URL, or throws. */
  fetchJson: (url: string) => Promise<unknown>;
  now?: () => number;
  /** A check the person asked for: ignores the daily limit and the off switch. */
  manual?: boolean;
}

/** Checks for a newer release, at most once a day unless `manual`. Never throws. */
export async function checkForUpdate(opts: CheckOptions): Promise<CheckOutcome> {
  const { current, store, fetchJson, manual = false } = opts;
  const now = (opts.now ?? Date.now)();
  if (!manual) {
    if (!updateCheckEnabled(store)) return { status: "disabled" };
    if (within(readTime(store, KEY_CHECKED), now, CHECK_EVERY_MS) || within(readTime(store, KEY_ATTEMPT), now, RETRY_AFTER_MS)) return { status: "too-soon" };
  }
  write(store, KEY_ATTEMPT, String(now));
  let release: ReleaseInfo | null;
  try {
    release = parseRelease(await fetchJson(LATEST_RELEASE_API));
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
  if (!release) return { status: "failed", reason: "GitHub's answer was not a release this app can read." };
  write(store, KEY_CHECKED, String(now));
  if (!isNewer(release.version, current)) return { status: "current", latest: release.version };
  return { status: "update", release };
}

/** GET a URL as JSON with a time limit. Throws a short, readable message on failure. */
export async function fetchJson(url: string, timeoutMs = 8000, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/vnd.github+json" }, signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? "GitHub is limiting requests right now" : `GitHub answered ${res.status}`);
    return await res.json();
  } catch (e) {
    if (ctl.signal.aborted) throw new Error("The request timed out");
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
}

/** The device's localStorage, or a store that remembers nothing if it cannot be used (some WebViews refuse access). */
export function browserStore(): KeyValueStore {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.getItem("esp-editor-update-probe");
      return localStorage;
    }
  } catch {
    /* fall through */
  }
  return { getItem: () => null, setItem: () => undefined };
}
