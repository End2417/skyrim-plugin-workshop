import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadPlugin } from "./download";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const createObjectURL = vi.fn(() => "blob:plugin");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

describe("plugin downloads", () => {
  it("dispatches an attached download with the requested filename and retains its URL for 30 seconds", () => {
    const { revokeObjectURL } = setup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe("Android.esp");
    });
    downloadPlugin(new Uint8Array([1, 2, 3]), "Android.esp");
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector("a[download]")).toBeNull();
    vi.advanceTimersByTime(29999);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:plugin");
  });

  it("reports a rejected download to the caller and still cleans up", () => {
    const { revokeObjectURL } = setup();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { throw new Error("Download blocked"); });
    expect(() => downloadPlugin(new Uint8Array([1]), "Android.esp")).toThrow("Download blocked");
    expect(document.querySelector("a[download]")).toBeNull();
    vi.advanceTimersByTime(30000);
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("propagates failures to create a download", () => {
    const { createObjectURL } = setup();
    createObjectURL.mockImplementation(() => { throw new Error("Not enough memory"); });
    expect(() => downloadPlugin(new Uint8Array([1]), "Android.esp")).toThrow("Not enough memory");
  });
});