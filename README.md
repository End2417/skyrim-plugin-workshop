# Skyrim ESP Editor

**Skyrim Legendary Edition plugin editing for Android, with extract-only-your-changes.**

Skyrim ESP Editor opens `.esp`, `.esm`, and `.esl` files on your phone, lets you edit their records in readable fields, and saves just your changes as their own small `.esp` mod that overrides the originals. Special Edition plugins open too and can be converted to Legendary Edition. Records you do not touch are saved byte-for-byte identical.

> [!WARNING]
> This app edits plugin files. Back up your plugins before editing them, and test edited or extracted files in xEdit or in the game before sharing or relying on them. Saving never overwrites a file (a number is added to the name instead), but copying a saved file over an original by hand does. The app can also keep a `.bak` copy of the original for you.

## Current support

Skyrim ESP Editor targets Skyrim Legendary Edition plugins, including the Android port of the game, with the plugin files in storage you can reach with Android's pickers. Special Edition plugins can be opened and converted to Legendary Edition.

Current capabilities include:

- opening `.esp`, `.esm`, and `.esl` plugins from inside the app, or by tapping one in your Files app and choosing ESP Editor;
- browsing every record, with filters for FormID, EditorID, and Name, and sorting by any of them;
- editing values in readable fields instead of raw bytes, and adding or duplicating entries on repeatable fields (inventory items, factions, spells, AI packages);
- picking the record a field points at by typing words such as "steel sword", including records from the master files you have added;
- first-launch setup of Skyrim's own files, so names, search, and checks work everywhere: pick the `Data` folder once (read-only) and the app finds `Skyrim.esm`, `Update.esm`, the DLC masters, the Unofficial Skyrim Legendary Edition Patch, and loose strings files;
- strings read straight from `Skyrim - Interface.bsa` (Legendary Edition and Special Edition archives) when no extracted strings files exist, or from any `.bsa` you pick;
- undo and redo for edits, reverts, deleted and created records, bulk edits, header edits, and removal of identical records;
- creating new records and copying existing ones, with their own FormIDs and Editor IDs;
- deleting and reverting records, with a checklist of everything you changed;
- bulk edit across many records at once: several fields per run, numbers, choices, and flags, a preview of every change, CSV export and import, and saved presets;
- extracting only the records you changed into a new `.esp` that overrides the originals, with the records they depend on if you want them, into an existing patch plugin, or in Legendary Edition format;
- an editor for the file header: author, description, the ESM and ESL flags, and the spelling of a master's file name;
- Check plugin, which finds FormIDs that point at a master the header does not list, references to records that are not there, and records with a bad own FormID;
- Plugin health: whether the plugin fits the light-plugin (ESL) window, records that share an Editor ID or a FormID, groups whose parent record is missing, and new supporting records nothing else in the plugin points at;
- a Papyrus script report listing the scripts a plugin uses, the well-known libraries they come from and what those need installed, and script properties that point at records that are not there;
- Compare: the open plugin against its master or against another version of the mod, with the added, removed, and changed records and the changed fields shown before and after, and removal of the records identical to the master (ITM);
- load order conflicts across several plugins, showing which records more than one of them changes, who wins, and what the overwritten versions had;
- conversion of Special Edition plugins to Legendary Edition, including their strings files;
- an automatic backup of the original file (`Name.esp.bak`) before the first save, on Android;
- drafts that keep your unsaved edits, including records you created, on the device and offer them back when you reopen the file;
- a save folder of your choice, with `Documents/ESP Editor` as the default;
- a check for a newer release when the app opens, with a dialog that shows the release notes and offers **Download** or **Later**; and
- working offline, with files that stay on your device. Only the update check goes online, and it sends nothing about you or your plugins.

The editor describes the record types and fields it has layouts for. Anything else is shown as raw bytes.

## How extracting works

When you edit a record, the app remembers which records changed. **Extract** then:

1. writes a new `.esp` that contains only those records;
2. gives each one the same FormID as the original, so it overrides the original, and lists the source plugin as the new plugin's master;
3. optionally adds the records your changes depend on (keywords, sounds, effects), following references one to three levels deep, with a checklist to drop any of them; and
4. for a localized source such as `Skyrim.esm`, turns the text fields it needs into real text, because a new plugin has no string tables of its own.

Before you extract, the checklist button lists exactly which records changed, and lets you revert any of them. Extracting does not change the open file.

Records you create with **New record** or **Copy** do not exist in the original plugin, so Extract writes them as new records of the extracted plugin, with new FormIDs, and renumbers the fields that point at them. A chosen record that points at one brings it along automatically. When you add records to an existing patch instead, they get FormIDs the patch does not use yet.

## How Special Edition conversion works

**To LE** makes a Legendary Edition copy of the open plugin. Your open file is never changed, and unsaved edits are included. It:

1. changes header version 1.7 to 0.94 and record form version 44 to 43;
2. clears the light plugin (ESL) flag and renames `.esl` masters to `.esp` (optional; convert those plugins too and keep the new names);
3. flags Creation Club masters, since Legendary Edition does not have them;
4. leaves record contents byte-identical;
5. re-encodes the `.STRINGS`, `.DLSTRINGS`, and `.ILSTRINGS` files of a localized plugin from UTF-8 to Windows-1252, where characters Windows-1252 cannot hold become `?` and are counted; and
6. checks the converted plugin against any masters you have added.

