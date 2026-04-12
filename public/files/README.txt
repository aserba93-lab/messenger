Каталог для бэкенда: GET /files/app-release.apk читает файлы отсюда
(process.cwd()/public/files), если не задан PUBLIC_INSTALLERS_DIR в .env.

Скопируйте сюда установщики командой из корня репозитория:
  node scripts/copy-android-apk-to-public.mjs

Файлы .apk/.exe не коммитятся в Git (.gitignore).
