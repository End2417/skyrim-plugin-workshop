package __PACKAGE__;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Two jobs the stock Capacitor plugins cannot do:
 *  1. "Open with": hand the plugin file that Android passed in (Files app, browser downloads...) to the web app.
 *  2. "Save folder": let the person pick any folder with Android's own picker (Storage Access Framework)
 *     and write files into it, keeping the permission across restarts.
 *  3. "Skyrim folder": a folder picked read-only, listed and read file by file, so the app can set itself up from
 *     Skyrim's own Data folder.
 * Files are moved in base64 chunks so big plugins never need one huge string.
 */
@CapacitorPlugin(name = "EspFiles")
public class EspFilesPlugin extends Plugin {

    private static class Writer {
        OutputStream out;
        Uri doc;
    }

    private final Map<String, InputStream> readers = new ConcurrentHashMap<>();
    private final Map<String, Writer> writers = new ConcurrentHashMap<>();
    private volatile JSObject pending;

    // ---------- open with ----------

    @Override
    public void load() {
        pending = describeIntent(getActivity() == null ? null : getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        JSObject file = describeIntent(intent);
        if (file != null) {
            pending = null; // delivered through the event instead
            notifyListeners("fileOpened", file, true);
        }
    }

    @SuppressWarnings("deprecation")
    private JSObject describeIntent(Intent intent) {
        if (intent == null) return null;
        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri == null) return null;
        String scheme = uri.getScheme();
        if (!"content".equals(scheme) && !"file".equals(scheme)) return null;
        JSObject o = new JSObject();
        o.put("uri", uri.toString());
        o.put("name", displayName(uri));
        return o;
    }

    private String displayName(Uri uri) {
        ContentResolver cr = getContext().getContentResolver();
        try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {
            // fall through to the last path segment
        }
        String last = uri.getLastPathSegment();
        return last == null ? "plugin.esp" : last.substring(last.lastIndexOf('/') + 1);
    }

    /** The file Android launched the app with, if any. Returned once. */
    @PluginMethod
    public void getPendingFile(PluginCall call) {
        JSObject ret = new JSObject();
        JSObject file = pending;
        pending = null;
        if (file != null) ret.put("file", file);
        call.resolve(ret);
    }

