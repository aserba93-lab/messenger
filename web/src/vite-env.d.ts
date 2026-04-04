/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_JITSI_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __BUILD_TIME__: string;
declare const __GIT_SHA__: string;
