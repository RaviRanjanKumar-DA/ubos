# UBOS phone app (SIM calling)

Kotlin, no third-party libraries. Design: `docs/design/SIM-CALLING.md`.

Open this folder in Android Studio, or build from a terminal:

    ./gradlew assembleDebug testDebugUnitTest

The debug build can reach a test server without https: `http://10.0.2.2:<port>` from the emulator, or this computer's Wi-Fi address from a real phone on the same network. Release builds use https only.

Reading the call log is restricted on Google Play: an app must qualify for a permitted use or be installed directly (APK or managed by the organization).