    @PluginMethod
    public void openRead(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) {
            call.reject("uri is required");
            return;
        }
        try {
            InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri));
            if (in == null) {
                call.reject("Could not open the file");
                return;
            }
            String handle = UUID.randomUUID().toString();
            readers.put(handle, in);
            JSObject ret = new JSObject();
            ret.put("handle", handle);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not open the file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void readNext(PluginCall call) {
        InputStream in = readers.get(call.getString("handle", ""));
        Integer length = call.getInt("length", 3 * 1024 * 1024);
        if (in == null || length == null || length <= 0) {
            call.reject("Not an open file");
            return;
        }
        try {
            byte[] buf = new byte[length];
            int total = 0;
            while (total < length) {
                int n = in.read(buf, total, length - total);
                if (n < 0) break;
                total += n;
            }
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(buf, 0, total, Base64.NO_WRAP));
            ret.put("bytes", total);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Reading failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void closeRead(PluginCall call) {
        InputStream in = readers.remove(call.getString("handle", ""));
        if (in != null) {
            try {
                in.close();
            } catch (Exception ignored) {
                // nothing left to do
            }
        }
        call.resolve();
    }

    // ---------- save folder ----------

    /** Opens the folder picker. With readOnly, only reading is asked for (enough for the Skyrim folder). */
    @PluginMethod
    public void pickFolder(PluginCall call) {
        boolean readOnly = Boolean.TRUE.equals(call.getBoolean("readOnly", false));
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION;
        if (!readOnly) flags |= Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        intent.addFlags(flags);
        startActivityForResult(call, intent, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("No folder was chosen", "CANCELLED");
            return;
        }
        Uri tree = data.getData();
        try {
            boolean readOnly = Boolean.TRUE.equals(call.getBoolean("readOnly", false));
            int take = Intent.FLAG_GRANT_READ_URI_PERMISSION | (readOnly ? 0 : Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getContext().getContentResolver().takePersistableUriPermission(tree, take);
            JSObject ret = new JSObject();
            ret.put("uri", tree.toString());
            String name = queryName(rootDocument(tree));
            ret.put("name", name == null ? "Chosen folder" : name);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not keep access to that folder: " + e.getMessage(), e);
        }
    }

    /** Whether access to a previously chosen folder is still granted and the folder still exists. */
    @PluginMethod
    public void folderStatus(PluginCall call) {
        String uri = call.getString("uri");
        JSObject ret = new JSObject();
        ret.put("ok", false);
        if (uri != null) {
            Uri tree = Uri.parse(uri);
            boolean needWrite = !Boolean.FALSE.equals(call.getBoolean("needWrite", true));
            boolean granted = false;
            for (android.content.UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
                if (p.getUri().equals(tree) && p.isReadPermission() && (!needWrite || p.isWritePermission())) granted = true;
            }
            String name = null;
            try {
                name = queryName(rootDocument(tree));
            } catch (Exception ignored) {
                // folder deleted or provider gone
            }
            if (granted && name != null) {
                ret.put("ok", true);
                ret.put("name", name);
            }
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void beginWrite(PluginCall call) {
        String treeUri = call.getString("treeUri");
        String name = call.getString("name");
        if (treeUri == null || name == null) {
            call.reject("treeUri and name are required");
            return;
        }
        try {
            ContentResolver cr = getContext().getContentResolver();
            Uri tree = Uri.parse(treeUri);
            Uri parent = rootDocument(tree);
            String unique = uniqueName(tree, name);
            Uri doc = DocumentsContract.createDocument(cr, parent, "application/octet-stream", unique);
            if (doc == null) {
                call.reject("The folder refused to create the file");
                return;
            }
            Writer w = new Writer();
            w.doc = doc;
            w.out = cr.openOutputStream(doc, "w");
            if (w.out == null) {
                DocumentsContract.deleteDocument(cr, doc);
                call.reject("Could not open the new file for writing");
                return;
            }
            String handle = UUID.randomUUID().toString();
            writers.put(handle, w);
            JSObject ret = new JSObject();
            ret.put("handle", handle);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not create the file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void writeChunk(PluginCall call) {
        Writer w = writers.get(call.getString("handle", ""));
        String data = call.getString("data");
        if (w == null || data == null) {
            call.reject("Not an open file");
            return;
        }
        try {
            w.out.write(Base64.decode(data, Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            call.reject("Writing failed: " + e.getMessage(), e);
        }
    }

    /** Finishes a file. With abort=true the partly written file is removed instead. */
    @PluginMethod
    public void endWrite(PluginCall call) {
        Writer w = writers.remove(call.getString("handle", ""));
        if (w == null) {
            call.reject("Not an open file");
            return;
        }
        boolean abort = Boolean.TRUE.equals(call.getBoolean("abort", false));
        try {
            w.out.flush();
            w.out.close();
        } catch (Exception e) {
            if (!abort) {
                call.reject("Could not finish the file: " + e.getMessage(), e);
                abort = true;
            }
        }
        ContentResolver cr = getContext().getContentResolver();
        if (abort) {
            try {
                DocumentsContract.deleteDocument(cr, w.doc);
            } catch (Exception ignored) {
                // leave it
            }
            if (!call.isReleased()) call.resolve();
            return;
        }
        JSObject ret = new JSObject();
        String saved = queryName(w.doc);
        ret.put("name", saved == null ? "file" : saved);
        ret.put("uri", w.doc.toString());
        call.resolve(ret);
    }

    // ---------- Skyrim folder ----------

    /**
     * Lists a folder inside a chosen tree. "path" is a list of folder names to walk down from the tree's root
     * (matched ignoring case), so the web app can ask for "Data" and then "Strings". The returned uris can be
     * read with openRead.
     */
    @PluginMethod
    public void listFolder(PluginCall call) {
        String treeUri = call.getString("treeUri");
        if (treeUri == null) {
            call.reject("treeUri is required");
            return;
        }
        try {
            Uri tree = Uri.parse(treeUri);
            String docId = DocumentsContract.getTreeDocumentId(tree);
            JSArray path = call.getArray("path");
            if (path != null) {
                for (int i = 0; i < path.length(); i++) {
                    docId = findChildId(tree, docId, path.getString(i));
                    if (docId == null) {
                        JSObject none = new JSObject();
                        none.put("found", false);
                        none.put("entries", new JSArray());
                        call.resolve(none);
                        return;
                    }
                }
            }
            JSArray entries = new JSArray();
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
            String[] cols = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
            };
            try (Cursor c = getContext().getContentResolver().query(children, cols, null, null, null)) {
                while (c != null && c.moveToNext()) {
                    JSObject e = new JSObject();
                    e.put("name", c.getString(1));
                    e.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0)).toString());
                    e.put("dir", DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2)));
                    e.put("size", c.isNull(3) ? 0 : c.getLong(3));
                    entries.put(e);
                }
            }
            JSObject ret = new JSObject();
            ret.put("found", true);
            ret.put("entries", entries);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not list the folder: " + e.getMessage(), e);
        }
    }

    // ---------- helpers ----------

    private String findChildId(Uri tree, String parentId, String name) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME };
        try (Cursor c = getContext().getContentResolver().query(children, cols, null, null, null)) {
            while (c != null && c.moveToNext()) {
                if (name.equalsIgnoreCase(c.getString(1))) return c.getString(0);
            }
        } catch (Exception ignored) {
            // an unreadable listing: treat the folder as missing
        }
        return null;
    }

    private Uri rootDocument(Uri tree) {
        return DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
    }

    private String queryName(Uri doc) {
        try (Cursor c = getContext().getContentResolver().query(doc, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
            // not readable
        }
        return null;
    }

    /** "Mod.esp" -> "Mod (1).esp", ... so an existing file is never overwritten. */
    private String uniqueName(Uri tree, String wanted) {
        Set<String> taken = new HashSet<>();
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        try (Cursor c = getContext().getContentResolver().query(children, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            while (c != null && c.moveToNext()) taken.add(c.getString(0).toLowerCase(Locale.ROOT));
        } catch (Exception ignored) {
            // an unreadable listing means we cannot rule names out; the provider renames on clashes anyway
        }
        int dot = wanted.lastIndexOf('.');
        String stem = dot > 0 ? wanted.substring(0, dot) : wanted;
        String ext = dot > 0 ? wanted.substring(dot) : "";
        for (int n = 0; n < 1000; n++) {
            String candidate = n == 0 ? wanted : stem + " (" + n + ")" + ext;
            if (!taken.contains(candidate.toLowerCase(Locale.ROOT))) return candidate;
        }
        return wanted;
    }
}
