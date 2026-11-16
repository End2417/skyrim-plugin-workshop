<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Project rules

- Plugin parsing/serialization lives in `src/lib/esp/format.ts` and runs entirely in the browser; keep it UI-free so it stays testable.
- Records keep their original bytes until edited (`markDirty` before any mutation), so untouched records save byte-for-byte identical.
- Field names/layouts per record type live in `src/lib/esp/defs.ts` (hand-written from TES5Edit's wbDefinitionsTES5.pas); `decode.ts` turns them into editable rows. Unknown subrecords must still fall back to raw text/hex so nothing becomes uneditable.
- Browser download dispatch and delayed URL cleanup live in a UI-free helper; anchor clicks cannot confirm disk writes, so download feedback must not clear unsaved edits or claim completion.
- Offline support uses vite-plugin-pwa (generateSW) writing `sw.js` into the client environment's outDir; `src/lib/pwa/register.ts` is the only registrar and `src/lib/pwa/guard.ts` blocks dev, iframes, Lovable preview hosts and `?sw=off`, so previews never serve stale cached code. Pages are NetworkFirst, never precached.
- Extracting edited records into a standalone .esp lives in `src/lib/esp/extract.ts` (UI-free). The new file lists the source plugin as its last master so FormIDs stay unchanged and override the originals; localized string IDs cannot be reused and are replaced by typed text.
- Record reference scanning lives in `src/lib/esp/refs.ts` (built on `visitFormIds` in `decode.ts`) and only sees fields typed `fid` in `defs.ts`; raw/hex data such as script properties and condition parameters is not inspected. `check.ts` (missing masters / missing records), `findDependencies` and `mergeIntoPlugin` in `extract.ts` all rely on it, so keep their wording honest about that limit. Merging into an existing patch never renumbers FormIDs: `planMasters` refuses master lists that do not line up.
- The Android project is generated in CI and is not in git. Native code lives in `android-overlay/` and `scripts/patch-android.mjs` copies it in and adds the open-with intent filters after `cap add android` (idempotent). The JS side is `src/lib/native/espFiles.ts`; always check `nativeFilesAvailable()` so the web app and older APKs keep working. Saving to a chosen folder goes through the Storage Access Framework and must keep the "never overwrite" naming.

- SE → LE conversion lives in `src/lib/esp/convert.ts` (UI-free). It works on a re-parsed copy, only touches header-level identifiers by default (HEDR version, form version, ESL flag, `.esl` masters) and leaves record bytes alone; the layout scan uses `defs.ts`, which describes LE and is incomplete, so its findings are hints and trimming stays opt-in. Do not add per-record SE→LE rewrite rules without verifying them against TES5Edit's SSE definitions.
- Everything kept on the device lives in one IndexedDB database (`src/lib/esp/db.ts`, version 2): strings files and remembered master IDs. Add new stores there, never open the database elsewhere, or a version mismatch will fail.
- Reading Skyrim's Data folder on Android goes through `EspFilesPlugin.java` (`pickFolder` with `readOnly`, `listFolder`) and `src/lib/native/espFiles.ts`; `src/lib/esp/skyrimFolder.ts` decides which files matter and is tested with a fake folder. The Java is not compiled by the tests, so build the Android app after changing it.
- Script report lives in `src/lib/esp/scripts.ts` (UI-free). It reads VMAD subrecords following UESP's description of the LE/SE layout, which has not been verified against a large set of real mods: every read is bounds-checked, names must look like Papyrus identifiers, and a record that does not parse is reported rather than guessed. Libraries are recognised by script name only; say so wherever SKSE is mentioned, because a script that is not in the table may still need it. Fragment scripts of scenes, perks and terminals are not read.
- BSA reading lives in `src/lib/esp/bsa.ts` (v104 zlib, v105 LZ4 frame; checksums are not verified, the unpacked length is). It works on a whole archive in memory and exists for strings files; `masterImport.ts` opens an archive only when a localized plugin has no other strings. Test archives are built by `testBsa.ts`, which the app never imports.
- Plugin comparison lives in `src/lib/esp/compare.ts` (UI-free). Records are matched by origin (master base name or "this plugin") and local ID, not by raw FormID. FormIDs inside record data are compared as stored, so differing master lists can show spurious changes; the UI says so. `diffSubrecordLists` in `changes.ts` is shared with the change list.
- Auto-backup (`backup.ts`, `backupOriginal` in `download.ts`) writes `Name.esp.bak` once per opened file and only on Android; keep the `.bak` ending so a backup can never be loaded as a plugin.
- The test build (`.github/workflows/test-build.yml`) sets `VITE_TEST_BUILD=1`; `src/lib/variant.ts` turns that into the title and the default save folder. Keep anything that must differ between the test and normal app there.
- Undo lives in `src/lib/esp/history.ts` (UI-free). `format.ts` calls `setMutationObserver` listeners from `markDirty`, so any code that edits a record must call `markDirty(r)` first or the edit cannot be undone. Several records changed together go through `history.batch`. Creating, copying and deleting go through `records.ts` (`createRecord`, `copyRecord`, `removeRecord(s)`, `revertWithHistory`); do not call `deleteRecord` directly from the UI. Records made in a session are listed in `file.created` and stored in drafts (`draft.ts`); they have no original, so they are removed rather than reverted.
- Header editing is `header.ts`; ESL eligibility `esl.ts`; duplicates and orphans `health.ts`; load-order conflicts `loadOrder.ts` (matches records like `compare.ts`). Masters can only be renamed, or added to a plugin with no own records, on purpose: the master count is the FormID index of the plugin's own records, and only record types with layouts in `defs.ts` have their reference fields known, so renumbering cannot be done safely. Do not add reorder/remove without a full-FormID rewrite that covers unknown layouts.
- Bulk edit (`bulk.ts`) works on three kinds of field (number, choice, flags), takes several edits per run (one per field), and has CSV and preset support. Layouts added to `defs.ts` must only be ones verified against TES5Edit; `defs.more.test.ts` pins their sizes.
- The test build is signed with the fixed key in `signing/esp-editor-test.keystore` (alias `androiddebugkey`, password `android`). `test-build.yml` signs the APK explicitly after Gradle builds it (zipalign, then apksigner, like the release workflow) and fails if the result does not carry the expected SHA-256. Do not rely on Gradle's own debug signing: it uses a random key per runner, which breaks updating, and where it looks for a key depends on the runner. Never regenerate the key casually: a new key means everyone must uninstall the test app once. If you do, update `EXPECTED_SHA256` in both workflow steps. Secondary buttons use `--secondary-container` (not `--secondary`, which is a subtle tint used for row backgrounds).
- Records made in a session (`file.created`) exist only in the edited plugin. `extract.ts` writes them as new records of the extracted plugin (own slot = source masters + 2) or of a patch (fresh IDs), renumbers references to them through the field layouts (`renumberRefs`, using `visitFormIds` offsets), and pulls in any made record a chosen record points at (`newRecordsFor`). Do not extract them as overrides of the source: they would point at records the original plugin does not have. References inside VMAD script properties and unlayouted fields are not renumbered.
- The app's version comes from `src/lib/version.ts`: the `VITE_APP_VERSION` that the "Import zip and build" workflow sets from its version input, else `FALLBACK_VERSION`. Bump `FALLBACK_VERSION` with every release, because a build made without a version input uses it, and a stale value makes the app offer an update to itself. The update check is `src/lib/update.ts` (UI-free; network and storage are passed in) with `UpdateDialog.tsx` and the controls in `AboutDialog.tsx`; it runs only in the Android app, never in the test build, at most once a day, and it needs the INTERNET permission, which `scripts/patch-android.mjs` makes sure is in the manifest. The release looked up is the repository's latest non-draft, non-pre-release GitHub release, and links from it are only accepted if they point into this repository.

