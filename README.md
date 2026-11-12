   # Skyrim ESP Editor for Android

Open, edit and extract Skyrim Legendary Edition `.esp` / `.esm` plugin files (Special Edition plugins open too and can be converted to Legendary Edition) on your phone or in your browser. Change a record, such as a sword's damage, then save just that change as its own small `.esp` mod.

**[Download the Android app](https://github.com/End2417/skyrim-plugin-workshop/releases/latest)** · **[Project website](https://end2417.github.io/skyrim-plugin-workshop/)** · **[Use in your browser](https://skyrim-plugin-workshop.lovable.app)**

## Features

- Browse every record in a plugin and search by FormID or Editor ID.
- Edit values in readable fields instead of raw bytes. Records you don't touch save byte-for-byte identical.
- **Extract** only the records you changed into a new `.esp` that overrides the originals and lists the source plugin as its master.
  - Optionally include the records your changes depend on (keywords, sounds, effects...), following references one to three levels deep, with a checklist to drop any of them.
  - Or add the records to an existing patch plugin instead of making a new file. The patch's master list has to line up with the source's, because FormIDs are never renumbered; the app tells you when it does not. The patch you pick is not changed: the result is saved as a copy.
  - From a Special Edition plugin, save the extract in Legendary Edition format.
- **To LE** converts a Special Edition plugin to Legendary Edition (see below).
- **Check plugin** finds FormIDs that point at a master the header does not list, references to records that are not there, and records with a bad own FormID, each with a Go to button. Add master files (for example `Skyrim.esm`) to verify references into them too. Only fields the editor knows are FormIDs are checked.
- **Open with** (Android): tap a `.esp`, `.esm` or `.esl` in your Files app and choose ESP Editor.
- **Save folder** (Android): pick any folder with Android's own picker. The default is `Documents/ESP Editor`. Files are never overwritten.
- Works offline. Files stay on your device.

## Special Edition to Legendary Edition

Skyrim Special Edition plugins open in the editor like any other. The Android port of Skyrim only loads Legendary Edition plugins, so **To LE** (toolbar) makes an LE copy of the open plugin. Your open file is never changed, and unsaved edits are included.

What it changes:

- Header version 1.7 becomes 0.94, and record form version 44 becomes 43.
- The light plugin (ESL) flag is cleared, and `.esl` masters are renamed to `.esp` (optional). Convert those plugins too and keep the new names.
- Creation Club masters are flagged, since Legendary Edition does not have them.
- Record contents are left byte-identical.

What it reports but does not change: fields longer than the Legendary Edition layout the editor knows. Those may be Special Edition additions, or just layouts the editor does not describe fully. An experimental option trims them; leave it off unless the game crashes on the plugin.

What a plugin conversion cannot do: meshes (`.nif`), textures (BC7), archives (`.bsa`), animations (`.hkx`), strings files and SKSE64 mods live in other files and need converting separately. After converting, run **Check plugin** with Legendary Edition's `Skyrim.esm` added, because the Special Edition one has records the Legendary Edition one lacks.

This has not been tested in the game. Test converted plugins in xEdit or in the game before relying on them.

## Install on Android

1. Download `ESP-Editor.apk` from the [latest release](https://github.com/End2417/skyrim-plugin-workshop/releases/latest).
2. Open it and allow installs from your browser or Files app if Android asks.
3. Saved plugins go to `Documents/ESP Editor` unless you choose another folder with the folder button in the app.
4. To open a plugin straight from your Files app, tap it and choose **ESP Editor**. Files apps usually label plugins as generic binary files, so the app is offered for those too; if it is not listed, use **Open** inside the app.

## AI disclaimer

This project was created with the help of AI tools, including Lovable and Claude by Anthropic. AI wrote much of the code, and it has not been fully reviewed or tested. It may contain bugs, and edited or extracted plugins may not behave as expected.

- Back up your plugins before editing them.
- Test extracted or edited files in xEdit or in the game before sharing or relying on them.
- The software is provided as is, without warranty of any kind.

This is an unofficial fan tool and is not affiliated with Bethesda Softworks.

## Updating from a zip

The **Import zip and build** workflow (Actions tab) takes a project zip, extracts it, copies the files into the repository (website pages in `docs/` included), commits them, and builds the Android app.

1. Upload the zip to the repository root or to `updates/`, committing straight to `main` (on GitHub: **Add file → Upload files**). The workflow starts as soon as the commit lands. Or start it by hand from the Actions tab and set `zip_path`. If you upload to a new branch or open a pull request instead, it starts once that is merged into `main`.
2. Optional inputs: a version (for example `1.3.0`), whether to create a GitHub release with the APK, whether to delete repo files that are not in the zip, and whether to keep the zip afterwards.
3. The APK and AAB are attached to the run as an artifact.

The workflow does not copy `.github/` from the zip, because GitHub's built-in token may not change workflow files; edit workflows in the repository itself. It needs the same signing secrets as the normal build (`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`) and a branch that allows pushes from GitHub Actions.

## Development

You need Node.js and npm.

```sh
git clone https://github.com/End2417/skyrim-plugin-workshop
cd
