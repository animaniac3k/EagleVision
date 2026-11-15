package com.spotr.tactical

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraManager
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val PERMISSION_REQUEST_CODE = 1001
        private const val SERVER_PORT = 8080
    }

    private var server: SpotrServer? = null
    private var uvcSessionManager: UsbUvcSessionManager? = null
    private var pendingWebPermissionRequest: PermissionRequest? = null
    private var permissionRequestInFlight = false
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Enable immersive fullscreen tactical mode for ChromeOS & tablets
        enableImmersiveFullscreen()

        // Request runtime camera and audio permissions if needed
        checkAndRequestPermissions()

        logAvailableNativeCameras()

        // 1. Initialize USB UVC manager & boot local embedded server
        uvcSessionManager = UsbUvcSessionManager(applicationContext) {
            runOnUiThread {
                if (this::webView.isInitialized) {
                    webView.evaluateJavascript("window.__spotrRefreshCameras?.()", null)
                }
            }
        }.also { it.register() }

        startLocalServer()

        // 2. Initialize and configure WebView
        webView = findViewById(R.id.webView)
        configureWebView()

        // 3. Navigate to local SPOTR web application
        webView.loadUrl("http://127.0.0.1:$SERVER_PORT/index.html")
    }

    private fun logAvailableNativeCameras() {
        try {
            val cm = getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return
            val ids = cm.cameraIdList
            Log.i(TAG, "Native Camera2 IDs detected (${ids.size}): ${ids.joinToString()}")
        } catch (e: Exception) {
            Log.w(TAG, "Camera2 enumeration diagnostic warning: ${e.message}")
        }
    }

    private fun startLocalServer() {
        try {
            val uvc = uvcSessionManager ?: UsbUvcSessionManager(applicationContext).also {
                it.register()
                uvcSessionManager = it
            }
            server = SpotrServer(applicationContext, SERVER_PORT, uvc)
            server?.start()
            Log.i(TAG, "SPOTR Local Server started on http://127.0.0.1:$SERVER_PORT")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start SPOTR Local Server: ${e.message}", e)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        // Hardware-accelerated Canvas 2D promotion
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)

        // Grant camera and microphone access once Android runtime permissions are granted
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                val req = request ?: return
                val missingAndroidPerms = mutableListOf<String>()
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE in req.resources &&
                    ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                ) {
                    missingAndroidPerms += Manifest.permission.CAMERA
                }
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE in req.resources &&
                    ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
                ) {
                    missingAndroidPerms += Manifest.permission.RECORD_AUDIO
                }

                if (missingAndroidPerms.isNotEmpty()) {
                    Log.i(TAG, "Deferring WebChromeClient permission grant until Android runtime permissions are resolved: ${missingAndroidPerms.joinToString()}")
                    pendingWebPermissionRequest?.deny()
                    pendingWebPermissionRequest = req
                    if (!permissionRequestInFlight) {
                        permissionRequestInFlight = true
                        ActivityCompat.requestPermissions(
                            this@MainActivity,
                            missingAndroidPerms.toTypedArray(),
                            PERMISSION_REQUEST_CODE
                        )
                    }
                } else {
                    Log.i(TAG, "Granting WebChromeClient permissions: ${req.resources.joinToString()}")
                    req.grant(req.resources)
                }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest?) {
                if (pendingWebPermissionRequest === request) {
                    pendingWebPermissionRequest = null
                }
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView?,
                errorCode: Int,
                description: String?,
                failingUrl: String?
            ) {
                Log.w(TAG, "WebView error ($errorCode): $description at $failingUrl")
            }
        }
    }

    private fun enableImmersiveFullscreen() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    private fun checkAndRequestPermissions() {
        val permissions = arrayOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO
        )
        val needed = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isNotEmpty()) {
            permissionRequestInFlight = true
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERMISSION_REQUEST_CODE)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != PERMISSION_REQUEST_CODE) return
        permissionRequestInFlight = false

        val cameraGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
        val audioGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        pendingWebPermissionRequest?.let { req ->
            val allowedResources = req.resources.filter { res ->
                when (res) {
                    PermissionRequest.RESOURCE_VIDEO_CAPTURE -> cameraGranted
                    PermissionRequest.RESOURCE_AUDIO_CAPTURE -> audioGranted
                    else -> true
                }
            }
            if (allowedResources.isNotEmpty()) {
                Log.i(TAG, "Granting deferred WebChromeClient permissions: ${allowedResources.joinToString()}")
                req.grant(allowedResources.toTypedArray())
            } else {
                Log.w(TAG, "Denying deferred WebChromeClient permissions (runtime permission denied)")
                req.deny()
            }
            pendingWebPermissionRequest = null
        }

        if (this::webView.isInitialized) {
            webView.evaluateJavascript("window.__spotrOnAndroidCameraPermission?.($cameraGranted)", null)
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        pendingWebPermissionRequest = null
        try {
            server?.stop()
            Log.i(TAG, "SPOTR Local Server stopped.")
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping server: ${e.message}")
        }
        try {
            uvcSessionManager?.destroy()
            uvcSessionManager = null
        } catch (e: Exception) {
            Log.e(TAG, "Error destroying UVC manager: ${e.message}")
        }
    }
}
