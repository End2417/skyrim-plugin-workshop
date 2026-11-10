import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pub = (p: string) => resolve(__dirname, "../../../public", p.replace(/^\//, ""));
const manifest = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8"));

function pngSize(path: string): [number, number] {
  const buf = readFileSync(pub(path));
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe("web app manifest installability", () => {
  it("opens on the same site it was installed from", () => {
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
  });

  it("uses an app-like display mode", () => {
    expect(["standalone", "fullscreen", "minimal-ui"]).toContain(manifest.display);
  });

  it("ships real 192px and 512px icons plus a maskable one", () => {
    for (const icon of manifest.icons) {
      const [w, h] = pngSize(icon.src);
      expect(`${w}x${h}`).toBe(icon.sizes);
    }
    const sizes = manifest.icons.filter((i: { purpose: string }) => i.purpose.includes("any")).map((i: { sizes: string }) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose.includes("maskable"))).toBe(true);
  });
});
