package com.spotr.tactical

import java.io.ByteArrayOutputStream

/**
 * Decodes RTP packets into Annex-B NAL units (for H.264 / H.265) or complete JPEG frames (RFC 2435).
 */
class RtpVideoDepacketizer(private val codecType: VideoCodec) {

    enum class VideoCodec {
        H264,
        H265,
        JPEG
    }

    data class EmittedUnit(
        val data: ByteArray,
        val isConfig: Boolean,
        val isKeyFrame: Boolean,
        val isCompleteJpeg: Boolean = false
    )

    private var lastSeq = -1
    private val fuBuffer = ByteArrayOutputStream(65536)
    private var fuActive = false
    private var fuIsConfig = false
    private var fuIsKeyFrame = false

    // RFC 2435 MJPEG-over-RTP state
    private val jpegFragBuffer = ByteArrayOutputStream(131072)
    private var jpegFragTimestamp = -1L
    private var jpegWidth = 0
    private var jpegHeight = 0
    private var jpegType = 0
    private var jpegQ = 0
    private var jpegLastOffset = 0
    private var jpegQuantTables: ByteArray? = null

    fun reset() {
        lastSeq = -1
        fuBuffer.reset()
        fuActive = false
        jpegFragBuffer.reset()
        jpegFragTimestamp = -1L
    }

    fun processRtpPacket(packet: ByteArray, length: Int): List<EmittedUnit> {
        if (length < 12) return emptyList()

        val b0 = packet[0].toInt() and 0xFF
        val version = (b0 ushr 6) and 0x03
        if (version != 2) return emptyList()

        val hasPadding = (b0 and 0x20) != 0
        val hasExtension = (b0 and 0x10) != 0
        val csrcCount = b0 and 0x0F

        val b1 = packet[1].toInt() and 0xFF
        val marker = (b1 and 0x80) != 0
        val seq = ((packet[2].toInt() and 0xFF) shl 8) or (packet[3].toInt() and 0xFF)
        val timestamp = ((packet[4].toLong() and 0xFF) shl 24) or
            ((packet[5].toLong() and 0xFF) shl 16) or
            ((packet[6].toLong() and 0xFF) shl 8) or
            (packet[7].toLong() and 0xFF)

        var offset = 12 + csrcCount * 4
        if (offset >= length) return emptyList()

        if (hasExtension) {
            if (offset + 4 > length) return emptyList()
            val extWords = ((packet[offset + 2].toInt() and 0xFF) shl 8) or
                (packet[offset + 3].toInt() and 0xFF)
            offset += 4 + extWords * 4
            if (offset >= length) return emptyList()
        }

        var end = length
        if (hasPadding) {
            val padLen = packet[length - 1].toInt() and 0xFF
            if (padLen in 1..(end - offset)) {
                end -= padLen
            }
        }
        if (offset >= end) return emptyList()

        // Detect sequence discontinuity to discard incomplete fragmented NALs
        if (lastSeq != -1 && ((lastSeq + 1) and 0xFFFF) != seq) {
            if (fuActive) {
                fuBuffer.reset()
                fuActive = false
            }
        }
        lastSeq = seq

        return when (codecType) {
            VideoCodec.H264 -> parseH264(packet, offset, end)
            VideoCodec.H265 -> parseH265(packet, offset, end)
            VideoCodec.JPEG -> parseMjpegRtp(packet, offset, end, timestamp, marker)
        }
    }

