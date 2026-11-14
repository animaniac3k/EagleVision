package com.spotr.tactical

import android.util.Base64
import android.util.Log
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.MessageDigest
import java.util.Locale

/**
 * Lightweight, low-latency RTSP client supporting TCP interleaved RTP (RFC 2326),
 * automatic UDP RTP fallback, Basic/Digest authentication, and SDP H.264/H.265/JPEG parsing.
 */
class RtspClient(
    private val rawUrl: String,
    private val preferTcp: Boolean = true
) {
    companion object {
        private const val TAG = "RtspClient"
        private const val CONNECT_TIMEOUT_MS = 3500
        private const val READ_TIMEOUT_MS = 4000
    }

    data class SdpVideoTrack(
        val controlUrl: String,
        val payloadType: Int,
        val codec: RtpVideoDepacketizer.VideoCodec,
        val initialConfigBytes: ByteArray?
    )

    private data class RtspResponse(
        val statusCode: Int,
        val statusMessage: String,
        val headers: Map<String, String>,
        val body: String
    )

    private var socket: Socket? = null
    private var udpSocket: DatagramSocket? = null
    private var input: DataInputStream? = null
    private var output: OutputStream? = null
    private val outputLock = Any()

    @Volatile
    private var stopped = false

    private var cseq = 1
    private var sessionId: String? = null
    private var sessionTimeoutSec = 60
    private var username: String? = null
    private var password: String? = null
    private var authRealm: String? = null
    private var authNonce: String? = null
    private var authUseDigest = false

    private lateinit var cleanUrl: String
    private lateinit var host: String
    private var port = 554

    fun stream(
        onTrackReady: (SdpVideoTrack) -> Unit,
        onRtpPacket: (packet: ByteArray, length: Int) -> Unit
    ) {
        parseUrl()

        val sock = Socket()
        socket = sock
        sock.tcpNoDelay = true
        sock.soTimeout = READ_TIMEOUT_MS
        sock.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)

        input = DataInputStream(BufferedInputStream(sock.getInputStream(), 65536))
        output = sock.getOutputStream()

        // 1. OPTIONS
        sendRequestWithAuth("OPTIONS", cleanUrl, emptyMap())

        // 2. DESCRIBE
        val descResp = sendRequestWithAuth(
            "DESCRIBE",
            cleanUrl,
            mapOf("Accept" to "application/sdp")
        )
        if (descResp.statusCode !in 200..299) {
            throw IllegalStateException("RTSP DESCRIBE failed: ${descResp.statusCode} ${descResp.statusMessage}")
        }

        val contentBase = descResp.headers["content-base"]
            ?: descResp.headers["content-location"]
            ?: cleanUrl
        val track = parseSdpVideoTrack(descResp.body, contentBase)
            ?: throw IllegalStateException("No supported video track (H264/H265/JPEG) found in SDP")

        // 3. SETUP (TCP interleaved preferred, UDP fallback on 461)
        var usingTcp = preferTcp
        var rtpChannel = 0
        var setupResp = if (usingTcp) {
            sendRequestWithAuth(
                "SETUP",
                track.controlUrl,
                mapOf("Transport" to "RTP/AVP/TCP;unicast;interleaved=0-1")
            )
        } else {
            null
        }

        if (setupResp == null || setupResp.statusCode == 461) {
            usingTcp = false
            val udp = DatagramSocket(0).apply {
                soTimeout = READ_TIMEOUT_MS
                receiveBufferSize = 512 * 1024
            }
            udpSocket = udp
            val rtpPort = udp.localPort
            setupResp = sendRequestWithAuth(
                "SETUP",
                track.controlUrl,
                mapOf("Transport" to "RTP/AVP;unicast;client_port=$rtpPort-${rtpPort + 1}")
            )
        }

        if (setupResp.statusCode !in 200..299) {
            throw IllegalStateException("RTSP SETUP failed: ${setupResp.statusCode} ${setupResp.statusMessage}")
        }

        parseSessionHeader(setupResp.headers["session"])
        if (usingTcp) {
            rtpChannel = parseInterleavedChannel(setupResp.headers["transport"]) ?: 0
        }

        onTrackReady(track)

        // 4. PLAY
        val playHeaders = mutableMapOf("Range" to "npt=0.000-")
        sessionId?.let { playHeaders["Session"] = it }
        val playResp = sendRequestWithAuth("PLAY", contentBase.trimEnd('/'), playHeaders)
        if (playResp.statusCode !in 200..299) {
            // Some cameras prefer track.controlUrl for PLAY instead of contentBase
            val retryResp = sendRequestWithAuth("PLAY", track.controlUrl, playHeaders)
            if (retryResp.statusCode !in 200..299) {
                throw IllegalStateException("RTSP PLAY failed: ${playResp.statusCode} ${playResp.statusMessage}")
            }
        }

        Log.i(TAG, "RTSP playing $cleanUrl (codec=${track.codec}, tcp=$usingTcp)")

        // 5. Read RTP stream + periodic keepalive
        val keepaliveIntervalMs = (sessionTimeoutSec * 500L).coerceIn(10_000L, 25_000L)
        var lastKeepaliveMs = System.currentTimeMillis()

        if (usingTcp) {
            val inp = input!!
            var packetBuf = ByteArray(65536)
            while (!stopped) {
                val now = System.currentTimeMillis()
                if (now - lastKeepaliveMs >= keepaliveIntervalMs && sessionId != null) {
                    lastKeepaliveMs = now
                    sendKeepaliveAsync()
                }

                val firstByte = inp.read()
                if (firstByte < 0) break

                if (firstByte == 0x24) {
                    // Interleaved RTP/RTCP frame: '$' <channel> <2-byte length> <payload>
                    val channel = inp.read()
                    val hi = inp.read()
                    val lo = inp.read()
                    if (channel < 0 || hi < 0 || lo < 0) break
                    val len = (hi shl 8) or lo
                    if (len > packetBuf.size) {
                        packetBuf = ByteArray(len)
                    }
                    inp.readFully(packetBuf, 0, len)
                    if (channel == rtpChannel) {
                        onRtpPacket(packetBuf, len)
                    }
                } else {
                    // Consume interleaved RTSP response/text lines (e.g. keepalive 200 OK)
                    consumeInlineRtspMessage(firstByte, inp)
                }
            }
        } else {
            val udp = udpSocket!!
            val buf = ByteArray(65536)
            val dp = DatagramPacket(buf, buf.size)
            while (!stopped) {
                val now = System.currentTimeMillis()
                if (now - lastKeepaliveMs >= keepaliveIntervalMs && sessionId != null) {
                    lastKeepaliveMs = now
                    sendKeepaliveAsync()
                }
                udp.receive(dp)
                if (dp.length > 0) {
                    onRtpPacket(dp.data, dp.length)
                }
            }
        }
    }

    private fun consumeInlineRtspMessage(firstByte: Int, inp: DataInputStream) {
        if (firstByte != 'R'.code) return
        val firstLine = readAsciiLine(firstByte, inp)
        if (!firstLine.startsWith("RTSP/", ignoreCase = true)) {
            return
        }
        var contentLength = 0
        while (!stopped) {
            val b = inp.read()
            if (b < 0) break
            val line = readAsciiLine(b, inp)
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon > 0) {
                val name = line.substring(0, colon).trim().lowercase(Locale.US)
                if (name == "content-length") {
                    contentLength = line.substring(colon + 1).trim().toIntOrNull() ?: 0
                }
            }
        }
        if (contentLength > 0) {
            val skipBuf = ByteArray(contentLength)
            inp.readFully(skipBuf)
        }
    }

    private fun sendKeepaliveAsync() {
        val sid = sessionId ?: return
        Thread {
            if (stopped) return@Thread
            try {
                sendRequestRaw("OPTIONS", cleanUrl, mapOf("Session" to sid), readResponse = false)
            } catch (_: Exception) {
            }
        }.apply {
            isDaemon = true
            start()
        }
    }

    private fun sendRequestWithAuth(
        method: String,
        url: String,
        extraHeaders: Map<String, String>
    ): RtspResponse {
        val headers = extraHeaders.toMutableMap()
        sessionId?.let { headers.putIfAbsent("Session", it) }
        buildAuthHeader(method, url)?.let { headers["Authorization"] = it }

        var resp = sendRequestRaw(method, url, headers, readResponse = true)!!
        if (resp.statusCode == 401 && !username.isNullOrEmpty()) {
            parseWwwAuthenticate(resp.headers["www-authenticate"])
            val retryHeaders = extraHeaders.toMutableMap()
            sessionId?.let { retryHeaders.putIfAbsent("Session", it) }
            buildAuthHeader(method, url)?.let { retryHeaders["Authorization"] = it }
            resp = sendRequestRaw(method, url, retryHeaders, readResponse = true)!!
        }
        return resp
    }

    private fun sendRequestRaw(
        method: String,
        url: String,
        headers: Map<String, String>,
        readResponse: Boolean
    ): RtspResponse? {
        val sb = StringBuilder()
        val seq = synchronized(outputLock) {
            val s = cseq++
            sb.append("$method $url RTSP/1.0\r\n")
            sb.append("CSeq: $s\r\n")
            sb.append("User-Agent: SPOTR-Android/1.0\r\n")
            for ((k, v) in headers) {
                sb.append("$k: $v\r\n")
            }
            sb.append("\r\n")
            val out = output ?: throw IllegalStateException("RTSP output stream closed")
            out.write(sb.toString().toByteArray(Charsets.US_ASCII))
            out.flush()
            s
        }
        if (!readResponse) return null
        return readRtspResponse(seq)
    }

    private fun readRtspResponse(@Suppress("UNUSED_PARAMETER") expectedCseq: Int): RtspResponse {
        val inp = input ?: throw EOFException("RTSP input closed")
        var statusLine: String
        while (true) {
            val b = inp.read()
            if (b < 0) throw EOFException("Unexpected EOF waiting for RTSP response")
            if (b == '\r'.code || b == '\n'.code) continue
            statusLine = readAsciiLine(b, inp)
            if (statusLine.startsWith("RTSP/", ignoreCase = true)) break
        }

        val parts = statusLine.split(' ', limit = 3)
        val statusCode = parts.getOrNull(1)?.toIntOrNull() ?: 500
        val statusMsg = parts.getOrNull(2) ?: ""

        val headers = mutableMapOf<String, String>()
        while (true) {
            val b = inp.read()
            if (b < 0) break
            val line = readAsciiLine(b, inp)
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon > 0) {
                val name = line.substring(0, colon).trim().lowercase(Locale.US)
                val value = line.substring(colon + 1).trim()
                headers[name] = value
            }
        }

        val contentLen = headers["content-length"]?.toIntOrNull() ?: 0
        val body = if (contentLen > 0) {
            val bytes = ByteArray(contentLen)
            inp.readFully(bytes)
            String(bytes, Charsets.UTF_8)
        } else {
            ""
        }

        return RtspResponse(statusCode, statusMsg, headers, body)
    }

    private fun readAsciiLine(firstByte: Int, inp: DataInputStream): String {
        val baos = ByteArrayOutputStream(128)
        if (firstByte != '\r'.code && firstByte != '\n'.code) {
            baos.write(firstByte)
        } else if (firstByte == '\n'.code) {
            return ""
        }
        while (true) {
            val b = inp.read()
            if (b < 0 || b == '\n'.code) break
            if (b != '\r'.code) baos.write(b)
        }
        return String(baos.toByteArray(), Charsets.US_ASCII)
    }

    private fun parseUrl() {
        val uri = URI(rawUrl.trim())
        host = uri.host ?: throw IllegalArgumentException("Invalid RTSP URL host: $rawUrl")
        port = if (uri.port > 0) uri.port else 554

        val userInfo = uri.userInfo
        if (!userInfo.isNullOrEmpty()) {
            val idx = userInfo.indexOf(':')
            if (idx >= 0) {
                username = userInfo.substring(0, idx)
                password = userInfo.substring(idx + 1)
            } else {
                username = userInfo
                password = ""
            }
        }

        val rawPath = buildString {
            append(if (uri.rawPath.isNullOrEmpty()) "/" else uri.rawPath)
            if (!uri.rawQuery.isNullOrEmpty()) {
                append("?").append(uri.rawQuery)
            }
        }
        val portPart = if (uri.port > 0) ":${uri.port}" else ""
        cleanUrl = "rtsp://$host$portPart$rawPath"
    }

    private fun parseWwwAuthenticate(header: String?) {
        if (header.isNullOrBlank()) return
        if (header.startsWith("Digest", ignoreCase = true)) {
            authUseDigest = true
            authRealm = extractQuotedParam(header, "realm")
            authNonce = extractQuotedParam(header, "nonce")
        } else if (header.startsWith("Basic", ignoreCase = true)) {
            authUseDigest = false
            authRealm = extractQuotedParam(header, "realm")
        }
    }

    private fun buildAuthHeader(method: String, url: String): String? {
        val user = username ?: return null
        val pass = password ?: ""
        if (authUseDigest && authRealm != null && authNonce != null) {
            val ha1 = md5Hex("$user:$authRealm:$pass")
            val ha2 = md5Hex("$method:$url")
            val response = md5Hex("$ha1:$authNonce:$ha2")
            return "Digest username=\"$user\", realm=\"$authRealm\", nonce=\"$authNonce\", uri=\"$url\", response=\"$response\""
        }
        if (authRealm != null) {
            val encoded = Base64.encodeToString("$user:$pass".toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
            return "Basic $encoded"
        }
        return null
    }

    private fun parseSessionHeader(sessionHeader: String?) {
        if (sessionHeader.isNullOrBlank()) return
        val parts = sessionHeader.split(';')
        sessionId = parts[0].trim()
        for (i in 1 until parts.size) {
            val p = parts[i].trim()
            if (p.startsWith("timeout=", ignoreCase = true)) {
                sessionTimeoutSec = p.substringAfter('=').trim().toIntOrNull()?.coerceAtLeast(10) ?: 60
            }
        }
    }

    private fun parseInterleavedChannel(transportHeader: String?): Int? {
        if (transportHeader.isNullOrBlank()) return null
        val match = Regex("interleaved=(\\d+)", RegexOption.IGNORE_CASE).find(transportHeader)
        return match?.groupValues?.getOrNull(1)?.toIntOrNull()
    }

    private fun parseSdpVideoTrack(sdp: String, contentBase: String): SdpVideoTrack? {
        val lines = sdp.lines().map { it.trim() }.filter { it.isNotEmpty() }
        var inVideoSection = false
        var videoControl: String? = null
        val rtpmap = mutableMapOf<Int, RtpVideoDepacketizer.VideoCodec>()
        val fmtpMap = mutableMapOf<Int, String>()
        val payloadOrder = mutableListOf<Int>()

        for (line in lines) {
            if (line.startsWith("m=")) {
                if (inVideoSection && rtpmap.isNotEmpty()) break
                inVideoSection = line.startsWith("m=video ")
                if (inVideoSection) {
                    val tokens = line.split(Regex("\\s+"))
                    for (i in 3 until tokens.size) {
                        tokens[i].toIntOrNull()?.let { pt ->
                            payloadOrder.add(pt)
                            if (pt == 26) {
                                rtpmap[pt] = RtpVideoDepacketizer.VideoCodec.JPEG
                            }
                        }
                    }
                }
                continue
            }

            if (!inVideoSection) continue

            when {
                line.startsWith("a=control:") -> {
                    videoControl = line.substringAfter("a=control:").trim()
                }
                line.startsWith("a=rtpmap:") -> {
                    val rest = line.substringAfter("a=rtpmap:").trim()
                    val spaceIdx = rest.indexOf(' ')
                    if (spaceIdx > 0) {
                        val pt = rest.substring(0, spaceIdx).trim().toIntOrNull()
                        val codecName = rest.substring(spaceIdx + 1).substringBefore('/').trim()
                            .uppercase(Locale.US)
                        if (pt != null) {
                            when (codecName) {
                                "H264" -> rtpmap[pt] = RtpVideoDepacketizer.VideoCodec.H264
                                "H265", "HEVC" -> rtpmap[pt] = RtpVideoDepacketizer.VideoCodec.H265
                                "JPEG" -> rtpmap[pt] = RtpVideoDepacketizer.VideoCodec.JPEG
                            }
                        }
                    }
                }
                line.startsWith("a=fmtp:") -> {
                    val rest = line.substringAfter("a=fmtp:").trim()
                    val spaceIdx = rest.indexOf(' ')
                    if (spaceIdx > 0) {
                        val pt = rest.substring(0, spaceIdx).trim().toIntOrNull()
                        if (pt != null) {
                            fmtpMap[pt] = rest.substring(spaceIdx + 1).trim()
                        }
                    }
                }
            }
        }

        val chosenPt = payloadOrder.firstOrNull { rtpmap.containsKey(it) }
            ?: rtpmap.keys.firstOrNull()
            ?: return null
        val codec = rtpmap[chosenPt] ?: return null
        val controlUrl = resolveControlUrl(videoControl, contentBase)
        val configBytes = extractConfigBytes(codec, fmtpMap[chosenPt])

        return SdpVideoTrack(
            controlUrl = controlUrl,
            payloadType = chosenPt,
            codec = codec,
            initialConfigBytes = configBytes
        )
    }

    private fun resolveControlUrl(control: String?, contentBase: String): String {
        val base = contentBase.trim()
        if (control.isNullOrBlank() || control == "*") return base.trimEnd('/')
        if (control.startsWith("rtsp://", ignoreCase = true)) return control
        if (control.startsWith("/")) {
            val portPart = if (port != 554) ":$port" else ""
            return "rtsp://$host$portPart$control"
        }
        return "${base.trimEnd('/')}/$control"
    }

    private fun extractConfigBytes(
        codec: RtpVideoDepacketizer.VideoCodec,
        fmtp: String?
    ): ByteArray? {
        if (fmtp.isNullOrBlank()) return null
        val out = ByteArrayOutputStream()

        fun appendB64Nals(csv: String?) {
            if (csv.isNullOrBlank()) return
            for (item in csv.split(',')) {
                val trimmed = item.trim()
                if (trimmed.isEmpty()) continue
                try {
                    val decoded = Base64.decode(trimmed, Base64.DEFAULT)
                    if (decoded.isNotEmpty()) {
                        out.write(0x00)
                        out.write(0x00)
                        out.write(0x00)
                        out.write(0x01)
                        out.write(decoded)
                    }
                } catch (_: Exception) {
                }
            }
        }

        when (codec) {
            RtpVideoDepacketizer.VideoCodec.H264 -> {
                val match = Regex("sprop-parameter-sets=([^;\\s]+)", RegexOption.IGNORE_CASE).find(fmtp)
                appendB64Nals(match?.groupValues?.getOrNull(1))
            }
            RtpVideoDepacketizer.VideoCodec.H265 -> {
                for (key in listOf("sprop-vps", "sprop-sps", "sprop-pps")) {
                    val match = Regex("$key=([^;\\s]+)", RegexOption.IGNORE_CASE).find(fmtp)
                    appendB64Nals(match?.groupValues?.getOrNull(1))
                }
            }
            RtpVideoDepacketizer.VideoCodec.JPEG -> Unit
        }

        val bytes = out.toByteArray()
        return if (bytes.isNotEmpty()) bytes else null
    }

    private fun extractQuotedParam(header: String, key: String): String? {
        val quoted = Regex("$key=\"([^\"]*)\"", RegexOption.IGNORE_CASE).find(header)
        if (quoted != null) return quoted.groupValues[1]
        val unquoted = Regex("$key=([^,\\s]+)", RegexOption.IGNORE_CASE).find(header)
        return unquoted?.groupValues?.getOrNull(1)
    }

    private fun md5Hex(input: String): String {
        val digest = MessageDigest.getInstance("MD5").digest(input.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun close() {
        stopped = true
        val sid = sessionId
        if (sid != null && socket != null && !socket!!.isClosed) {
            try {
                sendRequestRaw("TEARDOWN", cleanUrl, mapOf("Session" to sid), readResponse = false)
            } catch (_: Exception) {
            }
        }
        try {
            socket?.close()
        } catch (_: Exception) {
        }
        try {
            udpSocket?.close()
        } catch (_: Exception) {
        }
        socket = null
        udpSocket = null
        input = null
        output = null
    }
}
