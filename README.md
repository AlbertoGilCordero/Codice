# Códice

Lector de libros personal para Android, con estética de cuaderno renacentista. Funciona con y sin conexión.

- **Lectura** — abre el libro donde lo dejaste. EPUB, PDF, MOBI, AZW3, FB2, CBZ y TXT. Recorte de márgenes y OCR sin conexión para PDF escaneados.
- **Duda palabra** — toca una palabra: definición en el idioma del libro, o traducción.
- **Biblioteca** — libros añadidos desde los archivos del teléfono.
- **Council** — debate con una IA sobre el capítulo leído (servicios gratuitos, o clave gratuita de Gemini/Groq).
- **Perfil** — libros leídos, tiempo, promedio por libro, notas y vocabulario.

## Instalar

Descarga [`dist/Codice.apk`](dist/Codice.apk) en el móvil y ábrelo. Versión actual en [`VERSION`](VERSION); cambios en [`CHANGELOG.md`](CHANGELOG.md).

## Estructura

| Carpeta | Contenido |
|---|---|
| `app/` | La aplicación (HTML, CSS y JS). `app/foliate/` es el motor de lectura, `app/ocr/` el OCR con sus idiomas. |
| `android/` | Envoltorio Android: una actividad con WebView que sirve `app/` y hace de puente (archivos, red, tema). |
| `dist/` | El APK firmado de la última versión. |
| `build.sh` | Compila y firma el APK sin Gradle. |

## Compilar

```bash
sudo apt-get install aapt apksigner zipalign dalvik-exchange android-sdk-platform-23
./build.sh
```

Al publicar una versión: subir `versionCode`/`versionName` en `android/AndroidManifest.xml`, el número en `VERSION` y en `app/app.js`, y añadir la entrada en `CHANGELOG.md`.

## Créditos

[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT), [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0), tipografías Cormorant Garamond y EB Garamond (OFL).
