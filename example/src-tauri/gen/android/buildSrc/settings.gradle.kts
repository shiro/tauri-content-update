// the `kotlin-dsl` plugin resolves the Kotlin Gradle plugin through these; the default (Gradle Plugin
// Portal only) doesn't serve it, which only shows up with an empty Gradle cache (CI)
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        google()
    }
}
