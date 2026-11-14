package com.spotr.tactical

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.util.Log
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.Locale
import kotlin.math.min

/**
 * Low-latency H.264 / H.265 MediaCodec decoder (with automatic software fallback for
 * ChromeOS ARCVM) using a decoupled single-slot conflated JPEG encoder thread so the
 * RTSP socket reader never stalls behind JPEG compression.
 */
class MediaCodecJpegDecoder(
    private val mimeType: String,
    initialConfigBytes: ByteArray?,
    private val jpegQuality: Int = 70,
    private val onFrame: (jpegBytes: ByteArray, width: Int, height: Int) -> Unit
) {
    companion object {
        private const val TAG = "MediaCodecJpegDecoder"
        private const val INPUT_TIMEOUT_US = 8_000L
        private const val OUTPUT_TIMEOUT_US = 1_000L
    }

    private data class PendingNv21(val data: ByteArray, val width: Int, val height: Int)

    private var codec: MediaCodec? = null
    @Volatile
    var activeDecoderName: String = ""
        private set
    @Volatile
    var usingSoftwareCodec: Boolean = false
        private set

    private val bufferInfo = MediaCodec.BufferInfo()
    private var ptsUs = 0L
    private var initialWidth = 1920
    private var initialHeight = 1080

    private var savedConfigBytes: ByteArray? = initialConfigBytes?.takeIf { it.isNotEmpty() }
    private var hasConfig = savedConfigBytes != null
    private var configSentToCodec = false
    private var hasKeyFrame = false
    private var droppedBeforeKeyframe = 0
    private var decodedAnyFrame = false

    private val pendingConfigNals = ByteArrayOutputStream(512)
    private var seenSps = false
    private var seenPps = false

    // Decoupled 1-slot conflated JPEG encoding pipeline
    private val encodeLock = Object()
    private var pendingEncode: PendingNv21? = null
    private var recycledNv21: ByteArray? = null
    private var jpegThread: Thread? = null

    private var yRowScratch = ByteArray(0)
    private var uRowScratch = ByteArray(0)
    private var vRowScratch = ByteArray(0)

    @Volatile
    private var released = false

    fun start(width: Int = 1920, height: Int = 1080) {
        initialWidth = width
        initialHeight = height
        startJpegEncoderThread()
        try {
            startCodec(forceSoftware = false)
        } catch (e: Exception) {
            Log.w(TAG, "Hardware decoder start failed (${e.message}); trying software fallback")
            startCodec(forceSoftware = true)
        }
    }

    private fun startJpegEncoderThread() {
        val t = Thread({
            val jpegStream = ByteArrayOutputStream(131072)
            while (!released) {
                val frame: PendingNv21 = synchronized(encodeLock) {
                    while (!released && pendingEncode == null) {
                        try {
                            encodeLock.wait(200L)
                        } catch (_: InterruptedException) {
                            return@Thread
                        }
                    }
                    val f = pendingEncode
                    pendingEncode = null
                    f
                } ?: continue

                try {
                    jpegStream.reset()
                    val yuvImage = YuvImage(frame.data, ImageFormat.NV21, frame.width, frame.height, null)
                    if (yuvImage.compressToJpeg(Rect(0, 0, frame.width, frame.height), jpegQuality, jpegStream)) {
                        onFrame(jpegStream.toByteArray(), frame.width, frame.height)
                    }
                } finally {
                    synchronized(encodeLock) {
                        if (recycledNv21 == null || recycledNv21!!.size < frame.data.size) {
                            recycledNv21 = frame.data
                        }
                    }
                }
            }
        }, "SpotrJpegEnc").apply { isDaemon = true }
        jpegThread = t
        t.start()
    }

    private fun startCodec(forceSoftware: Boolean) {
        releaseCodecOnly()

        val swName = if (forceSoftware) findSoftwareDecoderName(mimeType) else null
        if (forceSoftware && swName == null) {
            throw IllegalStateException("No software fallback decoder available for $mimeType")
        }
        usingSoftwareCodec = forceSoftware

        val buildFormat = { lowLatency: Boolean ->
            MediaFormat.createVideoFormat(mimeType, initialWidth, initialHeight).apply {
                setInteger(
                    MediaFormat.KEY_COLOR_FORMAT,
                    MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible
                )
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 1024 * 1024)
                if (!forceSoftware && lowLatency && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                }
                val cfg = savedConfigBytes
                if (cfg != null && cfg.isNotEmpty()) {
                    setByteBuffer("csd-0", ByteBuffer.wrap(cfg))
                }
            }
        }

        var mc = if (swName != null) {
            MediaCodec.createByCodecName(swName)
        } else {
            MediaCodec.createDecoderByType(mimeType)
        }

        try {
            mc.configure(buildFormat(true), null, null, 0)
        } catch (e: Exception) {
            Log.w(TAG, "Retrying ${mc.name} configure without KEY_LOW_LATENCY: ${e.message}")
            mc.release()
            mc = if (swName != null) {
                MediaCodec.createByCodecName(swName)
            } else {
                MediaCodec.createDecoderByType(mimeType)
            }
            mc.configure(buildFormat(false), null, null, 0)
        }

        mc.start()
        codec = mc
        activeDecoderName = mc.name
        configSentToCodec = savedConfigBytes != null
        Log.i(TAG, "Started decoder ${mc.name} ($mimeType, sw=$forceSoftware, hasSdpConfig=$hasConfig)")
    }

    fun feedUnit(unit: RtpVideoDepacketizer.EmittedUnit) {
        if (released) return

        if (unit.isConfig) {
            handleConfigNal(unit.data)
            return
        }

        if (pendingConfigNals.size() > 0) {
            flushAccumulatedConfig()
        }

        if (!hasConfig) return

        if (!hasKeyFrame) {
            if (unit.isKeyFrame) {
                hasKeyFrame = true
            } else {
                droppedBeforeKeyframe++
                if (droppedBeforeKeyframe < 45) return
                hasKeyFrame = true
            }
        }

        try {
            feedSliceInternal(unit)
        } catch (e: IllegalStateException) {
            if (!usingSoftwareCodec && !decodedAnyFrame) {
                Log.w(TAG, "Hardware decoder failed (${e.javaClass.simpleName}: ${e.message}); falling back to software decoder", e)
                switchToSoftwareDecoderAndRetry(unit)
            } else {
                throw e
            }
        }
    }

    private fun handleConfigNal(annexBNal: ByteArray) {
        if (annexBNal.size > 4) {
            if (mimeType == MediaFormat.MIMETYPE_VIDEO_AVC) {
                val nalType = annexBNal[4].toInt() and 0x1F
                if (nalType == 7) {
                    if (seenSps && seenPps) {
                        pendingConfigNals.reset()
                        seenPps = false
                    }
                    seenSps = true
                } else if (nalType == 8) {
                    seenPps = true
                }
            } else {
                val nalType = ((annexBNal[4].toInt() and 0xFF) ushr 1) and 0x3F
                if (nalType == 32 || nalType == 33) seenSps = true
                if (nalType == 34) seenPps = true
            }
        }

        pendingConfigNals.write(annexBNal)
        if (seenSps && seenPps) {
            flushAccumulatedConfig()
        }
    }

    private fun flushAccumulatedConfig() {
        val combined = pendingConfigNals.toByteArray()
        pendingConfigNals.reset()
        if (combined.isEmpty()) return

        savedConfigBytes = combined
        hasConfig = true

        val mc = codec ?: return
        try {
            queueInput(mc, combined, MediaCodec.BUFFER_FLAG_CODEC_CONFIG)
            configSentToCodec = true
            drainOutputs(mc)
        } catch (e: IllegalStateException) {
            if (!usingSoftwareCodec && !decodedAnyFrame) {
                Log.w(TAG, "Hardware decoder failed on config (${e.message}); switching to software decoder")
                startCodec(forceSoftware = true)
            } else {
                throw e
            }
        }
    }

    private fun feedSliceInternal(unit: RtpVideoDepacketizer.EmittedUnit) {
        val mc = codec ?: return
        if (!configSentToCodec && savedConfigBytes != null) {
            queueInput(mc, savedConfigBytes!!, MediaCodec.BUFFER_FLAG_CODEC_CONFIG)
            configSentToCodec = true
        }
        val flags = if (unit.isKeyFrame) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
        queueInput(mc, unit.data, flags)
        drainOutputs(mc)
    }

    private fun switchToSoftwareDecoderAndRetry(currentUnit: RtpVideoDepacketizer.EmittedUnit) {
        startCodec(forceSoftware = true)
        if (currentUnit.isKeyFrame || hasKeyFrame) {
            feedSliceInternal(currentUnit)
        }
    }

    private fun queueInput(mc: MediaCodec, data: ByteArray, flags: Int) {
        var inIndex = mc.dequeueInputBuffer(INPUT_TIMEOUT_US)
        if (inIndex < 0) {
            drainOutputs(mc)
            inIndex = mc.dequeueInputBuffer(INPUT_TIMEOUT_US)
            if (inIndex < 0) return
        }

        val inBuf = mc.getInputBuffer(inIndex) ?: return
        inBuf.clear()
        if (data.size <= inBuf.remaining()) {
            inBuf.put(data)
            ptsUs += 33_333L
            mc.queueInputBuffer(inIndex, 0, data.size, ptsUs, flags)
        } else {
            mc.queueInputBuffer(inIndex, 0, 0, 0L, 0)
        }
    }

    /**
     * Drains all ready decoded buffers from [mc], converting only the newest ready frame
     * to NV21 so stale backlog frames are discarded immediately without CPU waste.
     */
    private fun drainOutputs(mc: MediaCodec) {
        var latestOutIndex = -1
        var timeout = OUTPUT_TIMEOUT_US

        while (!released) {
            val outIndex = mc.dequeueOutputBuffer(bufferInfo, timeout)
            timeout = 0L

            when {
                outIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> break
                outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val fmt = mc.outputFormat
                    val w = if (fmt.containsKey(MediaFormat.KEY_WIDTH)) fmt.getInteger(MediaFormat.KEY_WIDTH) else 0
                    val h = if (fmt.containsKey(MediaFormat.KEY_HEIGHT)) fmt.getInteger(MediaFormat.KEY_HEIGHT) else 0
                    Log.i(TAG, "Decoder output format changed: ${w}x${h}")
                }
                outIndex >= 0 -> {
                    if (bufferInfo.size > 0) {
                        if (latestOutIndex >= 0) {
                            mc.releaseOutputBuffer(latestOutIndex, false)
                        }
                        latestOutIndex = outIndex
                    } else {
                        mc.releaseOutputBuffer(outIndex, false)
                    }
                }
            }
        }

        if (latestOutIndex >= 0) {
            try {
                val image = mc.getOutputImage(latestOutIndex)
                if (image != null) {
                    try {
                        submitImageForJpeg(image)
                    } finally {
                        image.close()
                    }
                }
            } finally {
                mc.releaseOutputBuffer(latestOutIndex, false)
            }
        }
    }

    private fun submitImageForJpeg(image: Image) {
        val crop = image.cropRect
        val w = crop.width()
        val h = crop.height()
        if (w <= 0 || h <= 0) return

        val neededSize = w * h * 3 / 2
        val nv21 = synchronized(encodeLock) {
            val recycled = recycledNv21
            recycledNv21 = null
            if (recycled != null && recycled.size >= neededSize) recycled else ByteArray(neededSize)
        }

        fillNv21(image, crop, w, h, nv21)
        decodedAnyFrame = true

        synchronized(encodeLock) {
            val dropped = pendingEncode
            pendingEncode = PendingNv21(nv21, w, h)
            if (dropped != null && (recycledNv21 == null || recycledNv21!!.size < dropped.data.size)) {
                recycledNv21 = dropped.data
            }
            encodeLock.notifyAll()
        }
    }

    private fun fillNv21(image: Image, crop: Rect, w: Int, h: Int, dst: ByteArray) {
        val planes = image.planes
        val yPlane = planes[0]
        val uPlane = planes[1]
        val vPlane = planes[2]

        val yBuf = yPlane.buffer
        val uBuf = uPlane.buffer
        val vBuf = vPlane.buffer

        val yRowStride = yPlane.rowStride
        val yPixStride = yPlane.pixelStride
        val yLimit = yBuf.limit()

        // Fast bulk path for full-plane contiguous Y
        var dstPos = 0
        if (yPixStride == 1 && crop.left == 0 && yRowStride == w && crop.top == 0 && w * h <= yLimit) {
            yBuf.position(0)
            yBuf.get(dst, 0, w * h)
            dstPos = w * h
        } else {
            if (yRowScratch.size < yRowStride) yRowScratch = ByteArray(yRowStride)
            for (row in 0 until h) {
                val srcOffset = (crop.top + row) * yRowStride + crop.left * yPixStride
                if (yPixStride == 1 && srcOffset + w <= yLimit) {
                    yBuf.position(srcOffset)
                    yBuf.get(dst, dstPos, w)
                    dstPos += w
                } else {
                    val readLen = min(yLimit - srcOffset, (w - 1) * yPixStride + 1)
                    if (readLen > 0) {
                        yBuf.position(srcOffset)
                        yBuf.get(yRowScratch, 0, readLen)
                        for (col in 0 until w) {
                            dst[dstPos++] = yRowScratch[col * yPixStride]
                        }
                    } else {
                        dstPos += w
                    }
                }
            }
        }

        val uvW = w / 2
        val uvH = h / 2
        val uvTop = crop.top / 2
        val uvLeft = crop.left / 2

        val uRowStride = uPlane.rowStride
        val uPixStride = uPlane.pixelStride
        val uLimit = uBuf.limit()

        val vRowStride = vPlane.rowStride
        val vPixStride = vPlane.pixelStride
        val vLimit = vBuf.limit()

        if (uRowScratch.size < uRowStride) uRowScratch = ByteArray(uRowStride)
        if (vRowScratch.size < vRowStride) vRowScratch = ByteArray(vRowStride)

        for (row in 0 until uvH) {
            val vOffset = (uvTop + row) * vRowStride + uvLeft * vPixStride
            val uOffset = (uvTop + row) * uRowStride + uvLeft * uPixStride

            val vReadLen = min(vLimit - vOffset, (uvW - 1) * vPixStride + 1)
            val uReadLen = min(uLimit - uOffset, (uvW - 1) * uPixStride + 1)

            if (vReadLen <= 0 || uReadLen <= 0) break

            vBuf.position(vOffset)
            vBuf.get(vRowScratch, 0, vReadLen)
            uBuf.position(uOffset)
            uBuf.get(uRowScratch, 0, uReadLen)

            if (vPixStride == 1 && uPixStride == 1) {
                for (col in 0 until uvW) {
                    dst[dstPos++] = vRowScratch[col]
                    dst[dstPos++] = uRowScratch[col]
                }
            } else {
                var vIdx = 0
                var uIdx = 0
                for (col in 0 until uvW) {
                    dst[dstPos++] = vRowScratch[vIdx]
                    dst[dstPos++] = uRowScratch[uIdx]
                    vIdx += vPixStride
                    uIdx += uPixStride
                }
            }
        }
    }

    private fun findSoftwareDecoderName(mime: String): String? {
        val list = MediaCodecList(MediaCodecList.REGULAR_CODECS)
        for (info in list.codecInfos) {
            if (info.isEncoder) continue
            if (!info.supportedTypes.any { it.equals(mime, ignoreCase = true) }) continue
            val name = info.name.lowercase(Locale.US)
            if (name.startsWith("c2.android.") || name.startsWith("omx.google.")) {
                return info.name
            }
        }
        return null
    }

    private fun releaseCodecOnly() {
        val mc = codec
        codec = null
        if (mc != null) {
            try {
                mc.stop()
            } catch (_: Exception) {
            }
            try {
                mc.release()
            } catch (_: Exception) {
            }
        }
    }

    fun release() {
        released = true
        synchronized(encodeLock) {
            pendingEncode = null
            encodeLock.notifyAll()
        }
        jpegThread?.let {
            try {
                it.join(500L)
            } catch (_: InterruptedException) {
            }
        }
        jpegThread = null
        releaseCodecOnly()
    }
}
