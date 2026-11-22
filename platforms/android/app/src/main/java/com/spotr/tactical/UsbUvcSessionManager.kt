package com.spotr.tactical

import android.content.Context
import android.graphics.ImageFormat
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import com.serenegiant.usb.IFrameCallback
import com.serenegiant.usb.Size
import com.serenegiant.usb.USBMonitor
import com.serenegiant.usb.UVCCamera
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Manages USB Video Class (UVC) camera discovery, USB Host permission flow,
 * headless frame capture via libuvc, and multipart MJPEG distribution for Android & ChromeOS.
 */
class UsbUvcSessionManager(
    context: Context,
    private val onDevicesChanged: () -> Unit = {}
) {
    companion object {
        private const val TAG = "UsbUvcSessionManager"
        private const val UVC_DEVICE_ID_PREFIX = "uvc:"
    }

    private data class FramePacket(val jpeg: ByteArray, val seq: Long)

    private val appContext = context.applicationContext
    private val usbManager: UsbManager? = appContext.getSystemService(Context.USB_SERVICE) as? UsbManager

    private val lock = Object()
    private val cameraOpLock = Any()
    private val sessionSeqGen = AtomicLong(0L)

    @Volatile
    private var currentSessionId = 0L
    private var activeDeviceId: String? = null
    private var targetDeviceName: String? = null
    @Volatile
    private var isRunning = false
    private var stage = "idle"
    private var latestJpeg: ByteArray? = null
    private var latestFrameSeq = 0L
    private var latestFrameTimeMs = 0L
    private var streamWidth = 0
    private var streamHeight = 0
    private var fps = 0.0
    private var framesCaptured = 0L
    private var errorMessage: String? = null
    private var activeClientCount = 0

    @Volatile
    private var encodePaused = false

    private var activeCamera: UVCCamera? = null
    private var activeImageReader: ImageReader? = null
    private var surfaceThread: HandlerThread? = null
    private var encoderThread: Thread? = null
    private val encodeLock = Object()
    private var pendingNv21: ByteArray? = null
    private var pendingW = 0
    private var pendingH = 0
    private var recycledNv21: ByteArray? = null
    @Volatile
    private var encoderStopped = true

    private val deviceConnectListener = object : USBMonitor.OnDeviceConnectListener {
        override fun onAttach(device: UsbDevice) {
            if (isUvcDevice(device)) {
                Log.i(TAG, "USB UVC attached: ${device.deviceName} (${device.productName})")
                onDevicesChanged()
            }
        }

        override fun onDettach(device: UsbDevice) {
            if (isUvcDevice(device)) {
                Log.i(TAG, "USB UVC detached: ${device.deviceName}")
                val shouldStop = synchronized(lock) {
                    isRunning && targetDeviceName == device.deviceName
                }
                if (shouldStop) {
                    synchronized(lock) {
                        errorMessage = "USB camera disconnected"
                        stage = "disconnected"
                        lock.notifyAll()
                    }
                    stop(preserveDisconnectState = true)
                }
                onDevicesChanged()
            }
        }

        override fun onConnect(
            device: UsbDevice,
            ctrlBlock: USBMonitor.UsbControlBlock,
            createNew: Boolean
        ) {
            val sid: Long
            val matchesTarget: Boolean
            synchronized(lock) {
                sid = currentSessionId
                matchesTarget = isRunning && targetDeviceName == device.deviceName
            }
            if (!matchesTarget) {
                Log.d(TAG, "Ignoring onConnect for ${device.deviceName} (not active target)")
                return
            }

            Thread({
                openAndStreamCamera(sid, device, ctrlBlock)
            }, "SpotrUvcOpen-$sid").apply {
                isDaemon = true
                start()
            }
        }

        override fun onDisconnect(device: UsbDevice, ctrlBlock: USBMonitor.UsbControlBlock) {
            val shouldStop = synchronized(lock) {
                isRunning && targetDeviceName == device.deviceName
            }
            if (shouldStop) {
                Log.i(TAG, "USB UVC disconnected: ${device.deviceName}")
                synchronized(lock) {
                    if (errorMessage == null) errorMessage = "USB camera disconnected"
                    stage = "disconnected"
                }
                stop(preserveDisconnectState = true)
            }
        }

        override fun onCancel(device: UsbDevice) {
            Log.w(TAG, "USB permission denied for ${device.deviceName}")
            synchronized(lock) {
                if (isRunning && targetDeviceName == device.deviceName) {
                    errorMessage = "USB camera permission denied"
                    stage = "permission-denied"
                    isRunning = false
                    lock.notifyAll()
                }
            }
        }
    }

    private val usbMonitor = USBMonitor(appContext, deviceConnectListener)

    fun register() {
        if (usbManager == null) return
        try {
            if (!usbMonitor.isRegistered) {
                usbMonitor.register()
                Log.i(TAG, "USBMonitor registered")
            }
        } catch (e: Exception) {
            Log.w(TAG, "USBMonitor register failed: ${e.message}", e)
        }
    }

    fun destroy() {
        stop()
        try {
            usbMonitor.destroy()
        } catch (e: Exception) {
            Log.w(TAG, "USBMonitor destroy warning: ${e.message}")
        }
    }

    fun isUvcDevice(device: UsbDevice): Boolean {
        if (device.deviceClass == UsbConstants.USB_CLASS_VIDEO) {
            return true
        }
        for (i in 0 until device.interfaceCount) {
            if (device.getInterface(i).interfaceClass == UsbConstants.USB_CLASS_VIDEO) {
                return true
            }
        }
        return false
    }

    fun listUvcCamerasJson(): JSONArray {
        val arr = JSONArray()
        val mgr = usbManager ?: return arr
        val devices = try {
            mgr.deviceList.values
                .filter(::isUvcDevice)
                .sortedBy { it.deviceName }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to enumerate USB devices: ${e.message}")
            emptyList()
        }

        for ((index, device) in devices.withIndex()) {
            val rawProduct = device.productName?.trim().orEmpty()
            val vidPid = String.format("%04X:%04X", device.vendorId, device.productId)
            val label = if (rawProduct.isNotEmpty()) {
                "USB: $rawProduct ($vidPid)"
            } else {
                "USB UVC Camera #${index + 1} ($vidPid)"
            }
            arr.put(JSONObject().apply {
                put("deviceId", "$UVC_DEVICE_ID_PREFIX${device.deviceName}")
                put("deviceName", device.deviceName)
                put("label", label)
                put("vendorId", device.vendorId)
                put("productId", device.productId)
                put("hasPermission", mgr.hasPermission(device))
            })
        }
        return arr
    }

    fun start(requestedDeviceId: String): Long {
        val cleanReq = requestedDeviceId.trim()
        val targetDevice = findTargetDevice(cleanReq)

        synchronized(lock) {
            if (isRunning && targetDevice != null && targetDeviceName == targetDevice.deviceName &&
                latestFrameTimeMs > 0L && (System.currentTimeMillis() - latestFrameTimeMs) < 1500L
            ) {
                return currentSessionId
            }
        }

        stop()

        val sid = sessionSeqGen.incrementAndGet()
        val mgr = usbManager
        if (mgr == null || targetDevice == null) {
            synchronized(lock) {
                currentSessionId = sid
                activeDeviceId = cleanReq
                targetDeviceName = null
                isRunning = false
                stage = "not-found"
                errorMessage = if (mgr == null) {
                    "USB Host service unavailable on this device"
                } else {
                    "USB UVC camera not found ($cleanReq)"
                }
                lock.notifyAll()
            }
            return sid
        }

        synchronized(lock) {
            currentSessionId = sid
            activeDeviceId = "$UVC_DEVICE_ID_PREFIX${targetDevice.deviceName}"
            targetDeviceName = targetDevice.deviceName
            isRunning = true
            stage = if (mgr.hasPermission(targetDevice)) "opening-usb" else "requesting-permission"
            latestJpeg = null
            latestFrameSeq = 0L
            latestFrameTimeMs = 0L
            streamWidth = 0
            streamHeight = 0
            fps = 0.0
            framesCaptured = 0L
            errorMessage = null
            encodePaused = false
            activeClientCount = 0
        }

        register()
        try {
            usbMonitor.requestPermission(targetDevice)
        } catch (e: Exception) {
            synchronized(lock) {
                if (currentSessionId == sid) {
                    isRunning = false
                    stage = "error"
                    errorMessage = "Failed to request USB permission: ${e.message}"
                    lock.notifyAll()
                }
            }
        }

        return sid
    }

    private fun findTargetDevice(requestedDeviceId: String): UsbDevice? {
        val mgr = usbManager ?: return null
        val uvcDevices = try {
            mgr.deviceList.values.filter(::isUvcDevice).sortedBy { it.deviceName }
        } catch (_: Exception) {
            emptyList()
        }
        if (uvcDevices.isEmpty()) return null
        if (requestedDeviceId.isEmpty() || requestedDeviceId == "uvc:auto" || requestedDeviceId == "auto") {
            return uvcDevices.firstOrNull()
        }
        val stripped = if (requestedDeviceId.startsWith(UVC_DEVICE_ID_PREFIX)) {
            requestedDeviceId.removePrefix(UVC_DEVICE_ID_PREFIX)
        } else {
            requestedDeviceId
        }
        // Do NOT silently fall back to a different camera when a specific deviceId was requested
        return uvcDevices.firstOrNull { it.deviceName == stripped }
    }

    private data class PreviewSpec(val width: Int, val height: Int, val format: Int)

    private fun openAndStreamCamera(
        sessionId: Long,
        device: UsbDevice,
        ctrlBlock: USBMonitor.UsbControlBlock
    ) {
        synchronized(cameraOpLock) {
            var cam: UVCCamera? = null
            var reader: ImageReader? = null
            var hThread: HandlerThread? = null

            try {
                synchronized(lock) {
                    if (!isRunning || currentSessionId != sessionId) return
                    stage = "opening-uvc"
                }

                cam = UVCCamera()
                cam.open(ctrlBlock)

                val spec = selectBestPreviewSpec(cam)
                var activeW = spec.width
                var activeH = spec.height
                Log.i(TAG, "Opening UVC ${device.deviceName} at ${activeW}x${activeH} format=${spec.format}")

                try {
                    cam.setPreviewSize(activeW, activeH, spec.format)
                } catch (e: IllegalArgumentException) {
                    Log.w(TAG, "Selected size ${activeW}x${activeH} format=${spec.format} rejected (${e.message}), trying fallback")
                    try {
                        cam.setPreviewSize(activeW, activeH, UVCCamera.FRAME_FORMAT_YUYV)
                    } catch (_: IllegalArgumentException) {
                        activeW = UVCCamera.DEFAULT_PREVIEW_WIDTH
                        activeH = UVCCamera.DEFAULT_PREVIEW_HEIGHT
                        try {
                            cam.setPreviewSize(activeW, activeH, UVCCamera.FRAME_FORMAT_MJPEG)
                        } catch (_: IllegalArgumentException) {
                            cam.setPreviewSize(activeW, activeH, UVCCamera.FRAME_FORMAT_YUYV)
                        }
                    }
                }

                cam.previewSize?.let { actual ->
                    if (actual.width > 0 && actual.height > 0) {
                        activeW = actual.width
                        activeH = actual.height
                    }
                }

                hThread = HandlerThread("SpotrUvcSurface-$sessionId").apply { start() }
                val surfaceHandler = Handler(hThread.looper)
                reader = ImageReader.newInstance(activeW, activeH, PixelFormat.RGBA_8888, 2).apply {
                    setOnImageAvailableListener({ r ->
                        try {
                            r.acquireLatestImage()?.close()
                        } catch (_: Exception) {
                        }
                    }, surfaceHandler)
                }

                val expectedNv21Bytes = activeW * activeH * 3 / 2
                val frameCallback = IFrameCallback { frame ->
                    if (!isRunning || currentSessionId != sessionId || encodePaused) return@IFrameCallback
                    val available = frame.remaining()
                    if (available < expectedNv21Bytes) return@IFrameCallback

                    synchronized(encodeLock) {
                        if (encoderStopped) return@IFrameCallback
                        val buf = recycledNv21?.takeIf { it.size >= expectedNv21Bytes }
                            ?: ByteArray(expectedNv21Bytes)
                        recycledNv21 = null
                        frame.get(buf, 0, expectedNv21Bytes)
                        val oldPending = pendingNv21
                        if (oldPending != null && (recycledNv21 == null || recycledNv21!!.size < oldPending.size)) {
                            recycledNv21 = oldPending
                        }
                        pendingNv21 = buf
                        pendingW = activeW
                        pendingH = activeH
                        encodeLock.notifyAll()
                    }
                }

                synchronized(lock) {
                    if (!isRunning || currentSessionId != sessionId) {
                        runCatching { reader.close() }
                        runCatching { hThread.quitSafely() }
                        runCatching { cam.close() }
                        runCatching { cam.destroy() }
                        return
                    }
                    stage = "starting-preview"
                }

                cam.setPreviewDisplay(reader.surface)
                cam.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21)
                cam.startPreview()

                // Only register active handles and start JPEG encoder thread after startPreview succeeds
                synchronized(lock) {
                    if (!isRunning || currentSessionId != sessionId) {
                        runCatching { cam.setFrameCallback(null, 0) }
                        runCatching { cam.stopPreview() }
                        runCatching { cam.close() }
                        runCatching { cam.destroy() }
                        runCatching { reader.close() }
                        runCatching { hThread.quitSafely() }
                        return
                    }
                    activeCamera = cam
                    activeImageReader = reader
                    surfaceThread = hThread
                    streamWidth = activeW
                    streamHeight = activeH
                    stage = "waiting-first-frame"
                }

                startJpegEncoderThread(sessionId)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start UVC camera ${device.deviceName}: ${e.message}", e)
                stopJpegEncoderThread()
                runCatching { cam?.setFrameCallback(null, 0) }
                runCatching { cam?.stopPreview() }
                runCatching { cam?.close() }
                runCatching { cam?.destroy() }
                runCatching { reader?.close() }
                runCatching { hThread?.quitSafely() }
                synchronized(lock) {
                    if (currentSessionId == sessionId) {
                        isRunning = false
                        stage = "error"
                        errorMessage = e.message ?: "Failed to open USB UVC camera"
                        activeCamera = null
                        activeImageReader = null
                        surfaceThread = null
                        lock.notifyAll()
                    }
                }
            }
        }
    }

    private fun selectBestPreviewSpec(cam: UVCCamera): PreviewSpec {
        val supportedJson = try {
            cam.supportedSize
        } catch (_: Exception) {
            null
        }
        val mjpegSizes = try {
            UVCCamera.getSupportedSize(6, supportedJson) ?: emptyList()
        } catch (_: Exception) {
            emptyList()
        }
        val yuyvSizes = try {
            UVCCamera.getSupportedSize(4, supportedJson) ?: emptyList()
        } catch (_: Exception) {
            emptyList()
        }

        val pickBest: (List<Size>) -> Size? = { list ->
            val capped = list.filter { it.width in 320..1920 && it.height in 240..1080 }
            val pool = if (capped.isNotEmpty()) capped else list
            pool.firstOrNull { it.width == 1920 && it.height == 1080 }
                ?: pool.firstOrNull { it.width == 1280 && it.height == 720 }
                ?: pool.maxByOrNull { it.width * it.height }
        }

        pickBest(mjpegSizes)?.let {
            return PreviewSpec(it.width, it.height, UVCCamera.FRAME_FORMAT_MJPEG)
        }
        pickBest(yuyvSizes)?.let {
            return PreviewSpec(it.width, it.height, UVCCamera.FRAME_FORMAT_YUYV)
        }
        return PreviewSpec(1280, 720, UVCCamera.FRAME_FORMAT_MJPEG)
    }

    private fun startJpegEncoderThread(sessionId: Long) {
        synchronized(encodeLock) {
            encoderStopped = false
            pendingNv21 = null
        }

        val t = Thread({
            val jpegStream = ByteArrayOutputStream(131072)
            var frameCount = 0
            var fpsWindowStartMs = System.currentTimeMillis()

            while (true) {
                val frameTuple: Triple<ByteArray, Int, Int>? = synchronized(encodeLock) {
                    while (!encoderStopped && pendingNv21 == null) {
                        try {
                            encodeLock.wait(200L)
                        } catch (_: InterruptedException) {
                            return@Thread
                        }
                    }
                    if (encoderStopped) return@Thread
                    val buf = pendingNv21
                    pendingNv21 = null
                    if (buf != null) Triple(buf, pendingW, pendingH) else null
                }
                if (frameTuple == null) continue
                val (frameData, w, h) = frameTuple

                try {
                    jpegStream.reset()
                    val yuvImage = YuvImage(frameData, ImageFormat.NV21, w, h, null)
                    if (yuvImage.compressToJpeg(Rect(0, 0, w, h), 80, jpegStream)) {
                        val jpegBytes = jpegStream.toByteArray()
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
                                framesCaptured++
                                latestFrameTimeMs = now
                                stage = "streaming"
                                streamWidth = w
                                streamHeight = h
                                if (updatedFps != null) {
                                    fps = updatedFps
                                }
                                lock.notifyAll()
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "UVC JPEG encode error: ${e.message}")
                } finally {
                    synchronized(encodeLock) {
                        if (recycledNv21 == null || recycledNv21!!.size < frameData.size) {
                            recycledNv21 = frameData
                        }
                    }
                }
            }
        }, "SpotrUvcJpeg-$sessionId").apply {
            isDaemon = true
            start()
        }
        synchronized(lock) {
            encoderThread = t
        }
    }

    private fun stopJpegEncoderThread() {
        val encThreadToJoin: Thread? = synchronized(lock) {
            val t = encoderThread
            encoderThread = null
            t
        }
        synchronized(encodeLock) {
            encoderStopped = true
            pendingNv21 = null
            recycledNv21 = null
            encodeLock.notifyAll()
        }
        if (encThreadToJoin != null && encThreadToJoin.isAlive && Thread.currentThread() !== encThreadToJoin) {
            try {
                encThreadToJoin.join(800L)
            } catch (_: InterruptedException) {
            }
        }
    }

    fun stop(expectedSessionId: Long? = null, preserveDisconnectState: Boolean = false) {
        synchronized(cameraOpLock) {
            val camToClose: UVCCamera?
            val readerToClose: ImageReader?
            val sThreadToQuit: HandlerThread?

            synchronized(lock) {
                if (expectedSessionId != null && expectedSessionId != currentSessionId) {
                    return
                }
                if (!isRunning && activeCamera == null && activeImageReader == null && encoderThread == null) {
                    if (!preserveDisconnectState && expectedSessionId == null) {
                        errorMessage = null
                        stage = "idle"
                    }
                    return
                }
                isRunning = false
                if (!preserveDisconnectState) {
                    stage = "stopped"
                    errorMessage = null
                }
                encodePaused = false
                activeClientCount = 0
                camToClose = activeCamera
                activeCamera = null
                readerToClose = activeImageReader
                activeImageReader = null
                sThreadToQuit = surfaceThread
                surfaceThread = null
                latestJpeg = null
                activeDeviceId = null
                targetDeviceName = null
                lock.notifyAll()
            }

            stopJpegEncoderThread()

            if (camToClose != null) {
                runCatching { camToClose.setFrameCallback(null, 0) }
                    .onFailure { Log.w(TAG, "UVC setFrameCallback(null) notice: ${it.message}") }
                runCatching { camToClose.stopPreview() }
                    .onFailure { Log.w(TAG, "UVC stopPreview notice: ${it.message}") }
                runCatching { camToClose.close() }
                    .onFailure { Log.w(TAG, "UVC close notice: ${it.message}") }
                runCatching { camToClose.destroy() }
                    .onFailure { Log.w(TAG, "UVC destroy notice: ${it.message}") }
            }

            runCatching { readerToClose?.close() }
            runCatching { sThreadToQuit?.quitSafely() }
        }
    }

    fun waitForInitialFrame(sessionId: Long, timeoutMs: Long = 18000L): String? {
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
                    "USB UVC stream stopped before receiving a frame ($stage)"
                } else {
                    "Timed out waiting for USB UVC frame ($stage)"
                }
            }
            return null
        }
    }

    fun setEncodePaused(paused: Boolean) {
        encodePaused = paused
    }

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
                put("isStreaming", isRunning)
                put("stage", stage)
                put("activeDeviceId", activeDeviceId ?: JSONObject.NULL)
                put("framesDecoded", framesCaptured)
                put("width", streamWidth)
                put("height", streamHeight)
                put("fps", (fps * 10.0).roundToInt() / 10.0)
                put("lastFrameSecAgo", secAgo)
                put("error", errorMessage ?: JSONObject.NULL)
            }
        }
    }
}
