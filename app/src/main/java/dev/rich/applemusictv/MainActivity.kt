package dev.rich.applemusictv

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Bundle
import android.os.Message
import android.util.Log
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * Thin native shell: one full-screen WebView serving the bundled web app from
 * https://appassets.androidplatform.net/assets/ (a secure origin, required by EME/Widevine).
 *
 * Sign-in: MusicKit's authorize() opens authorize.music.apple.com with window.open and waits
 * for a postMessage from it. WebView drops window.open unless the host supplies the window,
 * so onCreateWindow stacks a child WebView over the app; the opener link survives, and the
 * page's window.close() lands in onCloseWindow.
 *
 * Background audio: a MediaSession + foreground service (PlaybackService) keeps the process
 * — and the WebView's audio — alive after the user leaves the app. Page <-> native messages
 * go through WebMessageListeners scoped to our own origin (never Apple's pages).
 */
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private var popup: WebView? = null
    private var audioReply: JavaScriptReplyProxy? = null
    private val tap = AudioTap { line -> audioReply?.postMessage(line) }

    @SuppressLint("SetJavaScriptEnabled")
    private fun WebView.baseSettings() = settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        mediaPlaybackRequiresUserGesture = false
        userAgentString = DESKTOP_UA
        cacheMode = WebSettings.LOAD_DEFAULT
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        PlaybackService.ensureSession(this)
        // Debug builds only: lets chrome://inspect (over the adb connection) drive the page.
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        root = FrameLayout(this)
        web = WebView(this).apply {
            baseSettings()
            settings.setSupportMultipleWindows(true)
            settings.javaScriptCanOpenWindowsAutomatically = true
            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)
            }
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    val drm = request.resources.filter { it == PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID }
                    if (drm.isNotEmpty()) request.grant(drm.toTypedArray()) else request.deny()
                }
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    Log.d(TAG, "${m.message()}  (${m.sourceId().substringAfterLast('/')}:${m.lineNumber()})")
                    return true
                }
                // WebView paints a big grey play-button image over any video with no frame to show
                // (loading, or paused before the first frame). A transparent pixel instead: the
                // visualiser behind shows through.
                override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
                override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                    openPopup(resultMsg)
                    return true
                }
            }
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Page -> native: playback state for the MediaSession + notification.
            WebViewCompat.addWebMessageListener(web, "AndroidBridge", setOf(ORIGIN)) { _, message, _, _, _ ->
                try {
                    val o = JSONObject(message.data ?: "{}")
                    PlaybackService.push(this, o.optBoolean("playing"), o.optString("title"), o.optString("artist"))
                } catch (e: Exception) { Log.w(TAG, "bridge parse: ${e.message}") }
            }
            // Visualiser audio: "on" / "off" from the page; frames flow back on the same object.
            WebViewCompat.addWebMessageListener(web, "AudioBridge", setOf(ORIGIN)) { _, message, _, _, reply ->
                audioReply = reply
                when (message.data) {
                    "on" -> startTap()
                    "off" -> tap.stop()
                }
            }
        }
        PlaybackService.controlSink = { js -> runOnUiThread { web.evaluateJavascript(js, null) } }

        web.loadUrl("$ORIGIN/assets/index.html")
    }

    // ---------- sign-in window ----------
    private fun openPopup(resultMsg: Message) {
        closePopup()
        val child = WebView(this).apply {
            baseSettings()
            webViewClient = WebViewClient()            // keep Apple's sign-in pages inside this view
            webChromeClient = object : WebChromeClient() {
                override fun onCloseWindow(window: WebView) = closePopup()
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    Log.d(TAG, "[popup] ${m.message()}")
                    return true
                }
            }
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(child, true)
        root.addView(child, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        child.requestFocus()
        popup = child
        (resultMsg.obj as WebView.WebViewTransport).webView = child
        resultMsg.sendToTarget()
        Log.i(TAG, "sign-in window opened")
    }

    private fun closePopup() {
        val p = popup ?: return
        popup = null
        root.removeView(p)
        p.destroy()
        web.requestFocus()
        Log.i(TAG, "sign-in window closed")
    }

    // ---------- audio tap ----------
    private fun startTap() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO)
            return
        }
        val err = tap.start()
        audioReply?.postMessage(if (err == null) "on" else "unavailable $err")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        if (requestCode != REQ_AUDIO) return
        if (results.firstOrNull() == PackageManager.PERMISSION_GRANTED) startTap()
        else audioReply?.postMessage("denied")
    }

    // NB: deliberately no onPause/onStop override that pauses the WebView — audio must keep
    // running in the background. The foreground service keeps the process alive; onStop is the
    // resting state when the user presses Home. The audio tap is the exception: it only serves
    // the visualiser, so it stops when the app is out of sight.
    override fun onStop() {
        tap.stop()
        super.onStop()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (popup != null) {
            if (keyCode == KeyEvent.KEYCODE_BACK) {
                popup?.let { if (it.canGoBack()) it.goBack() else closePopup() }
                return true
            }
            return super.onKeyDown(keyCode, event)
        }
        when (keyCode) {
            KeyEvent.KEYCODE_BACK -> {
                web.evaluateJavascript("typeof onTvBack==='function' && onTvBack()") { consumed ->
                    if (consumed != "true") { if (web.canGoBack()) web.goBack() else finish() }
                }
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE,
            KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_MEDIA_STOP,
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_REWIND,
            KeyEvent.KEYCODE_PROG_RED, KeyEvent.KEYCODE_PROG_GREEN, KeyEvent.KEYCODE_PROG_YELLOW, KeyEvent.KEYCODE_PROG_BLUE -> {
                if (event.repeatCount == 0 || keyCode == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD || keyCode == KeyEvent.KEYCODE_MEDIA_REWIND)
                    web.evaluateJavascript("typeof onTvKey==='function' && onTvKey($keyCode, true)", null)
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD || keyCode == KeyEvent.KEYCODE_MEDIA_REWIND) {
            web.evaluateJavascript("typeof onTvKey==='function' && onTvKey($keyCode, false)", null)
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    override fun onDestroy() {
        // Real teardown only (back-out / task swipe): stop audio and release.
        tap.stop()
        closePopup()
        PlaybackService.controlSink = null
        PlaybackService.push(this, false, "", "")
        stopService(android.content.Intent(this, PlaybackService::class.java))
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "AppleMusicTV"
        private const val REQ_AUDIO = 7
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val DESKTOP_UA =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    }
}
