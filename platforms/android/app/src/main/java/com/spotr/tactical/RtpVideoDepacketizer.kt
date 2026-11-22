package com.spotr.tactical

import java.io.ByteArrayOutputStream

/**
 * Decodes RTP packets into Annex-B NAL units (for H.264 / H.265) or complete JPEG frames (RFC 2435).
 */
class RtpVideoDepacketizer(
    private val codecType: VideoCodec,
    private val expectedPayloadType: Int = -1
) {

    enum class VideoCodec {
        H264,
        H265,
        JPEG
    }

    data class EmittedUnit(
        val data: ByteArray,
        val isConfig: Boolean,
        val isKeyFrame: Boolean,
        val isCompleteJpeg: Boolean = false,
        val width: Int = 0,
        val height: Int = 0
    )

    private var lastSeq = -1
    private val fuBuffer = ByteArrayOutputStream(65536)
    private var fuActive = false
    private var fuTimestamp = -1L
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
        fuTimestamp = -1L
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
        val payloadType = b1 and 0x7F
        if (expectedPayloadType >= 0 && payloadType != expectedPayloadType) {
            return emptyList()
        }

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
                fuTimestamp = -1L
            }
        }
        lastSeq = seq

        return when (codecType) {
            VideoCodec.H264 -> parseH264(packet, offset, end, timestamp)
            VideoCodec.H265 -> parseH265(packet, offset, end, timestamp)
            VideoCodec.JPEG -> parseMjpegRtp(packet, offset, end, timestamp, marker)
        }
    }

    private fun parseH264(data: ByteArray, offset: Int, end: Int, timestamp: Long): List<EmittedUnit> {
        val nalHeader = data[offset].toInt() and 0xFF
        val nalType = nalHeader and 0x1F

        return when (nalType) {
            in 1..23 -> {
                // Single NAL unit packet
                fuActive = false
                fuTimestamp = -1L
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
                fuTimestamp = -1L
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
                val payloadLen = end - (offset + 2)

                if (isStart) {
                    fuBuffer.reset()
                    fuBuffer.write(0x00)
                    fuBuffer.write(0x00)
                    fuBuffer.write(0x00)
                    fuBuffer.write(0x01)
                    val reconstructedNalHeader = (fuIndicator and 0xE0) or innerNalType
                    fuBuffer.write(reconstructedNalHeader)
                    fuBuffer.write(data, offset + 2, payloadLen)
                    fuActive = true
                    fuTimestamp = timestamp
                    fuIsConfig = (innerNalType == 7 || innerNalType == 8)
                    fuIsKeyFrame = (innerNalType == 5)
                } else if (fuActive && fuTimestamp == timestamp) {
                    if (fuBuffer.size() + payloadLen > MAX_NALU_BYTES) {
                        fuBuffer.reset()
                        fuActive = false
                        fuTimestamp = -1L
                        return emptyList()
                    }
                    fuBuffer.write(data, offset + 2, payloadLen)
                } else {
                    fuBuffer.reset()
                    fuActive = false
                    fuTimestamp = -1L
                    return emptyList()
                }

                if (isEnd && fuActive) {
                    val assembled = fuBuffer.toByteArray()
                    val cfg = fuIsConfig
                    val key = fuIsKeyFrame
                    fuBuffer.reset()
                    fuActive = false
                    fuTimestamp = -1L
                    listOf(EmittedUnit(data = assembled, isConfig = cfg, isKeyFrame = key))
                } else {
                    emptyList()
                }
            }

            else -> emptyList()
        }
    }

    private fun parseH265(data: ByteArray, offset: Int, end: Int, timestamp: Long): List<EmittedUnit> {
        if (end - offset < 2) return emptyList()
        val nalHeader0 = data[offset].toInt() and 0xFF
        val nalType = (nalHeader0 ushr 1) and 0x3F

        return when {
            nalType < 48 -> {
                fuActive = false
                fuTimestamp = -1L
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
                fuTimestamp = -1L
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
                val payloadLen = end - (offset + 3)

                if (isStart) {
                    fuBuffer.reset()
                    fuBuffer.write(0x00)
                    fuBuffer.write(0x00)
                    fuBuffer.write(0x00)
                    fuBuffer.write(0x01)
                    val reconstructedByte0 = (nalHeader0 and 0x81) or (innerType shl 1)
                    fuBuffer.write(reconstructedByte0)
                    fuBuffer.write(nalHeader1)
                    fuBuffer.write(data, offset + 3, payloadLen)
                    fuActive = true
                    fuTimestamp = timestamp
                    fuIsConfig = (innerType == 32 || innerType == 33 || innerType == 34)
                    fuIsKeyFrame = (innerType in 16..21)
                } else if (fuActive && fuTimestamp == timestamp) {
                    if (fuBuffer.size() + payloadLen > MAX_NALU_BYTES) {
                        fuBuffer.reset()
                        fuActive = false
                        fuTimestamp = -1L
                        return emptyList()
                    }
                    fuBuffer.write(data, offset + 3, payloadLen)
                } else {
                    fuBuffer.reset()
                    fuActive = false
                    fuTimestamp = -1L
                    return emptyList()
                }

                if (isEnd && fuActive) {
                    val assembled = fuBuffer.toByteArray()
                    val cfg = fuIsConfig
                    val key = fuIsKeyFrame
                    fuBuffer.reset()
                    fuActive = false
                    fuTimestamp = -1L
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
        var dri = 0

        // Restart Marker Header (types 64..127)
        if (type in 64..127) {
            if (pos + 4 > end) return emptyList()
            dri = ((data[pos].toInt() and 0xFF) shl 8) or (data[pos + 1].toInt() and 0xFF)
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
            jpegFragBuffer.reset()
            jpegFragTimestamp = -1L
            return emptyList()
        }

        if (pos > end) return emptyList()
        val payloadLen = end - pos
        if (jpegFragBuffer.size() + payloadLen > MAX_NALU_BYTES) {
            jpegFragBuffer.reset()
            jpegFragTimestamp = -1L
            return emptyList()
        }
        jpegFragBuffer.write(data, pos, payloadLen)
        jpegLastOffset += payloadLen

        if (!marker) return emptyList()

        val rawPayload = jpegFragBuffer.toByteArray()
        jpegFragBuffer.reset()
        jpegFragTimestamp = -1L

        val jpegBytes = if (rawPayload.size >= 2 &&
            (rawPayload[0].toInt() and 0xFF) == 0xFF &&
            (rawPayload[1].toInt() and 0xFF) == 0xD8
        ) {
            rawPayload
        } else if (jpegWidth > 0 && jpegHeight > 0) {
            synthesizeRfc2435Jpeg(rawPayload, jpegWidth, jpegHeight, jpegType, jpegQ, dri, jpegQuantTables)
        } else {
            return emptyList()
        }

        return listOf(
            EmittedUnit(
                data = jpegBytes,
                isConfig = false,
                isKeyFrame = true,
                isCompleteJpeg = true,
                width = jpegWidth,
                height = jpegHeight
            )
        )
    }

    /**
     * Synthesizes standard JFIF/JPEG headers (SOI, DQT, DRI, SOF0, DHT, SOS) around RFC 2435 scan data.
     */
    private fun synthesizeRfc2435Jpeg(
        scanData: ByteArray,
        width: Int,
        height: Int,
        type: Int,
        q: Int,
        dri: Int,
        customQt: ByteArray?
    ): ByteArray {
        val out = ByteArrayOutputStream(scanData.size + 768)
        // SOI
        out.write(0xFF); out.write(0xD8)

        // DQT (luminance table 0 + chrominance table 1)
        val (lumaQt, chromaQt) = if (customQt != null && customQt.size >= 128) {
            Pair(customQt.copyOfRange(0, 64), customQt.copyOfRange(64, 128))
        } else {
            makeQuantTables(q.coerceIn(1, 99))
        }
        writeDqt(out, 0, lumaQt)
        writeDqt(out, 1, chromaQt)

        // Optional DRI
        if (dri > 0) {
            out.write(0xFF); out.write(0xDD)
            out.write(0x00); out.write(0x04)
            out.write((dri ushr 8) and 0xFF); out.write(dri and 0xFF)
        }

        // SOF0 (Baseline DCT)
        out.write(0xFF); out.write(0xC0)
        out.write(0x00); out.write(0x11) // length 17
        out.write(0x08) // 8-bit precision
        out.write((height ushr 8) and 0xFF); out.write(height and 0xFF)
        out.write((width ushr 8) and 0xFF); out.write(width and 0xFF)
        out.write(0x03) // 3 components: Y, Cb, Cr
        val ySampling = if ((type and 0x01) == 1) 0x22 else 0x21 // 4:2:0 vs 4:2:2
        out.write(0x01); out.write(ySampling); out.write(0x00)
        out.write(0x02); out.write(0x11); out.write(0x01)
        out.write(0x03); out.write(0x11); out.write(0x01)

        // Standard Huffman tables (Annex K)
        writeDht(out, 0x00, STD_DC_LUMA_NRCODES, STD_DC_LUMA_VALUES)
        writeDht(out, 0x10, STD_AC_LUMA_NRCODES, STD_AC_LUMA_VALUES)
        writeDht(out, 0x01, STD_DC_CHROMA_NRCODES, STD_DC_CHROMA_VALUES)
        writeDht(out, 0x11, STD_AC_CHROMA_NRCODES, STD_AC_CHROMA_VALUES)

        // SOS
        out.write(0xFF); out.write(0xDA)
        out.write(0x00); out.write(0x0C) // length 12
        out.write(0x03) // 3 components
        out.write(0x01); out.write(0x00)
        out.write(0x02); out.write(0x11)
        out.write(0x03); out.write(0x11)
        out.write(0x00); out.write(0x3F); out.write(0x00)

        out.write(scanData)
        // Ensure EOI marker at end
        val hasEoi = scanData.size >= 2 &&
            (scanData[scanData.size - 2].toInt() and 0xFF) == 0xFF &&
            (scanData[scanData.size - 1].toInt() and 0xFF) == 0xD9
        if (!hasEoi) {
            out.write(0xFF); out.write(0xD9)
        }
        return out.toByteArray()
    }

    private fun writeDqt(out: ByteArrayOutputStream, tableId: Int, table: ByteArray) {
        out.write(0xFF); out.write(0xDB)
        out.write(0x00); out.write(0x43) // length 67
        out.write(tableId and 0x0F)
        out.write(table, 0, 64)
    }

    private fun writeDht(out: ByteArrayOutputStream, tcTh: Int, nrCodes: ByteArray, values: ByteArray) {
        val len = 2 + 1 + nrCodes.size + values.size
        out.write(0xFF); out.write(0xC4)
        out.write((len ushr 8) and 0xFF); out.write(len and 0xFF)
        out.write(tcTh)
        out.write(nrCodes)
        out.write(values)
    }

    private fun makeQuantTables(q: Int): Pair<ByteArray, ByteArray> {
        val factor = if (q < 50) 5000 / q else 200 - q * 2
        val luma = ByteArray(64)
        val chroma = ByteArray(64)
        for (i in 0 until 64) {
            val lv = ((STD_LUMA_QT[i] * factor + 50) / 100).coerceIn(1, 255)
            val cv = ((STD_CHROMA_QT[i] * factor + 50) / 100).coerceIn(1, 255)
            luma[i] = lv.toByte()
            chroma[i] = cv.toByte()
        }
        return Pair(luma, chroma)
    }

    companion object {
        private const val MAX_NALU_BYTES = 2 * 1024 * 1024

        private val STD_LUMA_QT = intArrayOf(
            16, 11, 12, 14, 12, 10, 16, 14, 13, 14, 18, 17, 16, 19, 24, 40,
            26, 24, 22, 22, 24, 49, 35, 37, 29, 40, 58, 51, 61, 60, 57, 51,
            56, 55, 64, 72, 92, 78, 64, 68, 87, 69, 55, 56, 80, 109, 81, 87,
            95, 98, 103, 104, 103, 62, 77, 113, 121, 112, 100, 120, 92, 101, 103, 99
        )
        private val STD_CHROMA_QT = intArrayOf(
            17, 18, 18, 24, 21, 24, 47, 26, 26, 47, 99, 66, 56, 66, 99, 99,
            99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
            99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
            99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99
        )
        private val STD_DC_LUMA_NRCODES = byteArrayOf(0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0)
        private val STD_DC_LUMA_VALUES = byteArrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)
        private val STD_DC_CHROMA_NRCODES = byteArrayOf(0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0)
        private val STD_DC_CHROMA_VALUES = byteArrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)
        private val STD_AC_LUMA_NRCODES = byteArrayOf(0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7D)
        private val STD_AC_LUMA_VALUES = intArrayOf(
            0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
            0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0,
            0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28,
            0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
            0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
            0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
            0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7,
            0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5,
            0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2,
            0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8,
            0xF9, 0xFA
        ).map { it.toByte() }.toByteArray()
        private val STD_AC_CHROMA_NRCODES = byteArrayOf(0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77)
        private val STD_AC_CHROMA_VALUES = intArrayOf(
            0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
            0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xA1, 0xB1, 0xC1, 0x09, 0x23, 0x33, 0x52, 0xF0,
            0x15, 0x62, 0x72, 0xD1, 0x0A, 0x16, 0x24, 0x34, 0xE1, 0x25, 0xF1, 0x17, 0x18, 0x19, 0x1A, 0x26,
            0x27, 0x28, 0x29, 0x2A, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
            0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
            0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
            0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5,
            0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3,
            0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA,
            0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8,
            0xF9, 0xFA
        ).map { it.toByte() }.toByteArray()

        private fun writeAnnexBStartCode(dst: ByteArray, index: Int) {
            dst[index] = 0x00
            dst[index + 1] = 0x00
            dst[index + 2] = 0x00
            dst[index + 3] = 0x01
        }
    }
}
