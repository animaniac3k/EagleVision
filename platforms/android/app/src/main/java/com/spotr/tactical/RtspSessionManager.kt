package com.spotr.tactical

import android.media.MediaFormat
import android.util.Log
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Manages the active RTSP capture/decode session and pushes decoded JPEG frames
 * to MJPEG HTTP clients with zero-polling condition wakeup, client refcounting,
 * and bounded transient-drop auto-reconnect.
 */
class RtspSessionManager {

    companion object {
        private const val TAG = "RtspSessionManager"
        private const val MAX_AUTO_RECONNECTS = 2
    }

    private data class FramePacket(val jpeg: ByteArray, val seq: Long)

    private val lock = Object()
    private val sessionSeqGen = AtomicLong(0L)

    @Volatile
    private var currentSessionId = 0L
    private var activeUrl: String? = null
    @Volatile
    private var isRunning = false
    private var stage = "idle"
    private var latestJpeg: ByteArray? = null
    private var latestFrameSeq = 0L
    private var latestFrameTimeMs = 0L
    private var streamWidth = 0
    private var streamHeight = 0
    private var fps = 0.0
    private val rtpPacketsReceived = AtomicLong(0L)
    private var framesDecoded = 0L
    private var errorMessage: String? = null
    private var activeClientCount = 0

    private var workerThread: Thread? = null
    private var activeClient: RtspClient? = null
    private var activeDecoder: MediaCodecJpegDecoder? = null
    @Volatile
    private var encodePaused = false

    fun start(url: String, preferTcp: Boolean = true): Long {
        val now = System.currentTimeMillis()
        synchronized(lock) {
            if (isRunning && activeUrl == url && latestFrameTimeMs > 0L && (now - latestFrameTimeMs) < 1500L) {
                return currentSessionId
            }
        }

        stop()

        val sid = sessionSeqGen.incrementAndGet()
        synchronized(lock) {
            currentSessionId = sid
            activeUrl = url
            isRunning = true
            stage = "connecting"
            latestJpeg = null
            latestFrameSeq = 0L
            latestFrameTimeMs = 0L
            streamWidth = 0
            streamHeight = 0
            fps = 0.0
            rtpPacketsReceived.set(0L)
            framesDecoded = 0L
            errorMessage = null
            encodePaused = false
            activeClientCount = 0

            val t = Thread({
                runCaptureWorker(sid, url, preferTcp)
            }, "SpotrRtspWorker-$sid").apply {
                isDaemon = true
            }
            workerThread = t
            t.start()
        }
        return sid
    }

    fun stop(expectedSessionId: Long? = null) {
        val threadToJoin: Thread?
        val clientToClose: RtspClient?
        synchronized(lock) {
            if (expectedSessionId != null && expectedSessionId != currentSessionId) {
                return
            }
            if (!isRunning && activeClient == null) {
                if (expectedSessionId == null) {
                    errorMessage = null
                    stage = "idle"
                }
                return
            }
            isRunning = false
            stage = "stopped"
            encodePaused = false
            errorMessage = null
            activeClientCount = 0
            activeDecoder = null
            clientToClose = activeClient
            activeClient = null
            threadToJoin = workerThread
            workerThread = null
            activeUrl = null
            latestJpeg = null
            lock.notifyAll()
        }

        try {
            clientToClose?.close()
        } catch (_: Exception) {
        }

        if (threadToJoin != null && threadToJoin.isAlive && Thread.currentThread() !== threadToJoin) {
            try {
                threadToJoin.join(1200L)
            } catch (_: InterruptedException) {
            }
        }
    }

    fun waitForInitialFrame(sessionId: Long, timeoutMs: Long = 5500L): String? {
        val deadline = System.currentTimeMillis() + timeoutMs
        synchronized(lock) {
            while (currentSessionId == sessionId && isRunning && latestJpeg == null && errorMessage == null) {
                val remaining = deadline - System.currentTimeMillis()
                if (remaining <= 0L) break
                try {
                    lock.wait(min(remaining, 100L))
                } catch (_: InterruptedException) {
                    break
                }
            }
            if (latestJpeg == null) {
                return errorMessage ?: if (!isRunning) {
                    "RTSP stream stopped before receiving a video frame ($stage)"
                } else {
                    "Timed out waiting for initial RTSP video frame ($stage)"
                }
            }
            return null
        }
    }

    fun setEncodePaused(paused: Boolean) {
        synchronized(lock) {
            encodePaused = paused
            activeDecoder?.encodePaused = paused
        }
    }

