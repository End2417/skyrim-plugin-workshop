import { describe, expect, it } from "vitest";
import { shouldRegisterServiceWorker } from "./guard";

const base = {
  prod: true,
  inIframe: false,
  hostname: "skyrim-plugin-workshop.lovable.app",
  search: "",
};

describe("shouldRegisterServiceWorker", () => {
  it("registers on the published site", () => {
    expect(shouldRegisterServiceWorker(base)).toBe(true);
  });
  it("registers on a custom domain", () => {
    expect(shouldRegisterServiceWorker({ ...base, hostname: "esp.example.com" })).toBe(true);
  });
  it("never registers in development", () => {
    expect(shouldRegisterServiceWorker({ ...base, prod: false })).toBe(false);
  });
  it("never registers inside an iframe", () => {
    expect(shouldRegisterServiceWorker({ ...base, inIframe: true })).toBe(false);
  });
  it("is switched off with ?sw=off", () => {
    expect(shouldRegisterServiceWorker({ ...base, search: "?sw=off" })).toBe(false);
  });
  it.each([
    "id-preview--1d1c59ce-40fd-46ba-b82d-bfe9b1c4487e.lovable.app",
    "preview--skyrim-plugin-workshop.lovable.app",
    "preview-3--skyrim-plugin-workshop.gpt-eng.com",
    "project--1d1c59ce-40fd-46ba-b82d-bfe9b1c4487e-dev.lovable.app",
    "abc.lovableproject.com",
    "lovableproject-dev.com",
    "x.beta.lovable.dev",
  ])("never registers on preview host %s", (hostname) => {
    expect(shouldRegisterServiceWorker({ ...base, hostname })).toBe(false);
  });
  it("does not treat preview-looking labels on other domains as previews", () => {
    expect(shouldRegisterServiceWorker({ ...base, hostname: "preview-v2--shop.example.com" })).toBe(
      true,
    );
  });
});
