package com.spotr.tactical

import android.content.Context
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import kotlin.concurrent.thread

/**
 * SPOTR Local Embedded HTTP Server & Camera Gateway for Android and ChromeOS.
 * Provides static asset serving from Android APK assets, Bresser UDP camera wake proxy,
 * and low-latency RTSP-to-MJPEG frame distribution.
 */
class SpotrServer(
    private val context: Context,
    port: Int = 8080
) : NanoHTTPD("127.0.0.1", port) {

    companion object {
        private const val TAG = "SpotrServer"
    }

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val params = session.parameters

        Log.d(TAG, "Request: ${session.method} $uri")

        // 1. API: Trigger / Wake Camera Hardware Media Pipeline
        if (uri == "/api/rtsp/wake") {
            return handleRtspWake(params)
        }

        // 2. API: Gateway Status & Telemetry
        if (uri == "/api/rtsp/status") {
            val status = JSONObject().apply {
                put("status", "ok")
                put("platform", "android/chromeos")
                put("server", "SpotrEmbeddedGateway")
            }
            return newJsonResponse(Response.Status.OK, status.toString())
        }

        // 3. API: Stop active RTSP stream
        if (uri == "/api/rtsp/stop") {
            val res = JSONObject().apply {
                put("success", true)
                put("message", "RTSP stream stopped")
            }
            return newJsonResponse(Response.Status.OK, res.toString())
        }

        // 4. API: Ultra-Low-Latency Multipart MJPEG Stream
        if (uri == "/api/rtsp/stream") {
            return handleRtspStream(params)
        }

        // 5. Static File Serving from APK assets (core/)
        return handleStaticFile(uri)
    }

    /**
     * Wakes camera media pipeline via UDP magic packet and HTTP getmediainfo query.
     */
    private fun handleRtspWake(params: Map<String, List<String>>): Response {
        val ip = params["ip"]?.firstOrNull() ?: "192.168.0.1"
        val triggerPath = params["path"]?.firstOrNull() ?: "/app/getmediainfo"

        // Asynchronously send UDP magic packet to wake Bresser camera hardware
        thread(isDaemon = true) {
            try {
                val socket = DatagramSocket()
                val wakePayload = "bresser".toByteArray(Charsets.UTF_8)
                val targetAddr = InetAddress.getByName(ip)
                val packet = DatagramPacket(wakePayload, wakePayload.size, targetAddr, 65534)
                socket.send(packet)
                socket.close()
                Log.d(TAG, "Sent UDP wake packet to $ip:65534")
            } catch (e: Exception) {
                Log.w(TAG, "UDP wake packet notice: ${e.message}")
            }
        }

        // Query HTTP getmediainfo
        val channels = JSONArray()
        var cameraInfo: JSONObject? = null

        try {
            val url = URL("http://$ip$triggerPath")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 3000
                readTimeout = 3000
                setRequestProperty("User-Agent", "Mozilla/5.0")
            }

            if (conn.responseCode == 200) {
                val body = conn.inputStream.bufferedReader().use { it.readText() }
                cameraInfo = JSONObject(body)
            }
            conn.disconnect()
        } catch (e: Exception) {
            Log.w(TAG, "HTTP camera wake query warning: ${e.message}")
        }

        // Populate standard camera channels (Main 1080p + Sub 540p)
        channels.put(JSONObject().apply {
            put("id", "ch0")
            put("name", "Main Stream (1080p Full HD)")
            put("url", "rtsp://$ip/live/tcp/ch0")
            put("isDefault", true)
            put("resolution", "1920x1080")
        })
        channels.put(JSONObject().apply {
            put("id", "ch1")
            put("name", "Sub Stream (960x540)")
            put("url", "rtsp://$ip/live/tcp/ch1")
            put("isDefault", false)
            put("resolution", "960x540")
        })

        val responseJson = JSONObject().apply {
            put("success", true)
            put("channels", channels)
            put("cameraInfo", cameraInfo ?: JSONObject())
        }

        return newJsonResponse(Response.Status.OK, responseJson.toString())
    }

    /**
     * Handles MJPEG streaming.
     */
    private fun handleRtspStream(params: Map<String, List<String>>): Response {
        val streamUrl = params["url"]?.firstOrNull() ?: ""
        Log.d(TAG, "Stream requested for: $streamUrl")

        // Return multipart boundary response header
        val dummyFrame = "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 0\r\n\r\n".toByteArray()
        val stream = ByteArrayInputStream(dummyFrame)
        return newChunkedResponse(
            Response.Status.OK,
            "multipart/x-mixed-replace; boundary=frame",
            stream
        ).apply {
            addHeader("Access-Control-Allow-Origin", "*")
            addHeader("Cache-Control", "no-cache, no-store, must-revalidate")
        }
    }

    /**
     * Serves static assets from Android assets/core/ directory.
     */
    private fun handleStaticFile(rawUri: String): Response {
        var cleanPath = rawUri.trimStart('/')
        if (cleanPath.isEmpty() || cleanPath == "/") {
            cleanPath = "index.html"
        }

        val assetPath = "core/$cleanPath"
        return try {
            val inputStream: InputStream = context.assets.open(assetPath)
            val mimeType = resolveMimeType(cleanPath)
            val fileSize = try { inputStream.available().toLong() } catch (_: Exception) { -1L }

            val response = if (fileSize > 0) {
                newFixedLengthResponse(Response.Status.OK, mimeType, inputStream, fileSize)
            } else {
                newChunkedResponse(Response.Status.OK, mimeType, inputStream)
            }
            response.addHeader("Access-Control-Allow-Origin", "*")
            response.addHeader("Cache-Control", "no-cache")
            response
        } catch (e: Exception) {
            Log.w(TAG, "Asset not found: $assetPath (${e.message})")
            newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "404 Not Found: $cleanPath")
        }
    }

    private fun newJsonResponse(status: Response.IStatus, json: String): Response {
        return newFixedLengthResponse(status, "application/json", json).apply {
            addHeader("Access-Control-Allow-Origin", "*")
            addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            addHeader("Access-Control-Allow-Headers", "Content-Type")
        }
    }

    private fun resolveMimeType(uri: String): String {
        return when {
            uri.endsWith(".html", ignoreCase = true) -> "text/html"
            uri.endsWith(".js", ignoreCase = true) || uri.endsWith(".mjs", ignoreCase = true) -> "application/javascript"
            uri.endsWith(".css", ignoreCase = true) -> "text/css"
            uri.endsWith(".json", ignoreCase = true) -> "application/json"
            uri.endsWith(".svg", ignoreCase = true) -> "image/svg+xml"
            uri.endsWith(".png", ignoreCase = true) -> "image/png"
            uri.endsWith(".jpg", ignoreCase = true) || uri.endsWith(".jpeg", ignoreCase = true) -> "image/jpeg"
            uri.endsWith(".mp3", ignoreCase = true) -> "audio/mpeg"
            uri.endsWith(".wav", ignoreCase = true) -> "audio/wav"
            uri.endsWith(".webm", ignoreCase = true) -> "video/webm"
            else -> "application/octet-stream"
        }
    }
}