    /**
     * Writes raw multipart/x-mixed-replace JPEG frames directly to [out] and flushes after every frame.
     */
    fun streamMjpegTo(sessionId: Long, out: OutputStream) {
        synchronized(lock) {
            if (currentSessionId == sessionId && isRunning) {
                activeClientCount++
            }
        }
        var lastSentSeq = 0L
        val bufferedOut = BufferedOutputStream(out, 65536)
        try {
            while (true) {
                val pkt = awaitNextFrame(sessionId, lastSentSeq) ?: break
                lastSentSeq = pkt.seq
                val jpeg = pkt.jpeg
                val header = (
                    "--frame\r\n" +
                        "Content-Type: image/jpeg\r\n" +
                        "Content-Length: ${jpeg.size}\r\n\r\n"
                    ).toByteArray(Charsets.US_ASCII)
                bufferedOut.write(header)
                bufferedOut.write(jpeg)
                bufferedOut.write('\r'.code)
                bufferedOut.write('\n'.code)
                bufferedOut.flush()
            }
        } catch (_: IOException) {
            // Client closed connection
        } finally {
            val shouldStop = synchronized(lock) {
                if (currentSessionId == sessionId) {
                    activeClientCount = (activeClientCount - 1).coerceAtLeast(0)
                    activeClientCount == 0
                } else {
                    false
                }
            }
            if (shouldStop) {
                stop(expectedSessionId = sessionId)
            }
        }
    }

    private fun awaitNextFrame(sessionId: Long, lastSentSeq: Long): FramePacket? {
        synchronized(lock) {
            while (isRunning && currentSessionId == sessionId) {
                val jpeg = latestJpeg
                val seq = latestFrameSeq
                if (jpeg != null && seq > lastSentSeq) {
                    return FramePacket(jpeg, seq)
                }
                try {
                    lock.wait(100L)
                } catch (_: InterruptedException) {
                    return null
                }
            }
            return null
        }
    }

    fun getStatusJson(): JSONObject {
        synchronized(lock) {
            val secAgo = if (latestFrameTimeMs > 0L) {
                ((System.currentTimeMillis() - latestFrameTimeMs) / 10.0).roundToInt() / 100.0
            } else {
                JSONObject.NULL
            }
            return JSONObject().apply {
                put("available", true)
                put("opencvVersion", "Android MediaCodec")
                put("status", "ok")
                put("platform", "android/chromeos")
                put("server", "SpotrEmbeddedGateway")
                put("isStreaming", isRunning)
                put("stage", stage)
                put("rtpPackets", rtpPacketsReceived.get())
                put("framesDecoded", framesDecoded)
                put("activeUrl", activeUrl ?: JSONObject.NULL)
                put("width", streamWidth)
                put("height", streamHeight)
                put("fps", (fps * 10.0).roundToInt() / 10.0)
                put("lastFrameSecAgo", secAgo)
                put("error", errorMessage ?: JSONObject.NULL)
            }
        }
    }

