plugins {
    id("com.android.application")
}

android {
    namespace = "app.ubos.mobile"
    compileSdk { version = release(37) }

    defaultConfig {
        applicationId = "app.ubos.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
