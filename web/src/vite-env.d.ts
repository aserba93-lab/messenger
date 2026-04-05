/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_JITSI_ORIGIN?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_SOCKET_URL?: string;
  /** URL установщика Windows (.exe / релиз) */
  readonly VITE_DOWNLOAD_WINDOWS_URL?: string;
  /** URL APK или страницы Google Play */
  readonly VITE_DOWNLOAD_ANDROID_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  electronShell?: {
    isElectron: boolean;
    platform: NodeJS.Platform;
    focusAppWindow?: () => void;
  };
}

declare const __BUILD_TIME__: string;
declare const __GIT_SHA__: string;
