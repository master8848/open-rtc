// Maven Central publishing for vidcall Kotlin modules (docs/research/mobile-bindings.md §6.1).
//   - JVM modules publish `components["java"]` (jar + sources + javadoc)
//   - the Android module publishes the `release` AAR component
// Credentials (Central Portal): `-Pvidcall.central.username=... -Pvidcall.central.token=...`
// or env VIDCALL_CENTRAL_USERNAME / VIDCALL_CENTRAL_TOKEN.
// GPG signing (required by Central): set `signing.gnupg.keyName`/`signing.gnupg.passphrase`
// (or env VIDCALL_GPG_KEY_ID) so the `signing` block activates.
//
// Note: this is a script plugin applied via `apply(from = ...)`, so the Gradle
// Kotlin DSL does not generate typed accessors here — every extension is looked
// up through `extensions.getByType(...)` and `project.components`.
import org.gradle.api.publish.PublishingExtension
import org.gradle.api.publish.maven.MavenPublication
import org.gradle.plugins.signing.SigningExtension

apply(plugin = "maven-publish")
apply(plugin = "signing")

val isAndroidLibrary = plugins.hasPlugin("com.android.library")

val portalUsername: String? =
    (findProperty("vidcall.central.username") as String?) ?: System.getenv("VIDCALL_CENTRAL_USERNAME")
val portalToken: String? =
    (findProperty("vidcall.central.token") as String?) ?: System.getenv("VIDCALL_CENTRAL_TOKEN")
val hasSigningKey: Boolean =
    (findProperty("signing.gnupg.keyName") as String?) != null || System.getenv("VIDCALL_GPG_KEY_ID") != null

fun MavenPublication.applyVidcallPom() {
    pom {
        name.set("vidcall-${project.name.removePrefix("vidcall-")}")
        description.set("vidcall ${project.name}: Kotlin/Android binding for the vidcall signaling protocol (see protocol/schema.json)")
        url.set("https://github.com/vidcall/vidcall")
        licenses {
            license {
                name.set("MIT")
                url.set("https://opensource.org/licenses/MIT")
            }
        }
        developers {
            developer {
                id.set("vidcall")
                name.set("vidcall contributors")
            }
        }
        scm {
            connection.set("scm:git:https://github.com/vidcall/vidcall.git")
            url.set("https://github.com/vidcall/vidcall")
        }
    }
}

afterEvaluate {
    val publishing = extensions.getByType(PublishingExtension::class)

    publishing.publications {
        if (isAndroidLibrary) {
            create<MavenPublication>("mavenRelease") {
                from(project.components["release"])
                artifactId = "vidcall-android"
                applyVidcallPom()
            }
        } else {
            create<MavenPublication>("maven") {
                from(project.components["java"])
                applyVidcallPom()
            }
        }
    }

    publishing.repositories {
        maven {
            name = "CentralPortal"
            url = uri("https://central.sonatype.com/api/v1/publisher")
            credentials {
                username = portalUsername
                password = portalToken
            }
        }
    }

    if (hasSigningKey) {
        val signing = extensions.getByType(SigningExtension::class)
        signing.useGpgCmd()
        signing.sign(publishing.publications)
    }
}