    private fun runCaptureWorker(sessionId: Long, url: String, preferTcp: Boolean) {
        Log.i(TAG, "Starting RTSP worker #$sessionId for $url (preferTcp=$preferTcp)")
        var reconnectAttempt = 0

        while (true) {
            val stillActive = synchronized(lock) { currentSessionId == sessionId && isRunning }
            if (!stillActive) break

            val client = RtspClient(url, preferTcp)
            synchronized(lock) {
                if (currentSessionId != sessionId || !isRunning) {
                    client.close()
                    return
                }
                activeClient = client
                stage = if (reconnectAttempt == 0) "handshake" else "reconnecting-$reconnectAttempt"
            }

            var decoder: MediaCodecJpegDecoder? = null
            var depacketizer: RtpVideoDepacketizer? = null
            var frameCount = 0
            var fpsWindowStartMs = System.currentTimeMillis()
            var receivedFrameThisAttempt = false

            val publishFrame: (ByteArray, Int, Int) -> Unit = { jpegBytes, w, h ->
                receivedFrameThisAttempt = true
                reconnectAttempt = 0
                val now = System.currentTimeMillis()
                frameCount++
                val elapsed = now - fpsWindowStartMs
                var updatedFps: Double? = null
                if (elapsed >= 1000L) {
                    updatedFps = frameCount * 1000.0 / elapsed
                    frameCount = 0
                    fpsWindowStartMs = now
                }
                synchronized(lock) {
                    if (currentSessionId == sessionId && isRunning) {
                        latestJpeg = jpegBytes
                        latestFrameSeq++
                        framesDecoded++
                        latestFrameTimeMs = now
                        stage = "streaming"
                        if (w > 0 && h > 0) {
                            streamWidth = w
                            streamHeight = h
                        }
                        if (updatedFps != null) {
                            fps = updatedFps
                        }
                        lock.notifyAll()
                    }
                }
            }

            var shouldRetry = false
            try {
                client.stream(
                    onTrackReady = { track ->
                        synchronized(lock) {
                            if (currentSessionId == sessionId) {
                                stage = "waiting-rtp (${track.codec})"
                            }
                        }
                        depacketizer = RtpVideoDepacketizer(track.codec, expectedPayloadType = track.payloadType)
                        when (track.codec) {
                            RtpVideoDepacketizer.VideoCodec.H264 -> {
                                decoder = MediaCodecJpegDecoder(
                                    mimeType = MediaFormat.MIMETYPE_VIDEO_AVC,
                                    initialConfigBytes = track.initialConfigBytes,
                                    jpegQuality = 75,
                                    onFrame = publishFrame
                                ).apply {
                                    encodePaused = this@RtspSessionManager.encodePaused
                                    start()
                                }
                                synchronized(lock) {
                                    if (currentSessionId == sessionId) activeDecoder = decoder
                                }
                            }
                            RtpVideoDepacketizer.VideoCodec.H265 -> {
                                decoder = MediaCodecJpegDecoder(
                                    mimeType = MediaFormat.MIMETYPE_VIDEO_HEVC,
                                    initialConfigBytes = track.initialConfigBytes,
                                    jpegQuality = 75,
                                    onFrame = publishFrame
                                ).apply {
                                    encodePaused = this@RtspSessionManager.encodePaused
                                    start()
                                }
                                synchronized(lock) {
                                    if (currentSessionId == sessionId) activeDecoder = decoder
                                }
                            }
                            RtpVideoDepacketizer.VideoCodec.JPEG -> {
                                Log.i(TAG, "Using direct MJPEG-over-RTP pass-through")
                            }
                        }
                    },
                    onRtpPacket = { packet, len ->
                        val pktCount = rtpPacketsReceived.incrementAndGet()
                        if (pktCount == 1L) {
                            synchronized(lock) {
                                if (currentSessionId == sessionId && framesDecoded == 0L) {
                                    stage = "decoding-rtp"
                                }
                            }
                        }
                        val dep = depacketizer ?: return@stream
                        val units = dep.processRtpPacket(packet, len)
                        for (unit in units) {
                            if (unit.isCompleteJpeg) {
                                val w = if (unit.width > 0) unit.width else streamWidth
                                val h = if (unit.height > 0) unit.height else streamHeight
                                publishFrame(unit.data, w, h)
                            } else {
                                decoder?.feedUnit(unit)
                            }
                        }
                    }
                )
                // Clean EOF while previously streaming -> try bounded reconnect
                val canReconnect = synchronized(lock) {
                    isRunning && currentSessionId == sessionId && receivedFrameThisAttempt && reconnectAttempt < MAX_AUTO_RECONNECTS
                }
                if (canReconnect) {
                    reconnectAttempt++
                    shouldRetry = true
                    Log.w(TAG, "RTSP EOF after streaming; reconnecting ($reconnectAttempt/$MAX_AUTO_RECONNECTS)...")
                }
            } catch (e: Exception) {
                val isExpectedStop = synchronized(lock) { !isRunning || currentSessionId != sessionId }
                if (!isExpectedStop) {
                    val canReconnect = receivedFrameThisAttempt && reconnectAttempt < MAX_AUTO_RECONNECTS
                    if (canReconnect) {
                        reconnectAttempt++
                        shouldRetry = true
                        Log.w(TAG, "RTSP transient error (${e.message}); reconnecting ($reconnectAttempt/$MAX_AUTO_RECONNECTS)...")
                    } else {
                        Log.w(TAG, "RTSP worker #$sessionId error at stage=$stage: ${e.message}", e)
                        val loc = e.stackTrace.firstOrNull { it.className.startsWith("com.spotr.") }
                            ?: e.stackTrace.firstOrNull()
                        val where = if (loc != null) " at ${loc.fileName}:${loc.lineNumber}" else ""
                        val detail = e.message?.takeIf { it.isNotBlank() } ?: "no-msg$where"
                        synchronized(lock) {
                            if (currentSessionId == sessionId) {
                                errorMessage = "${e.javaClass.simpleName}: $detail (stage=$stage)"
                                stage = "error"
                            }
                        }
                    }
                }
            } finally {
                try { decoder?.release() } catch (_: Exception) {}
                try { client.close() } catch (_: Exception) {}
                synchronized(lock) {
                    if (activeDecoder === decoder) activeDecoder = null
                    if (activeClient === client) activeClient = null
                }
            }

            if (shouldRetry) {
                try {
                    Thread.sleep(600L * reconnectAttempt)
                } catch (_: InterruptedException) {
                    break
                }
            } else {
                break
            }
        }

        synchronized(lock) {
            if (currentSessionId == sessionId) {
                isRunning = false
                if (errorMessage == null && stage != "stopped") {
                    stage = "ended"
                }
                lock.notifyAll()
            }
        }
        Log.i(TAG, "RTSP worker #$sessionId stopped (stage=$stage, rtp=${rtpPacketsReceived.get()}, frames=$framesDecoded)")
    }
}
