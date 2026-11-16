package dev.hajnina.scanlist.embed

/**
 * Wire protocol between [RemoteEmbedder] and [EmbedService] (card S5, the opt-in separate-process
 * mode). Deliberately tiny: the library does not need AIDL — a [android.os.Messenger] plus a [android.os.Bundle]
 * carries one request and one reply, and `float[]`/`ByteArray`/`StringArrayList` are all Parcelable.
 *
 * Why a separate process at all: a GPU/NPU driver crash kills the process it runs in. With the engine
 * in `android:process=":embed"`, the app survives and can rebuild the embedder on the CPU (RECIPE.md §2,
 * MnemoThera AD-01). It is **not** the default: in-process is simpler, and card B0 has not yet shown a
 * driver that needs isolating.
 */
object EmbedIpc {
    const val OP_INFO = 1
    const val OP_DOCS = 2
    const val OP_QUERY = 3
    const val OP_IMAGE = 4
    const val OP_CLOSE = 5

    const val KEY_OP = "op"
    const val KEY_TEXTS = "texts"
    const val KEY_JPEG = "jpeg"

    const val KEY_FLAT = "flat"
    const val KEY_LENGTHS = "lengths"
    const val KEY_VECTOR = "vector"
    const val KEY_BACKEND = "backend"
    const val KEY_DIMS = "dims"
    const val KEY_SUPPORTS_IMAGES = "supportsImages"
    const val KEY_MODEL_ID = "modelId"
    const val KEY_ERROR = "error"
    const val KEY_ERROR_CLASS = "errorClass"

    const val EXTRA_MODEL_PATH = "modelPath"
    const val EXTRA_MODEL_ID = "modelId"
    const val EXTRA_MODEL_SHA256 = "modelSha256"
    const val EXTRA_NATIVE_DIMS = "nativeDims"
    const val EXTRA_MATRYOSHKA_DIMS = "matryoshkaDims"
    const val EXTRA_MAX_INPUT_LENGTH = "maxInputLength"
    const val EXTRA_VISION_TOKENS = "visionTokens"
    const val EXTRA_ALLOW_NPU = "allowNpu"
    const val EXTRA_FLOAT32 = "float32"
}
