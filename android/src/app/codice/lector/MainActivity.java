package app.codice.lector;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

public class MainActivity extends Activity {
    static final String HOST = "codice.app";
    static final String HOME = "https://" + HOST + "/index.html";
    WebView web;
    ValueCallback<Uri[]> fileCb;
    volatile Uri pendingUri;
    volatile String pendingName = "";

    static String mime(String p) {
        p = p.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        web = new WebView(this);
        web.setBackgroundColor(0xFFEAC79A);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "Native");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                String path = u.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                path = path.substring(1);
                Map<String, String> h = new HashMap<String, String>();
                h.put("Access-Control-Allow-Origin", "*");
                h.put("Cache-Control", "no-cache");
                try {
                    if (path.equals("__incoming")) {
                        Uri p = pendingUri;
                        if (p == null) throw new Exception("none");
                        String t = getContentResolver().getType(p);
                        return new WebResourceResponse(t == null ? "application/octet-stream" : t, null, 200, "OK", h, getContentResolver().openInputStream(p));
                    }
                    if (path.contains("..")) throw new Exception("bad path");
                    InputStream in = getAssets().open(path);
                    String m = mime(path);
                    boolean text = m.startsWith("text/") || m.contains("json") || m.contains("svg");
                    return new WebResourceResponse(m, text ? "utf-8" : null, 200, "OK", h, in);
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", h, new java.io.ByteArrayInputStream(new byte[0]));
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                // blob:, about:, data: son los marcos internos donde se pinta cada página: nunca se desvían
                if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return false;
                Uri u = Uri.parse(url);
                if (HOST.equals(u.getHost())) return false;
                open(url);
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(i, 7);
                } catch (Exception e) {
                    fileCb = null;
                    cb.onReceiveValue(null);
                }
                return true;
            }
        });

        takeIntent(getIntent());
        web.loadUrl(HOME);
    }

    void open(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) { /* sin navegador */ }
    }

    boolean takeIntent(Intent i) {
        if (i == null || !Intent.ACTION_VIEW.equals(i.getAction()) || i.getData() == null) return false;
        Uri u = i.getData();
        String name = null;
        try {
            Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null) {
                if (c.moveToFirst()) name = c.getString(0);
                c.close();
            }
        } catch (Exception e) { /* sin nombre */ }
        if (name == null) name = u.getLastPathSegment();
        if (name == null) name = "libro";
        pendingUri = u;
        pendingName = name;
        return true;
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        if (takeIntent(i)) web.evaluateJavascript("window.__incoming&&window.__incoming()", null);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != 7 || fileCb == null) return;
        Uri[] out = null;
        if (res == RESULT_OK && data != null) {
            ClipData cd = data.getClipData();
            if (cd != null && cd.getItemCount() > 0) {
                out = new Uri[cd.getItemCount()];
                for (int k = 0; k < out.length; k++) out[k] = cd.getItemAt(k).getUri();
            } else if (data.getData() != null) out = new Uri[]{data.getData()};
        }
        fileCb.onReceiveValue(out);
        fileCb = null;
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.__back?window.__back():false)", new ValueCallback<String>() {
            public void onReceiveValue(String v) {
                if (!"true".equals(v)) moveTaskToBack(true);
            }
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
    }

    class Bridge {
        @JavascriptInterface
        public void http(final int id, final String json) {
            new Thread(new Runnable() {
                public void run() {
                    int status = 0;
                    String text;
                    HttpURLConnection c = null;
                    try {
                        JSONObject o = new JSONObject(json);
                        c = (HttpURLConnection) new URL(o.getString("url")).openConnection();
                        int to = o.optInt("timeout", 60000);
                        c.setConnectTimeout(20000);
                        c.setReadTimeout(to);
                        c.setRequestMethod(o.optString("method", "GET"));
                        c.setRequestProperty("User-Agent", "Codice/1.0 (Android)");
                        JSONObject h = o.optJSONObject("headers");
                        if (h != null) for (Iterator<String> it = h.keys(); it.hasNext(); ) {
                            String k = it.next();
                            c.setRequestProperty(k, h.getString(k));
                        }
                        if (!o.isNull("body")) {
                            c.setDoOutput(true);
                            OutputStream os = c.getOutputStream();
                            os.write(o.getString("body").getBytes("UTF-8"));
                            os.close();
                        }
                        status = c.getResponseCode();
                        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                        ByteArrayOutputStream bo = new ByteArrayOutputStream();
                        if (in != null) {
                            byte[] buf = new byte[8192];
                            int n;
                            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                            in.close();
                        }
                        text = bo.toString("UTF-8");
                    } catch (Exception e) {
                        status = 0;
                        text = String.valueOf(e);
                    } finally {
                        if (c != null) c.disconnect();
                    }
                    final String js = "window.__nativeHttp(" + id + "," + status + "," + JSONObject.quote(text) + ")";
                    web.post(new Runnable() {
                        public void run() {
                            web.evaluateJavascript(js, null);
                        }
                    });
                }
            }).start();
        }

        @JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(new Runnable() {
                public void run() {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void theme(final boolean night) {
            runOnUiThread(new Runnable() {
                public void run() {
                    getWindow().setStatusBarColor(night ? 0xFF1B130C : 0xFFEAC79A);
                    getWindow().setNavigationBarColor(night ? 0xFF1B130C : 0xFFE2BA86);
                    // 0x2000 = barra de estado con iconos oscuros, 0x10 = barra de navegación con iconos oscuros
                    getWindow().getDecorView().setSystemUiVisibility(night ? 0 : (0x2000 | 0x10));
                    web.setBackgroundColor(night ? 0xFF1B130C : 0xFFEAC79A);
                }
            });
        }

        @JavascriptInterface
        public String pendingOpen() {
            String n = pendingName;
            pendingName = "";
            return n;
        }

        @JavascriptInterface
        public void openUrl(String url) {
            open(url);
        }
    }
}
