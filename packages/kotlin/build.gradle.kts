// Root build for the vidcall Kotlin/Android binding.
// Plugin versions are pinned in gradle/libs.versions.toml (supply-chain policy:
// every plugin/dependency published >= 14 days before adoption, exact pins).
plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.android.library) apply false
}

// Lockfile-based dependency pinning (docs/research/mobile-bindings.md §6.4):
// run `./gradlew dependencies --write-locks` to (re)generate gradle.lockfile.
subprojects {
    dependencyLocking {
        lockAllConfigurations()
    }
}
