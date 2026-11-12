# ESP Editor 1.3.0 — release notes

Version: 1.3.0 (follows 1.2.0). Tag: `v1.3.0`.

## What's new

### Special Edition to Legendary Edition
- **To LE** button: makes a Legendary Edition copy of a Special Edition plugin. Sets header version 0.94 and form version 43, clears the ESL flag, renames `.esl` masters to `.esp`, and warns about Creation Club masters. Record contents stay byte-identical; the open file is never changed.
- Lists fields longer than the Legendary Edition layout the editor knows, with an experimental, off-by-default option to trim them.
- Shows what a plugin conversion cannot carry over: meshes, textures (BC7), BSA archives, animations, strings files and SKSE64 mods.
- Special Edition plugins are detected on open and labelled in the header.
- **Extract** can save in Legendary Edition format when the source is a Special Edition plugin.

### Plugin check (shield icon)
- Flags FormIDs pointing at a master slot the header does not list, references to records that do not exist, and records with a bad own FormID, each with a Go to button.
- References into a master can only be verified if you add that master's file in the dialog.

### Open with (Android)
- Tap a `.esp`, `.esm` or `.esl` in your Files app and choose ESP Editor, at launch or while the app is running.
- Android has no file type for `.esp`, so the app is also offered for generic binary files. A non-plugin gives the normal "doesn't look like a Skyrim plugin" error.

### Extract
- **Dependencies:** include records your changes depend on, one to three levels deep, with a checklist. They are copied unchanged, which can clash with other mods.
- **Existing patch:** add records into an existing patch plugin. Its master list has to line up with the source's, because FormIDs are never renumbered; otherwise the dialog says why and blocks the merge.

### Save folder (Android)
- Pick a folder with Android's own picker; the permission is kept across restarts. Files are never overwritten. If the folder becomes unavailable, saving falls back to `Documents/ESP Editor` with a toast.

## Things to know
- The check, dependency finder and patch merge only see fields the editor knows are FormIDs. Script properties and condition parameters are not inspected, so "no problems found" is not a guarantee.
- Merging into a patch saves a copy. If the name exists you get `Patch (1).esp` and swap it yourself.
- If a patch lacks a master the source needs, it is only appended when the patch has no records of its own, because appending would shift their FormIDs.
- The SE to LE conversion has not been tested in the game. Test converted plugins in xEdit or in the game before sharing.
- This project was built with AI help and is not fully reviewed. Back up your plugins first.

## Install
Download `ESP-Editor.apk` below. Open it and allow installs from your browser or Files app if Android asks.
