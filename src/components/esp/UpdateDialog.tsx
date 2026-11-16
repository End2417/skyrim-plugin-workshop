import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { browserStore, checkForUpdate, fetchJson, type ReleaseInfo } from "@/lib/update";
import { APP_VERSION } from "@/lib/version";

/** Wait a moment after the app opens before asking GitHub, so starting up is never slowed down by it. */
const START_DELAY_MS = 2000;

/**
 * Checks for a newer release once the app has opened (at most once a day, and only if the person has not turned it off).
 * `release` is set when there is one to offer. Nothing happens, and nothing is asked of GitHub, while `active` is false.
 */
export function useUpdateCheck(active: boolean) {
  const [release, setRelease] = useState<ReleaseInfo | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void checkForUpdate({ current: APP_VERSION, store: browserStore(), fetchJson }).then((outcome) => {
        if (!cancelled && outcome.status === "update") setRelease(outcome.release);
      });
    }, START_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active]);

  return {
    release,
    /** Close the dialog; it is offered again at the next daily check. */
    later: () => setRelease(null),
  };
}

interface Props {
  open: boolean;
  release: ReleaseInfo | null;
  onLater: () => void;
}

export function UpdateDialog({ open, release, onLater }: Props) {
  if (!release) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onLater()}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display tracking-wide">Update available</DialogTitle>
          <DialogDescription>
            {release.name} is out. You have version {APP_VERSION}.
          </DialogDescription>
        </DialogHeader>

        {release.notes && (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-card p-3 font-sans text-xs text-muted-foreground">{release.notes}</pre>
        )}
        <p className="text-sm text-muted-foreground">
          {release.apkUrl ? "Download the APK, then open it to update. Your settings are kept." : "The release page has the download."}{" "}
          <a href={release.pageUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-4">
            Read the full release notes
          </a>
        </p>

        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={onLater}>
            Later
          </Button>
          <Button asChild>
            <a href={release.apkUrl ?? release.pageUrl} target="_blank" rel="noopener noreferrer" onClick={onLater}>
              {release.apkUrl ? "Download" : "Open release page"}
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
