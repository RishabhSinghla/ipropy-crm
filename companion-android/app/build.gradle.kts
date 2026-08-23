import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/**
 * Where the release signing key is, and its password.
 *
 * Written by `scripts/make-release-key.sh` and never committed. Android decides
 * whether one APK may replace another by comparing signatures, so this file
 * being absent is not a detail to shrug at: a build signed with anything else
 * cannot install over the copy already on a rep's phone.
 */
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.ipropy.callsync"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.ipropy.callsync"
        // 24 covers effectively every handset in use on an Indian sales desk.
        minSdk = 24
        targetSdk = 34
        // Bumped together, always. `versionCode` is the number Android
        // compares when deciding whether an APK is an upgrade; `versionName`
        // is the one a person reads. The app reports the name to the CRM, so
        // Settings → Phones shows which build each handset is running.
        versionCode = 2
        versionName = "1.1.0"
    }

    buildFeatures {
        // So the version has one definition rather than two that drift.
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            if (keystoreProperties.containsKey("storeFile")) {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // Left unminified deliberately: this app is sideloaded to a known
            // team, and a readable stack trace from a rep's phone is worth more
            // than the few hundred KB R8 would save.
            isMinifyEnabled = false

            // Deliberately not falling back to the debug key when the release
            // key is missing. A debug-signed "release" installs perfectly well
            // and then blocks every properly signed update after it, which is
            // a problem that surfaces months later on somebody else's phone.
            signingConfig = if (keystoreProperties.containsKey("storeFile")) {
                signingConfigs.getByName("release")
            } else {
                null
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    // Survives reboot and is honoured by the aggressive OEM battery managers
    // (Xiaomi, Oppo, Vivo) that kill plain services.
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.documentfile:documentfile:1.0.1")
    // Keeps the device token behind the Android keystore.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}
