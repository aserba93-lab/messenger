/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_JITSI_ORIGIN?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_SOCKET_URL?: string;
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