    private fun parseH264(data: ByteArray, offset: Int, end: Int): List<EmittedUnit> {
        val nalHeader = data[offset].toInt() and 0xFF
        val nalType = nalHeader and 0x1F

        return when (nalType) {
            in 1..23 -> {
                // Single NAL unit packet
                fuActive = false
                fuBuffer.reset()
                val out = ByteArray(4 + (end - offset))
                writeAnnexBStartCode(out, 0)
                System.arraycopy(data, offset, out, 4, end - offset)
                listOf(
                    EmittedUnit(
                        data = out,
                        isConfig = (nalType == 7 || nalType == 8),
                        isKeyFrame = (nalType == 5)
                    )
                )
            }

            24 -> {
                // STAP-A aggregation packet
                fuActive = false
                fuBuffer.reset()
                val results = mutableListOf<EmittedUnit>()
                var pos = offset + 1
                while (pos + 2 <= end) {
                    val naluSize = ((data[pos].toInt() and 0xFF) shl 8) or (data[pos + 1].toInt() and 0xFF)
                    pos += 2
                    if (naluSize <= 0 || pos + naluSize > end) break
                    val innerType = data[pos].toInt() and 0x1F
                    val out = ByteArray(4 + naluSize)
                    writeAnnexBStartCode(out, 0)
                    System.arraycopy(data, pos, out, 4, naluSize)
                    results.add(
                        EmittedUnit(
                            data = out,
                            isConfig = (innerType == 7 || innerType == 8),
                            isKeyFrame = (innerType == 5)
                        )
                    )
                    pos += naluSize
                }
                results
            }

            28 -> {
                // FU-A fragmentation unit
                if (end - offset < 2) return emptyList()
                val fuIndicator = data[offset].toInt() and 0xFF
                val fuHeader = data[offset + 1].toInt() and 0xFF
                val isStart = (fuHeader and 0x80) != 0
                val isEnd = (fuHeader and 0x40) != 0
                val innerNalType = fuHeader and 0x1F

                if (isStart) {
                    fuBuffer.reset()
                    fuBuffer.write(0x00)
                    fuBuffer.write(0x00)
                    fuBuffer.write(0x00)
                    fuBuffer.write(0x01)
                    val reconstructedNalHeader = (fuIndicator and 0xE0) or innerNalType
                    fuBuffer.write(reconstructedNalHeader)
                    fuBuffer.write(data, offset + 2, end - (offset + 2))
                    fuActive = true
                    fuIsConfig = (innerNalType == 7 || innerNalType == 8)
                    fuIsKeyFrame = (innerNalType == 5)
                } else if (fuActive) {
                    fuBuffer.write(data, offset + 2, end - (offset + 2))
                } else {
                    return emptyList()
                }

                if (isEnd && fuActive) {
                    val assembled = fuBuffer.toByteArray()
                    val cfg = fuIsConfig
                    val key = fuIsKeyFrame
                    fuBuffer.reset()
                    fuActive = false
                    listOf(EmittedUnit(data = assembled, isConfig = cfg, isKeyFrame = key))
                } else {
                    emptyList()
                }
            }

            else -> emptyList()
        }
    }

    private fun parseH265(data: ByteArray, offset: Int, end: Int): List<EmittedUnit> {
        if (end - offset < 2) return emptyList()
        val nalHeader0 = data[offset].toInt() and 0xFF
        val nalType = (nalHeader0 ushr 1) and 0x3F

        return when {
            nalType < 48 -> {
                fuActive = false
                fuBuffer.reset()
                val out = ByteArray(4 + (end - offset))
                writeAnnexBStartCode(out, 0)
                System.arraycopy(data, offset, out, 4, end - offset)
                listOf(
                    EmittedUnit(
                        data = out,
                        isConfig = (nalType == 32 || nalType == 33 || nalType == 34),
                        isKeyFrame = (nalType in 16..21)
                    )
                )
            }

            nalType == 48 -> {
                // AP aggregation packet
                fuActive = false
                fuBuffer.reset()
                val results = mutableListOf<EmittedUnit>()
                var pos = offset + 2
                while (pos + 2 <= end) {
                    val naluSize = ((data[pos].toInt() and 0xFF) shl 8) or (data[pos + 1].toInt() and 0xFF)
                    pos += 2
                    if (naluSize <= 0 || pos + naluSize > end) break
                    val innerType = ((data[pos].toInt() and 0xFF) ushr 1) and 0x3F
                    val out = ByteArray(4 + naluSize)
                    writeAnnexBStartCode(out, 0)
                    System.arraycopy(data, pos, out, 4, naluSize)
                    results.add(
                        EmittedUnit(
                            data = out,
                            isConfig = (innerType == 32 || innerType == 33 || innerType == 34),
                            isKeyFrame = (innerType in 16..21)
                        )
                    )
                    pos += naluSize
                }
                results
            }

            nalType == 49 -> {
                // FU fragmentation unit (2-byte PayloadHdr + 1-byte FU header)
                if (end - offset < 3) return emptyList()
                val nalHeader1 = data[offset + 1].toInt() and 0xFF
                val fuHeader = data[offset + 2].toInt() and 0xFF
                val isStart = (fuHeader and 0x80) != 0
                val isEnd = (fuHeader and 0x40) != 0
                val innerType = fuHeader and 0x3F

                if (isStart) {
                    fuBuffer.reset()
                    fuBuffer.write(0x00)
                    fuBuffer.write(0x00)
                    fuBuffer.write(0x00)
                    fuBuffer.write(0x01)
                    val reconstructedByte0 = (nalHeader0 and 0x81) or (innerType shl 1)
                    fuBuffer.write(reconstructedByte0)
                    fuBuffer.write(nalHeader1)
                    fuBuffer.write(data, offset + 3, end - (offset + 3))
                    fuActive = true
                    fuIsConfig = (innerType == 32 || innerType == 33 || innerType == 34)
                    fuIsKeyFrame = (innerType in 16..21)
                } else if (fuActive) {
                    fuBuffer.write(data, offset + 3, end - (offset + 3))
                } else {
                    return emptyList()
                }

                if (isEnd && fuActive) {
                    val assembled = fuBuffer.toByteArray()
                    val cfg = fuIsConfig
                    val key = fuIsKeyFrame
                    fuBuffer.reset()
                    fuActive = false
                    listOf(EmittedUnit(data = assembled, isConfig = cfg, isKeyFrame = key))
                } else {
                    emptyList()
                }
            }

            else -> emptyList()
        }
    }

