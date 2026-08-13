plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
    withSourcesJar()
    withJavadocJar()
}

// L0 conformance: the canonical wire fixtures live in the repo-wide
// `protocol/fixtures/` directory (single source of truth, shared by the
// Kotlin/Swift/Dart/TS conformance suites). Expose them as test resources so
// the tests read the SAME files as every other binding.
val canonicalFixturesDir: File = rootProject.file("../../protocol/fixtures")
require(canonicalFixturesDir.isDirectory) {
    "missing canonical fixture dir: $canonicalFixturesDir (see protocol/fixtures/README.md)"
}
sourceSets {
    test {
        resources {
            srcDir(canonicalFixturesDir)
        }
    }
}

dependencies {
    api(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
}

apply(from = rootProject.file("gradle/publishing-convention.gradle.kts"))
