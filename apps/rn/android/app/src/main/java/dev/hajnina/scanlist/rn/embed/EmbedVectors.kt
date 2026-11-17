package dev.hajnina.scanlist.rn.embed

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64

/**
 * Vector wire format between Kotlin and JS (card A3).
 *
 * A 256-d vector as a JSON array is 256 boxed numbers through the bridge; `shared/android-embed` can
 * return three of those per scan. So vectors travel as **base64 of little-endian float32 bytes** and
 * `apps/rn/modules/embed/index.ts` decodes them straight into a `Float32Array`
 * (`base64ToFloat32`). Little-endian is fixed here and asserted by the JS unit test.
 */
internal object EmbedVectors {

    /** 4 bytes per float, little-endian, standard base64 with padding, no line breaks. */
    fun toBase64(vector: FloatArray): String {
        val buffer = ByteBuffer.allocate(vector.size * Float.SIZE_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        for (value in vector) {
            buffer.putFloat(value)
        }
        return Base64.getEncoder().encodeToString(buffer.array())
    }
}
