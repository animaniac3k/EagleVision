package com.spotr.tactical

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
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

    private var wifiLock: WifiManager.WifiLock? = null
    private var connectivityManager: ConnectivityManager? = null
    private var wifiNetworkCallback: ConnectivityManager.NetworkCallback? = null
    private var boundCameraWifiNetwork: Network? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)

        // Enable immersive fullscreen tactical mode for ChromeOS & tablets
        enableImmersiveFullscreen()

        // Request runtime camera and audio permissions if needed
        checkAndRequestPermissions()

        logAvailableNativeCameras()

        // Bind to no-internet camera Wi-Fi APs (e.g. 192.168.0.1) even when LTE/5G is enabled
        registerCameraWifiBinder()
        initWifiLock()

        // 1. Initialize USB UVC manager & boot local embedded server
        uvcSessionManager = UsbUvcSessionManager(applicationContext) {
            runOnUiThread {
                if (this::webView.isInitialized && !isDestroyed && !isFinishing) {
                    webView.evaluateJavascript("window.__spotrRefreshCameras?.()", null)
                }
            }
        }.also { it.register() }

        startLocalServer()

        // 2. Initialize and configure WebView
        webView = findViewById(R.id.webView)
        configureWebView()

        // Modern back gesture / button handling
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (this@MainActivity::webView.isInitialized && webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        // 3. Navigate to local SPOTR web application
        webView.loadUrl("http://127.0.0.1:$SERVER_PORT/index.html")
    }

    override fun onResume() {
        super.onResume()
        enableImmersiveFullscreen()
        acquireWifiLock()
        server?.setAppBackgrounded(false)
        if (this::webView.isInitialized) {
            webView.onResume()
        }
    }

    override fun onPause() {
        super.onPause()
        server?.setAppBackgrounded(true)
        releaseWifiLock()
        if (this::webView.isInitialized) {
            webView.onPause()
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            enableImmersiveFullscreen()
        }
    }

    private fun initWifiLock() {
        try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                @Suppress("DEPRECATION")
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = wm.createWifiLock(mode, "SPOTR:CameraStreamWifiLock").apply {
                setReferenceCounted(false)
            }
        } catch (e: Exception) {
            Log.w(TAG, "WifiLock init notice: ${e.message}")
        }
    }

    private fun acquireWifiLock() {
        try {
            if (wifiLock?.isHeld == false) {
                wifiLock?.acquire()
            }
        } catch (e: Exception) {
            Log.w(TAG, "WifiLock acquire notice: ${e.message}")
        }
    }

    private fun releaseWifiLock() {
        try {
            if (wifiLock?.isHeld == true) {
                wifiLock?.release()
            }
        } catch (e: Exception) {
            Log.w(TAG, "WifiLock release notice: ${e.message}")
        }
    }

    private fun registerCameraWifiBinder() {
        try {
            val cm = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                ?: return
            connectivityManager = cm
            val request = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()

            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    val hasValidatedInternet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                    if (!hasValidatedInternet) {
                        if (boundCameraWifiNetwork != network) {
                            boundCameraWifiNetwork = network
                            cm.bindProcessToNetwork(network)
                            Log.i(TAG, "Bound process to local camera Wi-Fi network (no internet)")
                        }
                    } else if (boundCameraWifiNetwork == network) {
                        boundCameraWifiNetwork = null
                        cm.bindProcessToNetwork(null)
                        Log.i(TAG, "Unbound process network (Wi-Fi has validated internet)")
                    }
                }

                override fun onLost(network: Network) {
                    if (boundCameraWifiNetwork == network) {
                        boundCameraWifiNetwork = null
                        cm.bindProcessToNetwork(null)
                        Log.i(TAG, "Local camera Wi-Fi lost; restored default process routing")
                    }
                }
            }
            wifiNetworkCallback = callback
            cm.registerNetworkCallback(request, callback)
        } catch (e: Exception) {
            Log.w(TAG, "Camera Wi-Fi binder setup notice: ${e.message}")
        }
    }

    private fun unregisterCameraWifiBinder() {
        try {
            val cm = connectivityManager
            val cb = wifiNetworkCallback
            if (cm != null && cb != null) {
                cm.unregisterNetworkCallback(cb)
            }
            if (boundCameraWifiNetwork != null) {
                cm?.bindProcessToNetwork(null)
                boundCameraWifiNetwork = null
            }
        } catch (e: Exception) {
            Log.w(TAG, "Camera Wi-Fi binder teardown notice: ${e.message}")
        } finally {
            wifiNetworkCallback = null
            connectivityManager = null
        }
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
        settings.allowFileAccess = false
        settings.allowContentAccess = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        // Grant camera and microphone access only to our local embedded server origin
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                val req = request ?: return
                val originHost = req.origin?.host?.lowercase()
                val originPort = req.origin?.port ?: -1
                val isLocalOrigin = (originHost == "127.0.0.1" || originHost == "localhost") &&
                    (originPort == SERVER_PORT || originPort == -1)
                if (!isLocalOrigin) {
                    Log.w(TAG, "Denying WebChromeClient permission request from untrusted origin: ${req.origin}")
                    req.deny()
                    return
                }

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

        if (this::webView.isInitialized && !isDestroyed) {
            webView.evaluateJavascript("window.__spotrOnAndroidCameraPermission?.($cameraGranted)", null)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        pendingWebPermissionRequest = null
        releaseWifiLock()
        unregisterCameraWifiBinder()

        if (this::webView.isInitialized) {
            try {
                webView.stopLoading()
                webView.loadUrl("about:blank")
                webView.destroy()
            } catch (e: Exception) {
                Log.w(TAG, "WebView destroy warning: ${e.message}")
            }
        }

        val serverToStop = server
        server = null
        val uvcToDestroy = uvcSessionManager
        uvcSessionManager = null

        // Run native network/USB teardown off the main thread to prevent ANRs
        Thread({
            try {
                serverToStop?.stop()
                Log.i(TAG, "SPOTR Local Server stopped.")
            } catch (e: Exception) {
                Log.e(TAG, "Error stopping server: ${e.message}")
            }
            try {
                uvcToDestroy?.destroy()
            } catch (e: Exception) {
                Log.e(TAG, "Error destroying UVC manager: ${e.message}")
            }
        }, "SpotrTeardown").apply {
            isDaemon = true
            start()
        }
    }
}
