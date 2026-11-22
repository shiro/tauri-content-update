package com.app.app

import android.os.Bundle
import android.os.SystemClock
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen

class MainActivity : TauriActivity() {
  @Volatile private var showing = false
  @Volatile private var webSplashShown = false
  private var start = 0L

  override fun onCreate(savedInstanceState: Bundle?) {
    // Before super.onCreate: shows the splash (Theme.app.Starting) and switches to Theme.app.
    // It stays until the page has rendered the identical web splash (#splash, entry-server.tsx),
    // which continues it.
    showing = savedInstanceState == null
    start = SystemClock.uptimeMillis()
    installSplashScreen().apply {
      setKeepOnScreenCondition { !webSplashShown && elapsed() < 5000 }
      setOnExitAnimationListener {
        it.remove()
        showing = false
      }
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(NativeSplash(), "NativeSplash")
  }

  inner class NativeSplash {
    @JavascriptInterface
    fun shown() {
      webSplashShown = true
      // the condition is only checked when drawing
      window.decorView.postInvalidateOnAnimation()
    }

    @JavascriptInterface
    fun isShowing() = showing && elapsed() < 6000
  }

  private fun elapsed() = SystemClock.uptimeMillis() - start
}
