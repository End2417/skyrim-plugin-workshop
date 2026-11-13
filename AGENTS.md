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
