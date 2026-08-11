plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "io.vidcall.android"
    compileSdk = 36

    defaultConfig {
        // io.getstream:stream-webrtc-android ships minSdk 21 (verified in its AAR manifest)
        minSdk = 21
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
            withJavadocJar()
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    api(project(":vidcall-protocol"))
    api(project(":vidcall-client"))
    // Pinned prebuilt WebRTC (Apache-2.0, Maven Central). Published 2025-09-11,
    // verified via https://repo1.maven.org/maven2/io/getstream/stream-webrtc-android/maven-metadata.xml
    // and https://search.maven.org/solrsearch/select?q=g:io.getstream+AND+a:stream-webrtc-android
    // (docs/research/mobile-bindings.md §1.2 / §7).
    api(libs.stream.webrtc.android)
    testImplementation(libs.junit)
}

apply(from = rootProject.file("gradle/publishing-convention.gradle.kts"))
