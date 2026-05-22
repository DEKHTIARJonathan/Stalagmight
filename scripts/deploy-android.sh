#!/bin/bash
# Build, sign, and deploy Stalagmight to an Android tablet over network ADB.
#
# Usage:
#   ./scripts/deploy-android.sh              # auto-detect device
#   ./scripts/deploy-android.sh 10.10.0.20:44609   # specify device
#
# Builds arm64 release APK, signs with debug keystore, pushes and installs.
# Handles Boox firmware quirk that auto-disables sideloaded apps.

set -euo pipefail

ZIPALIGN="$HOME/Android/Sdk/build-tools/35.0.0/zipalign"
APKSIGNER="$HOME/Android/Sdk/build-tools/35.0.0/apksigner"
KEYSTORE="$HOME/.android/debug.keystore"
APK_UNSIGNED="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
APK_ALIGNED="/tmp/stalagmight-aligned.apk"
APK_SIGNED="/tmp/stalagmight-signed.apk"
PACKAGE="com.stalagmight.android"

# Resolve device
if [ -n "${1:-}" ]; then
    DEVICE="$1"
else
    DEVICE=$(adb devices | grep -v "^List" | grep "device$" | head -1 | awk '{print $1}')
    if [ -z "$DEVICE" ]; then
        echo "Error: No connected device found. Pass device address or connect via 'adb connect <ip>:<port>'"
        exit 1
    fi
fi
ADB="adb -s $DEVICE"

echo "==> Target device: $DEVICE"

# Build
echo "==> Building arm64 release APK..."
pnpm tauri android build --target aarch64 2>&1 | tail -3

# Sign
echo "==> Signing APK..."
"$ZIPALIGN" -f -p 4 "$APK_UNSIGNED" "$APK_ALIGNED"
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass pass:android --out "$APK_SIGNED" "$APK_ALIGNED"
SIZE=$(du -h "$APK_SIGNED" | cut -f1)
echo "    Signed APK: $SIZE"

# Push and install (replace existing, preserving app data)
echo "==> Pushing to device..."
$ADB push "$APK_SIGNED" /data/local/tmp/stalagmight.apk

echo "==> Installing..."
$ADB shell pm install -r /data/local/tmp/stalagmight.apk

# Boox firmware auto-disables sideloaded apps — re-enable
$ADB shell pm enable "$PACKAGE" > /dev/null 2>&1 || true

# Launch
echo "==> Launching..."
$ADB shell am start -n "$PACKAGE/.MainActivity" 2>&1 | grep -v "^$"

echo "==> Done"