    private fun parseMjpegRtp(
        data: ByteArray,
        offset: Int,
        end: Int,
        timestamp: Long,
        marker: Boolean
    ): List<EmittedUnit> {
        if (end - offset < 8) return emptyList()

        val fragOffset = ((data[offset + 1].toInt() and 0xFF) shl 16) or
            ((data[offset + 2].toInt() and 0xFF) shl 8) or
            (data[offset + 3].toInt() and 0xFF)
        val type = data[offset + 4].toInt() and 0xFF
        val q = data[offset + 5].toInt() and 0xFF
        val w = (data[offset + 6].toInt() and 0xFF) * 8
        val h = (data[offset + 7].toInt() and 0xFF) * 8

        var pos = offset + 8

        // Restart Marker Header (types 64..127)
        if (type in 64..127) {
            if (pos + 4 > end) return emptyList()
            pos += 4
        }

        if (fragOffset == 0) {
            jpegFragBuffer.reset()
            jpegFragTimestamp = timestamp
            jpegWidth = w
            jpegHeight = h
            jpegType = type
            jpegQ = q
            jpegLastOffset = 0
            jpegQuantTables = null

            if (q >= 128) {
                if (pos + 4 > end) return emptyList()
                val qtLen = ((data[pos + 2].toInt() and 0xFF) shl 8) or (data[pos + 3].toInt() and 0xFF)
                pos += 4
                if (pos + qtLen > end) return emptyList()
                jpegQuantTables = data.copyOfRange(pos, pos + qtLen)
                pos += qtLen
            }
        } else if (timestamp != jpegFragTimestamp || fragOffset != jpegLastOffset) {
            // Packet loss or out-of-order fragment
            jpegFragBuffer.reset()
            jpegFragTimestamp = -1L
            return emptyList()
        }

        if (pos > end) return emptyList()
        val payloadLen = end - pos
        jpegFragBuffer.write(data, pos, payloadLen)
        jpegLastOffset += payloadLen

        if (!marker) return emptyList()

        val rawPayload = jpegFragBuffer.toByteArray()
        jpegFragBuffer.reset()
        jpegFragTimestamp = -1L

        // If the camera already includes SOI (0xFF 0xD8), return directly
        val jpegBytes = if (rawPayload.size >= 2 &&
            (rawPayload[0].toInt() and 0xFF) == 0xFF &&
            (rawPayload[1].toInt() and 0xFF) == 0xD8
        ) {
            rawPayload
        } else {
            // Minimal RFC 2435 JPEG frame reconstruction is uncommon when camera sends SOI;
            // skip incomplete synthetic frames unless SOI is present
            return emptyList()
        }

        return listOf(
            EmittedUnit(
                data = jpegBytes,
                isConfig = false,
                isKeyFrame = true,
                isCompleteJpeg = true
            )
        )
    }

    companion object {
        private fun writeAnnexBStartCode(dst: ByteArray, index: Int) {
            dst[index] = 0x00
            dst[index + 1] = 0x00
            dst[index + 2] = 0x00
            dst[index + 3] = 0x01
        }
    }
}
