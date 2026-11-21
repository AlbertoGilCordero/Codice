#!/usr/bin/env bash
# Compila Codice.apk sin Gradle. Requiere (Ubuntu): aapt apksigner zipalign dalvik-exchange android-sdk-platform-23 y un JDK.
# La clave de firma se lee de android/codice.jks (KS_PASS en el entorno); si no existe se crea una nueva
# (ojo: con una clave distinta la app no se instala encima de la anterior).
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}
KS="$ROOT/android/codice.jks"; KS_PASS=${KS_PASS:-codice2026}
W="$ROOT/.build"; rm -rf "$W"; mkdir -p "$W/gen" "$W/obj" "$W/out"
cp -r "$ROOT/app" "$W/assets"
cd "$ROOT/android"
aapt package -f -m -J "$W/gen" -M AndroidManifest.xml -S res -A "$W/assets" -I "$SDK" -F "$W/out/unsigned.apk"
javac -nowarn --release 8 -classpath "$SDK" -d "$W/obj" -sourcepath "src:$W/gen" src/app/codice/lector/MainActivity.java "$W/gen/app/codice/lector/R.java" 2>&1 | grep -v "^Picked up\|^warning\|^Note" || true
dalvik-exchange --dex --min-sdk-version=24 --output="$W/out/classes.dex" "$W/obj"
(cd "$W/out" && aapt add unsigned.apk classes.dex >/dev/null)
zipalign -f -p 4 "$W/out/unsigned.apk" "$W/out/aligned.apk"
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass "$KS_PASS" -keypass "$KS_PASS" -alias codice -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Alberto Gil Cordero, O=Codice" 2>&1 | grep -v "^Picked up"
apksigner sign --ks "$KS" --ks-pass "pass:$KS_PASS" --ks-key-alias codice --out "$ROOT/dist/Codice.apk" "$W/out/aligned.apk"
rm -f "$ROOT/dist/Codice.apk.idsig"
apksigner verify --print-certs "$ROOT/dist/Codice.apk" | grep -v "^Picked up" | head -2
ls -la "$ROOT/dist/Codice.apk"
