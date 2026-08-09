plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.ipropy.callsync"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.ipropy.callsync"
        // 24 covers effectively every handset in use on an Indian sales desk.
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            // Left unminified deliberately: this app is sideloaded to a known
            // team, and a readable stack trace from a rep's phone is worth more
            // than the few hundred KB R8 would save.
            isMinifyEnabled = false
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
