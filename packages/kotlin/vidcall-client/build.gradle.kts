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

dependencies {
    api(project(":vidcall-protocol"))
    api(libs.okhttp)
    testImplementation(libs.junit)
    // Wire-level transport tests (real WebSocket/HTTP against a local mock server).
    // Same publisher + version train as okhttp (5.4.0, published 2026-06-08);
    // test scope only — never shipped.
    testImplementation(libs.mockwebserver3)
}

apply(from = rootProject.file("gradle/publishing-convention.gradle.kts"))
