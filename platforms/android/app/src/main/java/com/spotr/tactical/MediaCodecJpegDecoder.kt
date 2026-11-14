package com.spotr.tactical

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.util.Log
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.math.min

/**
 * Hardware-accelerated H.264 / H.265 MediaCodec decoder that converts decoded YUV_420_888
 * frames directly into JPEG byte arrays for low-latency MJPEG streaming.
 */
class MediaCodecJpegDecoder(
    private val mimeType: String,
    private val initialConfigBytes: ByteArray?,
    private val jpegQuality: Int = 80,
    private val onFrame: (jpegBytes: ByteArray, width: Int, height: Int) -> Unit
) {
    companion object {
        private const val TAG = "MediaCodecJpegDecoder"
        private const val INPUT_TIMEOUT_US = 15_000L
        private const val OUTPUT_TIMEOUT_US = 5_000L
    }

    private var codec: MediaCodec? = null
    private val bufferInfo = MediaCodec.BufferInfo()
    private var ptsUs = 0L
    private var hasConfig = initialConfigBytes != null && initialConfigBytes.isNotEmpty()
    private var hasKeyFrame = false
    private var droppedBeforeKeyframe = 0

    // Reusable buffers on the single decoder thread to minimize GC pauses
    private var nv21Scratch = ByteArray(0)
    private var yRowScratch = ByteArray(0)
    private var uRowScratch = ByteArray(0)
    private var vRowScratch = ByteArray(0)
    private val jpegStream = ByteArrayOutputStream(131072)

    @Volatile
    private var released = false

    fun start(width: Int = 1920, height: Int = 1080) {
        val buildFormat = { lowLatency: Boolean ->
            MediaFormat.createVideoFormat(mimeType, width, height).apply {
                setInteger(
                    MediaFormat.KEY_COLOR_FORMAT,
                    MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible
                )
                if (lowLatency && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                }
                if (initialConfigBytes != null && initialConfigBytes.isNotEmpty()) {
                    setByteBuffer("csd-0", ByteBuffer.wrap(initialConfigBytes))
                }
            }
        }

        var mc = MediaCodec.createDecoderByType(mimeType)
        try {
            mc.configure(buildFormat(true), null, null, 0)
        } catch (e: Exception) {
            Log.w(TAG, "Retrying $mimeType configure without KEY_LOW_LATENCY: ${e.message}")
            mc.release()
            mc = MediaCodec.createDecoderByType(mimeType)
            mc.configure(buildFormat(false), null, null, 0)
        }
        mc.start()
        codec = mc
        Log.i(TAG, "Started $mimeType hardware decoder (hasSdpConfig=$hasConfig)")
    }

    fun feedUnit(unit: RtpVideoDepacketizer.EmittedUnit) {
        if (released) return
        val mc = codec ?: return

        if (unit.isConfig) {
            hasConfig = true
            queueInput(mc, unit.data, MediaCodec.BUFFER_FLAG_CODEC_CONFIG)
            drainOutputs(mc)
            return
        }

        if (!hasConfig) {
            // Wait until SPS/PPS arrives before feeding video slices
            return
        }

        if (!hasKeyFrame) {
            if (unit.isKeyFrame) {
                hasKeyFrame = true
            } else {
                droppedBeforeKeyframe++
                if (droppedBeforeKeyframe < 45) {
                    return
                }
                // Fallback in case stream uses intra-refresh without IDR flags
                hasKeyFrame = true
            }
        }

        val flags = if (unit.isKeyFrame) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
        queueInput(mc, unit.data, flags)
        drainOutputs(mc)
    }

    private fun queueInput(mc: MediaCodec, data: ByteArray, flags: Int) {
        val inIndex = mc.dequeueInputBuffer(INPUT_TIMEOUT_US)
        if (inIndex < 0) return

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

    private fun drainOutputs(mc: MediaCodec) {
        var timeout = OUTPUT_TIMEOUT_US
        while (!released) {
            val outIndex = mc.dequeueOutputBuffer(bufferInfo, timeout)
            timeout = 0L

            when {
                outIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> break
                outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val fmt = mc.outputFormat
                    Log.i(
                        TAG,
                        "Decoder output format changed: ${fmt.getInteger(MediaFormat.KEY_WIDTH)}x${fmt.getInteger(MediaFormat.KEY_HEIGHT)}"
                    )
                }
                outIndex >= 0 -> {
                    try {
                        if (bufferInfo.size > 0) {
                            val image = mc.getOutputImage(outIndex)
                            if (image != null) {
                                try {
                                    encodeImageToJpeg(image)
                                } finally {
                                    image.close()
                                }
                            }
                        }
                    } finally {
                        mc.releaseOutputBuffer(outIndex, false)
                    }
                }
            }
        }
    }

    private fun encodeImageToJpeg(image: Image) {
        val crop = image.cropRect
        val w = crop.width()
        val h = crop.height()
        if (w <= 0 || h <= 0) return

        val nv21 = yuv420888ToNv21(image, crop, w, h)
        jpegStream.reset()
        val yuvImage = YuvImage(nv21, ImageFormat.NV21, w, h, null)
        if (yuvImage.compressToJpeg(Rect(0, 0, w, h), jpegQuality, jpegStream)) {
            onFrame(jpegStream.toByteArray(), w, h)
        }
    }

    private fun yuv420888ToNv21(image: Image, crop: Rect, w: Int, h: Int): ByteArray {
        val neededSize = w * h * 3 / 2
        if (nv21Scratch.size < neededSize) {
            nv21Scratch = ByteArray(neededSize)
        }

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

        if (yRowScratch.size < yRowStride) yRowScratch = ByteArray(yRowStride)

        // Copy Y plane
        var dstPos = 0
        for (row in 0 until h) {
            val srcOffset = (crop.top + row) * yRowStride + crop.left * yPixStride
            if (yPixStride == 1 && srcOffset + w <= yLimit) {
                yBuf.position(srcOffset)
                yBuf.get(nv21Scratch, dstPos, w)
                dstPos += w
            } else {
                val readLen = min(yLimit - srcOffset, (w - 1) * yPixStride + 1)
                if (readLen > 0) {
                    yBuf.position(srcOffset)
                    yBuf.get(yRowScratch, 0, readLen)
                    for (col in 0 until w) {
                        nv21Scratch[dstPos++] = yRowScratch[col * yPixStride]
                    }
                } else {
                    dstPos += w
                }
            }
        }

        // Copy interleaved V/U planes into NV21 (VU order)
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

            for (col in 0 until uvW) {
                nv21Scratch[dstPos++] = vRowScratch[col * vPixStride]
                nv21Scratch[dstPos++] = uRowScratch[col * uPixStride]
            }
        }

        return nv21Scratch
    }

    fun release() {
        released = true
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
}
