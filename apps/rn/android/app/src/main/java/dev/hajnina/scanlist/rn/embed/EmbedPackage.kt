package dev.hajnina.scanlist.rn.embed

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers `Embed` with RN (card A3). `isTurboModule = false` is deliberate: this is a legacy
 * `ReactContextBaseJavaModule`, which RN 0.88 exposes to JS through the legacy-module interop layer
 * under the new architecture (see [EmbedModule] for why there is no codegen spec).
 */
class EmbedPackage : BaseReactPackage() {

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == EmbedModule.NAME) EmbedModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            EmbedModule.NAME to
                ReactModuleInfo(
                    EmbedModule.NAME,
                    EmbedModule::class.java.name,
                    false, // canOverrideExistingModule
                    false, // needsEagerInit
                    false, // isCxxModule
                    false, // isTurboModule: legacy module, wrapped by the interop layer
                ),
        )
    }
}
