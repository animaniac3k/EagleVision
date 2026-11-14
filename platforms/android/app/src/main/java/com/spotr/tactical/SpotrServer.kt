package com.spotr.tactical

import android.content.Context
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL

/**
 * SPOTR Local Embedded HTTP Server & Camera Gateway for Android and ChromeOS.
 * Provides static asset serving from Android APK assets, Bresser UDP/HTTP camera wake proxy,
 * and low-latency native RTSP-to-MJPEG frame distribution via MediaCodec.
 */
class SpotrServer(
    private val context: Context,
    port: Int = 8080
) : NanoHTTPD("127.0.0.1", port) {

    companion object {
        private const val TAG = "SpotrServer"
    }

    private val rtspSession = RtspSessionManager()

    override fun stop() {
        rtspSession.stop()
        super.stop()
    }

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val params = session.parameters

        Log.d(TAG, "Request: ${session.method} $uri")

        if (session.method == Method.OPTIONS) {
            return newJsonResponse(Response.Status.OK, "{}")
        }

        // 1. API: Trigger / Wake Camera Hardware Media Pipeline
        if (uri == "/api/rtsp/wake") {
            return handleRtspWake(params)
        }

        // 2. API: Gateway Status & Telemetry
        if (uri == "/api/rtsp/status") {
            return newJsonResponse(Response.Status.OK, rtspSession.getStatusJson().toString())
        }

        // 3. API: Stop active RTSP stream
        if (uri == "/api/rtsp/stop") {
            rtspSession.stop()
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
        val ip = (params["ip"]?.firstOrNull() ?: "192.168.0.1").trim()
        val rawPath = (params["path"]?.firstOrNull() ?: "/app/getmediainfo").trim()
        val triggerPath = if (rawPath.startsWith("/")) rawPath else "/$rawPath"

        // Stop any active RTSP session so camera port 554 is free before wake
        rtspSession.stop()

        // Send UDP magic wake packet to Bresser camera hardware (port 65534)
        try {
            DatagramSocket().use { socket ->
                val wakePayload = "bresser".toByteArray(Charsets.UTF_8)
                val targetAddr = InetAddress.getByName(ip)
                val packet = DatagramPacket(wakePayload, wakePayload.size, targetAddr, 65534)
                socket.send(packet)
                Log.d(TAG, "Sent UDP wake packet to $ip:65534")
            }
        } catch (e: Exception) {
            Log.w(TAG, "UDP wake packet notice: ${e.message}")
        }

        // Query HTTP getmediainfo
        var cameraInfo: JSONObject? = null
        var wakeError: String? = null

        try {
            val url = URL("http://$ip$triggerPath")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 3500
                readTimeout = 3500
                setRequestProperty("User-Agent", "Mozilla/5.0")
            }

            try {
                if (conn.responseCode in 200..299) {
                    val body = conn.inputStream.bufferedReader().use { it.readText() }
                    cameraInfo = try {
                        JSONObject(body)
                    } catch (_: Exception) {
                        JSONObject().put("raw", body)
                    }
                } else {
                    wakeError = "HTTP ${conn.responseCode} from $ip$triggerPath"
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "HTTP camera wake query warning: ${e.message}")
            wakeError = e.message ?: "Failed to reach camera at $ip"
        }

        if (wakeError != null) {
            val failJson = JSONObject().apply {
                put("success", false)
                put("ip", ip)
                put("error", wakeError)
                put("message", "Could not reach camera at $ip. Ensure device is connected to the camera Wi-Fi network.")
            }
            return newJsonResponse(Response.Status.OK, failJson.toString())
        }

        val channels = JSONArray().apply {
            put(JSONObject().apply {
                put("id", "ch0")
                put("name", "Main Stream (1080p Full HD)")
                put("url", "rtsp://$ip/live/tcp/ch0")
                put("isDefault", true)
                put("resolution", "1920x1080")
            })
            put(JSONObject().apply {
                put("id", "ch1")
                put("name", "Sub Stream (960x540)")
                put("url", "rtsp://$ip/live/tcp/ch1")
                put("isDefault", false)
                put("resolution", "960x540")
            })
        }

        val declaredRtsp = cameraInfo?.optJSONObject("info")?.opt("rtsp")
        val responseJson = JSONObject().apply {
            put("success", true)
            put("ip", ip)
            put("message", "Camera pipeline awakened successfully")
            if (declaredRtsp != null) put("declaredRtsp", declaredRtsp)
            put("channels", channels)
            put("cameraInfo", cameraInfo ?: JSONObject())
        }

        return newJsonResponse(Response.Status.OK, responseJson.toString())
    }

    /**
     * Streams continuous multipart/x-mixed-replace JPEG frames decoded from RTSP.
     */
    private fun handleRtspStream(params: Map<String, List<String>>): Response {
        val streamUrl = (params["url"]?.firstOrNull() ?: "").trim()
        if (streamUrl.isEmpty()) {
            val err = JSONObject().apply {
                put("success", false)
                put("error", "Missing 'url' query parameter.")
            }
            return newJsonResponse(Response.Status.BAD_REQUEST, err.toString())
        }

        val transport = (params["transport"]?.firstOrNull() ?: "tcp").trim().lowercase()
        val preferTcp = transport != "udp"

        Log.d(TAG, "Stream requested for: $streamUrl (preferTcp=$preferTcp)")
        val sessionId = rtspSession.start(streamUrl, preferTcp)

        val startupError = rtspSession.waitForInitialFrame(sessionId, timeoutMs = 5500L)
        if (startupError != null) {
            rtspSession.stop(expectedSessionId = sessionId)
            val err = JSONObject().apply {
                put("success", false)
                put("error", startupError)
            }
            return newJsonResponse(Response.Status.INTERNAL_ERROR, err.toString())
        }

        return MjpegStreamResponse(sessionId)
    }

    private inner class MjpegStreamResponse(
        private val sessionId: Long
    ) : Response(
        Status.OK,
        "multipart/x-mixed-replace; boundary=frame",
        ByteArrayInputStream(ByteArray(0)),
        -1L
    ) {
        init {
            setKeepAlive(false)
            setChunkedTransfer(false)
        }

        override fun send(outputStream: OutputStream) {
            try {
                val headers = (
                    "HTTP/1.1 200 OK\r\n" +
                        "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n" +
                        "Cache-Control: no-cache, no-store, must-revalidate\r\n" +
                        "Pragma: no-cache\r\n" +
                        "Expires: 0\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Connection: close\r\n\r\n"
                    ).toByteArray(Charsets.US_ASCII)
                outputStream.write(headers)
                outputStream.flush()
                rtspSession.streamMjpegTo(sessionId, outputStream)
            } catch (e: Exception) {
                Log.d(TAG, "MJPEG response ended for session #$sessionId: ${e.message}")
            } finally {
                rtspSession.stop(expectedSessionId = sessionId)
            }
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
