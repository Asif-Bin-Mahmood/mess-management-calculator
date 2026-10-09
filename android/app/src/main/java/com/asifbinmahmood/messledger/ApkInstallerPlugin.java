package com.asifbinmahmood.messledger;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Downloads a release APK, verifies it and hands it to Android's package installer.
 *
 * Verification before the installer is opened: the SHA-256 must equal the digest from the release
 * metadata, and the APK must have this app's package name, a higher version code and the same signing
 * certificate. Android's installer then performs its own signature check and always asks the user to
 * confirm; nothing is ever installed silently.
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    private static final long MAX_BYTES = 100L * 1024 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean cancelled = false;

    /** Removes a downloaded APK once it is installed or no longer valid (runs off the startup path). */
    @Override
    public void load() {
        worker.execute(() -> {
            File f = updateFile();
            if (f.exists() && checkPackage(f) != null) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        });
    }

    private File updateFile() {
        File dir = new File(getContext().getCacheDir(), "updates");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, "update.apk");
    }

    private boolean debuggable() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String sha256 = call.getString("sha256");
        // optLong accepts the number whether the bridge decoded it as Integer, Long or Double.
        long expectedSize = call.getData().optLong("size", -1);
        if (url == null || sha256 == null || !sha256.matches("[0-9a-f]{64}") || expectedSize <= 0 || expectedSize > MAX_BYTES) {
            call.reject("Invalid download request", "UNKNOWN");
            return;
        }
        // Release builds only download over HTTPS; debuggable test builds may use a local test server.
        if (!url.startsWith("https://") && !(debuggable() && url.startsWith("http://"))) {
            call.reject("Only HTTPS downloads are allowed", "NETWORK");
            return;
        }
        cancelled = false;
        worker.execute(() -> {
            File out = updateFile();
            try {
                // A complete, verified file from an earlier attempt is reused.
                if (!(out.length() == expectedSize && sha256.equals(hashFile(out)))) {
                    downloadTo(url, out, expectedSize, sha256);
                }
                String problem = checkPackage(out);
                if (problem != null) {
                    //noinspection ResultOfMethodCallIgnored
                    out.delete();
                    call.reject("The downloaded APK was rejected", problem);
                    return;
                }
                JSObject ret = new JSObject();
                ret.put("size", out.length());
                call.resolve(ret);
            } catch (CodedException e) {
                //noinspection ResultOfMethodCallIgnored
                out.delete();
                call.reject(e.getMessage(), e.code);
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                out.delete();
                call.reject("Download failed", "NETWORK");
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelled = true;
        call.resolve();
    }

    private void downloadTo(String url, File out, long expectedSize, String sha256) throws Exception {
        HttpURLConnection conn = null;
        File part = new File(out.getPath() + ".part");
        try {
            // GitHub redirects release downloads to its asset storage; HttpURLConnection follows HTTPS→HTTPS.
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("Accept", "application/octet-stream");
            int status = conn.getResponseCode();
            if (status != 200) throw new CodedException("HTTP " + status, "NETWORK");
            if (!conn.getURL().getProtocol().equals(new URL(url).getProtocol())) throw new CodedException("Unexpected redirect", "NETWORK");
            if (getContext().getCacheDir().getUsableSpace() < expectedSize * 2) throw new CodedException("Not enough space", "STORAGE");

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long done = 0;
            long lastEvent = 0;
            try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(part)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (cancelled) throw new CodedException("Cancelled", "CANCELLED");
                    done += n;
                    if (done > expectedSize) throw new CodedException("File is larger than published", "CHECKSUM");
                    digest.update(buf, 0, n);
                    os.write(buf, 0, n);
                    long now = System.currentTimeMillis();
                    if (now - lastEvent > 150) {
                        lastEvent = now;
                        JSObject p = new JSObject();
                        p.put("done", done);
                        p.put("total", expectedSize);
                        notifyListeners("downloadProgress", p);
                    }
                }
            }
            if (done != expectedSize || !sha256.equals(hex(digest.digest()))) throw new CodedException("Checksum mismatch", "CHECKSUM");
            if (!part.renameTo(out)) throw new CodedException("Could not save the file", "STORAGE");
        } catch (IOException e) {
            throw new CodedException("Download failed", "NETWORK");
        } finally {
            if (conn != null) conn.disconnect();
            //noinspection ResultOfMethodCallIgnored
            part.delete();
        }
    }

    /** Returns an error code when the APK is not a newer build of this app signed with the same key. */
    @SuppressWarnings("deprecation")
    private String checkPackage(File apk) {
        PackageManager pm = getContext().getPackageManager();
        String self = getContext().getPackageName();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = pm.getPackageArchiveInfo(apk.getPath(), flags);
        if (archive == null || !self.equals(archive.packageName)) return "PACKAGE";
        try {
            PackageInfo installed = pm.getPackageInfo(self, flags);
            long archiveCode = Build.VERSION.SDK_INT >= 28 ? archive.getLongVersionCode() : archive.versionCode;
            long installedCode = Build.VERSION.SDK_INT >= 28 ? installed.getLongVersionCode() : installed.versionCode;
            if (archiveCode <= installedCode) return "VERSION";
            if (!signers(archive).equals(signers(installed)) || signers(installed).isEmpty()) return "SIGNATURE";
        } catch (PackageManager.NameNotFoundException e) {
            return "PACKAGE";
        }
        return null;
    }

    @SuppressWarnings("deprecation")
    private static Set<String> signers(PackageInfo info) {
        Signature[] sigs;
        if (Build.VERSION.SDK_INT >= 28) {
            sigs = info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners();
        } else {
            sigs = info.signatures;
        }
        Set<String> out = new HashSet<>();
        if (sigs != null) for (Signature s : sigs) out.add(s.toCharsString());
        return out;
    }

    /** Whether the device has a network with internet access (the WebView's navigator.onLine is unreliable). */
    @PluginMethod
    public void networkStatus(PluginCall call) {
        boolean online = false;
        ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            Network n = cm.getActiveNetwork();
            NetworkCapabilities c = n == null ? null : cm.getNetworkCapabilities(n);
            online = c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        }
        JSObject ret = new JSObject();
        ret.put("online", online);
        call.resolve(ret);
    }

    /** Whether Android allows this app to open the installer ("Install unknown apps" for this app). */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("allowed", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(ret);
    }

    /** Opens the system screen where the user can allow installs from this app. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            Intent i = Build.VERSION.SDK_INT >= 26
                ? new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()))
                : new Intent(Settings.ACTION_SECURITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("Settings could not be opened", "INSTALLER");
        }
    }

    /** Opens Android's installer for the verified APK. The user confirms (or cancels) there. */
    @PluginMethod
    public void install(PluginCall call) {
        File apk = updateFile();
        if (!apk.isFile() || checkPackage(apk) != null) {
            call.reject("No verified update is ready", "PACKAGE");
            return;
        }
        Context ctx = getContext();
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No installer available", "INSTALLER");
        }
    }

    /** Opens a release page in the browser (fallback when the in-app download cannot be used). */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("Invalid address", "UNKNOWN");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No browser available", "INSTALLER");
        }
    }

    private static String hashFile(File f) {
        if (!f.isFile()) return "";
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest d = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) d.update(buf, 0, n);
            return hex(d.digest());
        } catch (Exception e) {
            return "";
        }
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private static class CodedException extends Exception {
        final String code;

        CodedException(String message, String code) {
            super(message);
            this.code = code;
        }
    }
}
