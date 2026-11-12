import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { FolderCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { chooseSaveFolder, clearSaveFolder, getSaveFolder, nativeFilesAvailable, usableSaveFolder, type SaveFolder } from "@/lib/native/espFiles";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SaveFolderDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-md">
        <SaveFolderForm />
      </DialogContent>
    </Dialog>
  );
}

/** Whether the folder picker can be offered at all (Android app built with the native plugin). */
export const saveFolderSupported = () => Capacitor.isNativePlatform();

function SaveFolderForm() {
  const [folder, setFolder] = useState<SaveFolder | null>(() => getSaveFolder());
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = nativeFilesAvailable();

  useEffect(() => {
    if (!folder || !available) return;
    let live = true;
    void usableSaveFolder().then((ok) => live && setStale(ok === null));
    return () => {
      live = false;
    };
  }, [folder, available]);

  async function choose() {
    setError(null);
    try {
      const picked = await chooseSaveFolder();
      if (picked) {
        setFolder(picked);
        setStale(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function reset() {
    clearSaveFolder();
    setFolder(null);
    setStale(false);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <FolderCog className="size-5" /> Save folder
        </DialogTitle>
        <DialogDescription>Where Save and Extract put plugin files on your phone.</DialogDescription>
      </DialogHeader>

      {!available ? (
        <p className="text-sm text-muted-foreground">
          {Capacitor.isNativePlatform()
            ? "This build of the app does not include the folder picker. Install the latest release to choose a folder."
            : "In a browser, files go to your browser's download folder. Choosing a folder is available in the Android app."}
        </p>
      ) : (
        <div className="space-y-3 text-sm">
          <p>
            <span className="text-muted-foreground">Current: </span>
            <span className="break-words font-medium">{folder ? folder.name : "Documents/ESP Editor (default)"}</span>
          </p>
          {stale && (
            <p role="alert" className="text-destructive">
              Android no longer allows saving to this folder, so files go to Documents/ESP Editor instead. Choose it again to restore access.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Android's own folder picker is used, so any folder works, including ones on an SD card or inside a mod manager's storage. A file is
            never overwritten: if the name is taken, a number is added.
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={choose}>Choose folder…</Button>
            {folder && (
              <Button variant="secondary" onClick={reset}>
                Use default
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
