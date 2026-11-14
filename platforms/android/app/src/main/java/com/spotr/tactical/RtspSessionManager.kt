package com.spotr.tactical

import android.media.MediaFormat
import android.util.Log
import org.json.JSONObject
import java.io.InputStream
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Manages the active RTSP capture/decode session and pushes decoded JPEG frames
 * to MJPEG HTTP clients with zero-polling condition wakeup.
 */
class RtspSessionManager {

    companion object {
        private const val TAG = "RtspSessionManager"
    }

    private val lock = Object()
    private val sessionSeqGen = AtomicLong(0L)

    private var currentSessionId = 0L
    private var activeUrl: String? = null
    private var isRunning = false
    private var latestJpeg: ByteArray? = null
    private var latestFrameSeq = 0L
    private var latestFrameTimeMs = 0L
    private var streamWidth = 0
    private var streamHeight = 0
    private var fps = 0.0
    private var errorMessage: String? = null

    private var workerThread: Thread? = null
    private var activeClient: RtspClient? = null

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
            latestJpeg = null
            latestFrameSeq = 0L
            latestFrameTimeMs = 0L
            streamWidth = 0
            streamHeight = 0
            fps = 0.0
            errorMessage = null

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
                return
            }
            isRunning = false
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

    fun waitForInitialFrame(sessionId: Long, timeoutMs: Long = 4500L): String? {
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
            return if (latestJpeg == null) errorMessage else null
        }
    }

    fun openMjpegInputStream(sessionId: Long): InputStream {
        return MjpegFrameInputStream(sessionId)
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
        val client = RtspClient(url, preferTcp)
        synchronized(lock) {
            if (currentSessionId != sessionId || !isRunning) {
                client.close()
                return
            }
            activeClient = client
        }

        var decoder: MediaCodecJpegDecoder? = null
        var depacketizer: RtpVideoDepacketizer? = null
        var frameCount = 0
        var fpsWindowStartMs = System.currentTimeMillis()

        val publishFrame: (ByteArray, Int, Int) -> Unit = { jpegBytes, w, h ->
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
                    latestFrameTimeMs = now
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

        try {
            client.stream(
                onTrackReady = { track ->
                    depacketizer = RtpVideoDepacketizer(track.codec)
                    when (track.codec) {
                        RtpVideoDepacketizer.VideoCodec.H264 -> {
                            decoder = MediaCodecJpegDecoder(
                                mimeType = MediaFormat.MIMETYPE_VIDEO_AVC,
                                initialConfigBytes = track.initialConfigBytes,
                                jpegQuality = 80,
                                onFrame = publishFrame
                            ).apply { start() }
                        }
                        RtpVideoDepacketizer.VideoCodec.H265 -> {
                            decoder = MediaCodecJpegDecoder(
                                mimeType = MediaFormat.MIMETYPE_VIDEO_HEVC,
                                initialConfigBytes = track.initialConfigBytes,
                                jpegQuality = 80,
                                onFrame = publishFrame
                            ).apply { start() }
                        }
                        RtpVideoDepacketizer.VideoCodec.JPEG -> {
                            Log.i(TAG, "Using direct MJPEG-over-RTP pass-through")
                        }
                    }
                },
                onRtpPacket = { packet, len ->
                    val dep = depacketizer ?: return@stream
                    val units = dep.processRtpPacket(packet, len)
                    for (unit in units) {
                        if (unit.isCompleteJpeg) {
                            publishFrame(unit.data, streamWidth, streamHeight)
                        } else {
                            decoder?.feedUnit(unit)
                        }
                    }
                }
            )
        } catch (e: Exception) {
            val isExpectedStop = synchronized(lock) { !isRunning || currentSessionId != sessionId }
            if (!isExpectedStop) {
                Log.w(TAG, "RTSP worker #$sessionId error: ${e.message}", e)
                synchronized(lock) {
                    if (currentSessionId == sessionId) {
                        errorMessage = e.message ?: "RTSP stream error"
                    }
                }
            }
        } finally {
            try {
                decoder?.release()
            } catch (_: Exception) {
            }
            try {
                client.close()
            } catch (_: Exception) {
            }
            synchronized(lock) {
                if (currentSessionId == sessionId) {
                    isRunning = false
                    if (activeClient === client) activeClient = null
                    lock.notifyAll()
                }
            }
            Log.i(TAG, "RTSP worker #$sessionId stopped")
        }
    }

    private inner class MjpegFrameInputStream(private val sessionId: Long) : InputStream() {
        private var currentPart: ByteArray? = null
        private var currentOffset = 0
        private var lastSentSeq = 0L

        @Volatile
        private var closed = false

        override fun read(): Int {
            val one = ByteArray(1)
            val n = read(one, 0, 1)
            return if (n <= 0) -1 else (one[0].toInt() and 0xFF)
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len <= 0) return 0
            if (closed) return -1

            if (currentPart == null || currentOffset >= currentPart!!.size) {
                val nextJpeg = awaitNextFrame() ?: return -1
                val header = (
                    "--frame\r\n" +
                        "Content-Type: image/jpeg\r\n" +
                        "Content-Length: ${nextJpeg.size}\r\n\r\n"
                    ).toByteArray(Charsets.US_ASCII)
                val part = ByteArray(header.size + nextJpeg.size + 2)
                System.arraycopy(header, 0, part, 0, header.size)
                System.arraycopy(nextJpeg, 0, part, header.size, nextJpeg.size)
                part[part.size - 2] = '\r'.code.toByte()
                part[part.size - 1] = '\n'.code.toByte()
                currentPart = part
                currentOffset = 0
            }

            val part = currentPart!!
            val toCopy = min(len, part.size - currentOffset)
            System.arraycopy(part, currentOffset, b, off, toCopy)
            currentOffset += toCopy
            return toCopy
        }

        private fun awaitNextFrame(): ByteArray? {
            synchronized(lock) {
                while (!closed && isRunning && currentSessionId == sessionId) {
                    val jpeg = latestJpeg
                    if (jpeg != null && latestFrameSeq > lastSentSeq) {
                        lastSentSeq = latestFrameSeq
                        return jpeg
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

        override fun close() {
            if (closed) return
            closed = true
            synchronized(lock) {
                lock.notifyAll()
            }
            // Release camera session when the client disconnects
            stop(expectedSessionId = sessionId)
        }
    }
}
