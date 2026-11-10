# Bundled Linux x86_64 tools

الأدوات مضمّنة داخل المستودع لأجهزة Linux `x86_64` (`process.arch === "x64"`) فقط.

- `yt-dlp`: ملف ELF كامل داخل `vendor/yt-dlp`، إصدار 2026.10.26.
- `ffmpeg` و`ffprobe`: مقسّمان إلى أجزاء أقل من 100 MB داخل `vendor/parts/` بسبب حد GitHub للملف الواحد.

عند التشغيل، يعيد البرنامج تجميع أجزاء FFmpeg محليًا داخل `.runtime-tools/`. لا يتم تنزيل أي ملف من الإنترنت.

مصادر الأدوات الأصلية:

- https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26
- https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases

حزمة FFmpeg المستخدمة هي GPL؛ راجع شروط الترخيص قبل إعادة توزيع المشروع.