It reports, but does not change, fields longer than the Legendary Edition layout the editor knows. An experimental option trims them; leave it off unless the game crashes on the plugin. Meshes (`.nif`), textures (BC7), archives (`.bsa`), animations (`.hkx`), and SKSE64 mods live in other files and need converting separately. After converting, run Check plugin with Legendary Edition's `Skyrim.esm` added, because the Special Edition one has records the Legendary Edition one lacks. The script report helps find out why a converted mod loads but does not work.

## Compatibility environments

The app edits plugin files, so it does not depend on how Skyrim is installed. For Skyrim's own names it reads the `Data` folder you pick, or the files you choose by hand. Android may block access to another application's protected `Android/data` directory. Pick a folder in shared storage if the picker refuses it.

## Requirements

- Android 6.0 or newer.
- Plugins in storage you can open with Android's file or folder picker.
- Optional: Skyrim's `Data` folder, for record names, search, and checks across masters.

## Get started

1. Download the latest APK from the [releases page](https://github.com/End2417/skyrim-plugin-workshop/releases).
2. Open it and allow installs from your browser or Files app if Android asks.
3. Back up the plugin you plan to edit.
4. Open the app, let it set up Skyrim's files if you want names and search, and tap **Open** to choose a plugin.
5. Change a record, then use **Extract** or **Save**. Saved files go to `Documents/ESP Editor` unless you choose another folder with the folder button.

## Updating

Every release build is signed with the same key, so a new APK installs over the old one and keeps your settings and remembered masters. When a newer release is out, the app tells you when it opens: choose **Download**, then open the downloaded file. You can turn the check off, or run it by hand, in the About screen (the info button), which also shows the version you have.

## Known limitations

- Masters cannot be reordered or removed, and a master can be added only to a plugin that has no records of its own. Doing it otherwise renumbers every FormID of the plugin's own records and every reference to them, and the editor only knows the reference fields of the record types it has layouts for.
- The editor only describes the record types and fields it has layouts for. Everything else shows as raw bytes, and the layout check in To LE and Check plugin only looks at what is described.
- A new record starts with its Editor ID and the few fields the game needs. Add the rest from the record's field list.
- New and copied records go into an extract (or a patch) as new records with new FormIDs, and references to them are renumbered in the fields the editor has a layout for. A reference to a new record inside a script property, or in a field with no layout, is not renumbered. Records with their own child groups (cells, worldspaces, dialogue topics) and placed references cannot be copied.
- The script report reads the script data of records, quest aliases, and dialogue and package fragments. Fragment scripts of scenes, perks, and terminals are not listed. Libraries are recognised by script name only. A script that is not recognised may still need SKSE, because that cannot be seen from the plugin, and the compiled scripts (`.pex`) are not inside a plugin.
- Plugin health's list of unreferenced records is a lead, not proof. Scripts and other plugins can use those records, and records of types the editor has no layout for were not read.
- Light-plugin (ESL) eligibility checks the window for new FormIDs only. The app cannot renumber them for you; xEdit's "Compact FormIDs for ESL" does that.
- Load order conflicts compare what each plugin stores. If two plugins list different masters, references inside records can look changed although they point at the same record.
- Compare and load order conflicts read each added plugin completely, so very large plugins are slow on a phone.
- Reading a `.bsa` loads the whole archive into memory first.
- Undo covers the open file and the last 200 steps. It starts fresh when you open another file or restore a draft.
- The automatic backup of the original is made on Android only.
- Layouts for record types that are not described may differ between Legendary Edition and Special Edition, and conversion of those records is not verified.
- The update check only tells you that a newer release exists. You download and install it yourself, and it needs internet access. GitHub sees the phone's IP address, as with any web request.
- Nothing here has been tested in the game. Test edited, extracted, and converted plugins in xEdit or in the game first.

## Building

The project builds with GitHub Actions. Before the first run, add three repository secrets, `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, and `KEY_ALIAS`, which hold the app's signing key. The key is never stored in the repository. Run the **Build Android** workflow from the **Actions** tab to build a signed APK from the files in the repository.

To update the app from a project zip, upload the zip to the repository root or to `updates/`, committing straight to `main`, or start the **Import zip and build** workflow by hand and set `zip_path`. The workflow copies the zip's files into the repository (website pages in `docs/` included), commits them, and builds the app. Optional inputs are a version (for example `1.5.0`), whether to create a GitHub release with the APK, whether to delete repository files that are not in the zip, and whether to keep the zip. If `release-notes/<version>.md` exists, it becomes the release text. The workflow does not copy `.github/` from the zip, so edit workflows in the repository itself.

To work on the code, run `npm install` and `npm run dev`, and `npm test` runs the tests. The editor logic lives in `src/lib/esp/` and has no screen code in it, so it can be tested on its own.

## Contributing

Bug reports, compatibility notes, and documentation corrections are welcome. When reporting a problem, include your Android version, the plugin involved and where it comes from, and the exact error message shown by the app.

## License

This project does not have a license yet. Until one is added, all rights are reserved by the author.

## Disclaimer

Skyrim ESP Editor is an independent fan project. It is not affiliated with or endorsed by Bethesda Softworks, and it contains no game files and no mods. Users remain responsible for the licenses and permissions of the games, mods, and tools they use.

This project was created with the help of AI tools, including Lovable and Claude by Anthropic. AI wrote much of the code, and it has not been fully reviewed or tested. It may contain bugs, and edited or extracted plugins may not behave as expected. The software is provided as is, without warranty of any kind.
