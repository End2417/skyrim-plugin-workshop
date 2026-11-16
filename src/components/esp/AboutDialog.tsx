import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Capacitor } from "@capacitor/core";
import { Checkbox } from "@/components/ui/checkbox";
import { browserStore, checkForUpdate, fetchJson, setUpdateCheckEnabled, updateCheckEnabled, type CheckOutcome } from "@/lib/update";
import { IS_TEST_BUILD, APP_TITLE } from "@/lib/variant";
import { APP_VERSION } from "@/lib/version";

/** Set to true to show the credits every time the app opens instead of only the first time. */
const SHOW_EVERY_LAUNCH = false;
const SEEN_KEY = "esp-editor-about-seen-v1";

/** Opens itself on first launch; call setOpen(true) later (the info button) to show it again. */
export function useFirstLaunchAbout(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      if (SHOW_EVERY_LAUNCH || !localStorage.getItem(SEEN_KEY)) setOpen(true);
    } catch {
      setOpen(true); // storage unavailable: show it rather than hide it
    }
  }, []);
  const set = (value: boolean) => {
    setOpen(value);
    if (!value) {
      try {
        localStorage.setItem(SEEN_KEY, "1");
      } catch {
        /* nothing to do: it will simply show again next time */
      }
    }
  };
  return [open, set];
}

const REPO_URL = "https://github.com/End2417/skyrim-plugin-workshop";

const CREDITS: [string, string][] = [
  ["Created by", "End2417, who came up with the idea, directed the work and tested it on a phone."],
  ["Open-source software", "Capacitor, React, TanStack, Tailwind CSS, Radix UI, shadcn/ui, Lucide icons and fflate."],
];

/** The version, and (in the Android app) the update check's switch and a button to check right now. */
function VersionInfo() {
  const canCheck = Capacitor.isNativePlatform() && !IS_TEST_BUILD;
  const [enabled, setEnabled] = useState(() => updateCheckEnabled(browserStore()));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckOutcome | null>(null);

  async function checkNow() {
    setBusy(true);
    setResult(null);
    setResult(await checkForUpdate({ current: APP_VERSION, store: browserStore(), fetchJson, manual: true }));
    setBusy(false);
  }

  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">Version {APP_VERSION}</p>
      {canCheck && (
        <>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={enabled}
              onCheckedChange={(v) => {
                setEnabled(v === true);
                setUpdateCheckEnabled(browserStore(), v === true);
              }}
            />
            <span>Check for updates when the app opens</span>
          </label>
          <p className="text-xs text-muted-foreground">Asks GitHub for the newest release, at most once a day. It sends nothing about you or your plugins.</p>
          <Button variant="secondary" size="sm" onClick={() => void checkNow()} disabled={busy}>
            {busy ? "Checking…" : "Check now"}
          </Button>
          {result?.status === "current" && <p role="status">You have the latest version.</p>}
          {result?.status === "failed" && (
            <p role="status" className="text-destructive">
              Could not check: {result.reason}.
            </p>
          )}
          {result?.status === "update" && (
            <p role="status">
              Version {result.release.version} is available.{" "}
              <a href={result.release.apkUrl ?? result.release.pageUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-4">
                {result.release.apkUrl ? "Download" : "Open release page"}
              </a>
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function AboutDialog({ open, onOpenChange, onSetup }: { open: boolean; onOpenChange: (open: boolean) => void; onSetup?: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display tracking-wide">{APP_TITLE}</DialogTitle>
          <DialogDescription>Edit Skyrim plugins on your phone, then extract just your changes as a small mod.</DialogDescription>
        </DialogHeader>

        <dl className="space-y-3 text-sm">
          {CREDITS.map(([term, text]) => (
            <div key={term}>
              <dt className="font-medium text-primary">{term}</dt>
              <dd className="text-muted-foreground">{text}</dd>
            </div>
          ))}
        </dl>

        <p className="text-sm">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-4">
            View the project on GitHub
          </a>
          <span className="block break-all text-xs text-muted-foreground">{REPO_URL}</span>
        </p>

        <VersionInfo />

        <p className="text-sm text-muted-foreground">
          Back up your plugins before editing them, and test extracted files in xEdit or in the game before sharing them.
        </p>
        <p className="text-xs text-muted-foreground">
          The Elder Scrolls V: Skyrim is by Bethesda Game Studios. This is an unofficial fan tool and is not affiliated with Bethesda Softworks.
        </p>

        <DialogFooter>
          {onSetup && (
            <Button variant="secondary" onClick={onSetup}>
              Set up Skyrim files
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
