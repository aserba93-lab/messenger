import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, MouseEvent } from "react";
import { io, Socket } from "socket.io-client";
import * as XLSX from "xlsx";
import { acceptIncomingOffer, debugIceServers, type ActiveCall } from "./webrtcDm";
import { createGroupMeshSession, GroupMeshSession, GROUP_MESH_MAX_PEERS } from "./webrtcGroupMesh";
import {
  createFolderId,
  loadChatFolders,
  parseChatFolderStateJson,
  saveChatFolders,
  type ChatFolderState as UserChatFolderLayout,
} from "./chatFolders";
import "./App.css";

/** Актуальный access token для fetch GraphQL, если замыкание передало undefined */
const gqlAuthTokenRef = { current: "" };

function GroupMeshRemoteVideo({
  stream,
  userId,
  playAudio = true,
  showVideo = true,
  videoClassName,
}: {
  stream: MediaStream;
  userId: string;
  /** В сетке-снимках сверху — только картинка, звук отдельным слоем (иначе дубли). */
  playAudio?: boolean;
  showVideo?: boolean;
  videoClassName?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    const ael = audioRef.current;
    if (showVideo && el) {
      el.srcObject = stream;
      try {
        el.playsInline = true;
        /** muted на video — иначе автовоспроизведение часто блокируется; звук с отдельного audio. */
        el.muted = true;
      } catch {
        /* ignore */
      }
    }
    if (playAudio && ael) {
      ael.srcObject = stream;
      ael.muted = false;
      try {
        ael.volume = 1;
      } catch {
        /* ignore */
      }
    }
    const play = () => {
      if (showVideo && el) void el.play().catch(() => {});
      if (playAudio && ael) void ael.play().catch(() => {});
    };
    play();
    const onTrack = () => {
      if (playAudio && ael) {
        ael.srcObject = stream;
        try {
          ael.volume = 1;
        } catch {
          /* ignore */
        }
      }
      play();
    };
    const tracks = stream.getTracks();
    for (const t of tracks) {
      t.addEventListener("unmute", onTrack);
      t.addEventListener("mute", onTrack);
      t.addEventListener("ended", onTrack);
    }
    const onMeta = () => play();
    if (showVideo && el) el.addEventListener("loadedmetadata", onMeta);
    stream.addEventListener("addtrack", onTrack);
    stream.addEventListener("removetrack", onTrack);
    const kick = window.setInterval(() => play(), 1200);
    return () => {
      window.clearInterval(kick);
      stream.removeEventListener("addtrack", onTrack);
      stream.removeEventListener("removetrack", onTrack);
      if (showVideo && el) el.removeEventListener("loadedmetadata", onMeta);
      for (const t of tracks) {
        t.removeEventListener("unmute", onTrack);
        t.removeEventListener("mute", onTrack);
        t.removeEventListener("ended", onTrack);
      }
      try {
        if (showVideo && el) el.srcObject = null;
        if (playAudio && ael) ael.srcObject = null;
      } catch {
        /* ignore */
      }
    };
  }, [stream, userId, playAudio, showVideo]);
  return (
    <div className={showVideo ? "groupMeshVideoWrap" : "groupMeshAudioOnlySlot"}>
      {showVideo ? (
        <video className={videoClassName ?? "groupMeshVideo"} ref={videoRef} autoPlay playsInline muted />
      ) : null}
      {playAudio ? <audio ref={audioRef} autoPlay playsInline className="groupMeshRemoteAudio" /> : null}
    </div>
  );
}

const TG_SESSION_KEY = "tg:session";
const TG_LAST_OPEN_CHAT_KEY = "tg:lastOpenChat";

function readTgLastOpenChatKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(TG_LAST_OPEN_CHAT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { key?: string } | string;
    const key = typeof parsed === "string" ? parsed : parsed?.key;
    if (key && typeof key === "string" && /^[cgd]:/.test(key)) return key;
  } catch {
    /* ignore */
  }
  return null;
}

type StoredSession = {
  token: string;
  userId?: string;
  viewerRole?: string;
  organizationId?: string;
  workspaceId?: string;
  systemAccessLevel?: string;
};

function readStoredSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(TG_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Record<string, unknown>;
    const token = s.token;
    if (typeof token === "string" && token.length > 0) {
      return {
        token,
        userId: typeof s.userId === "string" ? s.userId : undefined,
        viewerRole: typeof s.viewerRole === "string" ? s.viewerRole : undefined,
        organizationId: typeof s.organizationId === "string" ? s.organizationId : undefined,
        workspaceId: typeof s.workspaceId === "string" ? s.workspaceId : undefined,
        systemAccessLevel: typeof s.systemAccessLevel === "string" ? s.systemAccessLevel : undefined,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

const initialSession = readStoredSession();

type LoginResult = {
  accessToken?: string;
  viewer?: { userId: string; organizationId: string; role: string; systemAccessLevel?: string };
  needsEmailOtp?: boolean;
  challengeId?: string;
  emailMasked?: string;
};

type Channel = {
  id: string;
  workspaceId: string;
  name: string;
  type: "public" | "private" | "broadcast";
  avatarUrl?: string | null;
  createdByUserId?: string;
};
type GroupChat = { id: string; name: string; memberIds: string[]; createdByUserId?: string; avatarUrl?: string | null };
type DirectChat = { id: string; userIds: string[] };

type Reaction = { emoji: string; count: number; viewerHasReacted: boolean };
type FileInfo = {
  id: string;
  originalName?: string | null;
  mimeType: string;
  size: number;
  downloadUrl?: string;
  avStatus?: string | null;
  blockedReason?: string | null;
};

type Message = {
  id: string;
  content: string;
  createdAt: string;
  author: { id?: string; email: string; firstName?: string | null; middleName?: string | null; lastName?: string | null };
  type?: string;
  file?: FileInfo | null;
  reactions?: Reaction[];
  parentMessageId?: string | null;
  editedAt?: string | null;
  updatedAt?: string;
  isDeleted?: boolean;
  _localFileState?: "uploading" | "scanning" | "failed";
  _localError?: string;
  _sendState?: "sending" | "failed";
};

type DirectChatMessage = {
  id: string;
  directChatId: string;
  content: string;
  createdAt: string;
  updatedAt?: string;
  author: { id?: string; email: string; firstName?: string | null; middleName?: string | null; lastName?: string | null };
  type?: string;
  parentMessageId?: string | null;
  reactions?: Reaction[];
  file?: FileInfo | null;
};

/** В проде без VITE_API_URL используем origin сайта (тот же хост, что и UI), иначе fetch уйдёт не туда. */
function getApiBase(): string {
  const env = (import.meta as any).env?.VITE_API_URL as string | undefined;
  if (env && String(env).trim()) return String(env).replace(/\/$/, "");
  if (typeof window === "undefined") return "";
  const h = window.location.hostname;
  if (h === "localhost" || h === "127.0.0.1") return "http://localhost:3000";
  return window.location.origin;
}
const API_BASE = getApiBase();
const GQL = `${API_BASE}/graphql`;
function getSocketUrl(): string {
  const env = (import.meta as any).env?.VITE_SOCKET_URL as string | undefined;
  if (env && String(env).trim()) return String(env).replace(/\/$/, "");
  return API_BASE || (typeof window !== "undefined" ? window.location.origin : "");
}
const SOCKET_URL = getSocketUrl();

/** Safari / WebKit на iPhone и iPad (включая iPadOS с User-Agent как Mac). */
function isIosLikeBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  const nav = navigator as Navigator & { maxTouchPoints?: number };
  if (navigator.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1) return true;
  return false;
}

/** Открыто с ярлыка «На экран Домой» / установленное PWA. Без display-mode: fullscreen — иначе обычная вкладка в полноэкранном режиме (F11) ошибочно считается PWA. */
function isStandaloneWebApp(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const nav = window.navigator as Navigator & { standalone?: boolean };
    if (nav.standalone === true) return true;
    if (window.matchMedia?.("(display-mode: standalone)")?.matches) return true;
    if (window.matchMedia?.("(display-mode: minimal-ui)")?.matches) return true;
    if (window.matchMedia?.("(display-mode: window-controls-overlay)")?.matches) return true;
  } catch {
    /* ignore */
  }
  return false;
}

const quickEmojis = ["👍", "❤️", "😂", "🔥", "🎉", "😮"];
/** 15 встроенных наборов; в кабинете можно добавить свои JSON-паки */
const defaultStickerCatalog = [
  { id: "pack-01-smiles", title: "Улыбки", stickers: ["😀", "😁", "😂", "😍", "🥰", "😇", "🤗", "😋"] },
  { id: "pack-02-work", title: "Работа", stickers: ["✅", "📌", "📎", "💼", "🚀", "📊", "🗓️", "☑️"] },
  { id: "pack-03-mood", title: "Настроение", stickers: ["🙂", "😎", "🤔", "🥳", "😴", "😮", "🤯", "🥶"] },
  { id: "pack-04-animals", title: "Звери", stickers: ["🐶", "🐱", "🐻", "🦁", "🐸", "🦊", "🐼", "🐰"] },
  { id: "pack-05-food", title: "Еда", stickers: ["🍕", "🍔", "🍰", "☕", "🍎", "🥗", "🌮", "🍜"] },
  { id: "pack-06-hearts", title: "Сердца", stickers: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💖"] },
  { id: "pack-07-hands", title: "Жесты", stickers: ["👍", "👎", "✌️", "🤞", "🙏", "👏", "🤝", "👋"] },
  { id: "pack-08-travel", title: "Путешествия", stickers: ["✈️", "🚗", "🚂", "🏖️", "🗺️", "⛺", "🧳", "🌍"] },
  { id: "pack-09-sport", title: "Спорт", stickers: ["⚽", "🏀", "🎾", "🏆", "🎯", "⛷️", "🚴", "🥇"] },
  { id: "pack-10-music", title: "Музыка", stickers: ["🎵", "🎸", "🎹", "🎤", "🎧", "🥁", "🎺", "🎻"] },
  { id: "pack-11-tech", title: "Техника", stickers: ["💻", "📱", "⌨️", "🖥️", "💾", "📷", "🎮", "🔌"] },
  { id: "pack-12-weather", title: "Погода", stickers: ["☀️", "🌧️", "❄️", "🌈", "⚡", "🌙", "⭐", "🌊"] },
  { id: "pack-13-symbols", title: "Знаки", stickers: ["✅", "❌", "❓", "❗", "💯", "🔔", "📍", "🔥"] },
  { id: "pack-14-party", title: "Праздник", stickers: ["🎉", "🎊", "🎈", "🎁", "🍾", "🥳", "🎂", "✨"] },
  { id: "pack-15-nature", title: "Природа", stickers: ["🌲", "🌸", "🍀", "🌙", "🌊", "🔥", "💧", "🌈"] },
];

async function gql<T>(query: string, variables: Record<string, unknown>, token?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = String(token ?? gqlAuthTokenRef.current ?? "").trim();
  if (auth) headers.authorization = `Bearer ${auth}`;
  const res = await fetch(GQL, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  const raw = await res.text();
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`GraphQL parse error (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const errMsg =
      (data?.errors?.[0]?.message as string | undefined) ||
      (data?.error as string | undefined) ||
      (data?.message as string | undefined) ||
      (raw ? String(raw).slice(0, 500) : "") ||
      `HTTP ${res.status}`;
    throw new Error(formatGqlUserMessage(errMsg));
  }
  if (data.errors?.length) {
    const first = data.errors[0];
    const detail =
      first?.extensions?.originalError?.message ||
      first?.extensions?.exception?.message ||
      first?.extensions?.details ||
      "";
    const msg = first?.message ?? "GraphQL error";
    throw new Error(formatGqlUserMessage(detail && detail !== msg ? `${msg}: ${detail}` : msg));
  }
  return data.data as T;
}

function normalizeDownloadUrl(url?: string | null) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `${API_BASE}${url}`;
  return url;
}

/** Выдача вложений через GET /files/access/:id + Bearer (обходит presigned URL и nginx SPA). */
function isFilesAccessProxyUrl(url: string): boolean {
  if (!url) return false;
  if (url.includes("/files/access/")) return true;
  try {
    return new URL(url).pathname.includes("/files/access/");
  } catch {
    return false;
  }
}

async function fetchAuthorizedFileBlob(url: string, token: string): Promise<Blob> {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.blob();
}

async function triggerBrowserDownloadFromUrl(rawUrl: string | null | undefined, token: string | null, filename: string) {
  if (!rawUrl) return;
  const href = normalizeDownloadUrl(rawUrl);
  if (!href) return;
  try {
    if (token && isFilesAccessProxyUrl(href)) {
      const blob = await fetchAuthorizedFileBlob(href, token);
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = filename || "file";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(u);
      return;
    }
    const a = document.createElement("a");
    a.href = href;
    a.download = filename || "file";
    a.target = "_blank";
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    /* ignore */
  }
}

async function openMediaInNewTabFromUrl(rawUrl: string | null | undefined, token: string | null) {
  if (!rawUrl) return;
  const href = normalizeDownloadUrl(rawUrl);
  if (!href) return;
  try {
    if (token && isFilesAccessProxyUrl(href)) {
      const blob = await fetchAuthorizedFileBlob(href, token);
      const u = URL.createObjectURL(blob);
      const w = window.open(u, "_blank", "noopener,noreferrer");
      if (w) window.setTimeout(() => URL.revokeObjectURL(u), 120_000);
      return;
    }
    window.open(href, "_blank", "noopener,noreferrer");
  } catch {
    window.open(href, "_blank", "noopener,noreferrer");
  }
}

function fileExtensionUpper(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toUpperCase() : "";
}

/** Подпись формата: расширение из имени или хвост MIME. */
function fileFormatLabel(originalName: string | null | undefined, mimeType: string): string {
  const ext = fileExtensionUpper(originalName ?? "");
  if (ext) return ext;
  const part = mimeType.split("/")[1];
  return part ? part.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) : "FILE";
}

/** Расширение файла — фото в чате, даже если на сервере mime application/octet-stream */
const IMAGE_FILENAME_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif|heic|heif)$/i;

function looksLikeImageAttachment(originalName: string | null | undefined, mimeType: string | null | undefined): boolean {
  if ((mimeType || "").startsWith("image/")) return true;
  return IMAGE_FILENAME_RE.test(originalName || "");
}

/** В каналах/группах имя файла часто дублируется в content; в ЛС при сокете content пустой — добираем после hydrate. */
function attachmentOriginalNameHint(m: Message): string | null | undefined {
  if (m.file?.originalName) return m.file.originalName;
  if ((m.type === "file" || m.type === "voice") && m.content?.trim()) return m.content.trim();
  return null;
}

/**
 * Сокет присылает только fileId (mapMessage), не вложенный file — иначе нет hydrate и в ЛС вложения «пустые».
 */
function mergeSocketFilePayload(
  existing: FileInfo | null | undefined,
  m: { file?: FileInfo | null; fileId?: string | null; content?: string; type?: string },
): FileInfo | null {
  const embedded = m.file;
  const fid = embedded?.id ?? m.fileId;
  if (!fid) return existing ?? null;
  const id = String(fid);
  const fromContent =
    m.content?.trim() && (m.type === "file" || m.type === "voice") ? m.content.trim() : null;
  return {
    id,
    originalName: embedded?.originalName ?? fromContent ?? existing?.originalName ?? null,
    mimeType: String(embedded?.mimeType ?? existing?.mimeType ?? "application/octet-stream"),
    size: typeof embedded?.size === "number" ? embedded.size : existing?.size ?? 0,
    downloadUrl: embedded?.downloadUrl ?? existing?.downloadUrl,
    avStatus: embedded?.avStatus ?? existing?.avStatus ?? null,
    blockedReason: embedded?.blockedReason ?? existing?.blockedReason ?? null,
  };
}

function fileWaitLine(kind: "file" | "voice", avStatus?: string | null, blockedReason?: string | null): string {
  const s = String(avStatus || "").toLowerCase();
  if (s === "pending") return "Проверяется антивирусом…";
  if (s === "infected") return `Файл заблокирован${blockedReason ? `: ${blockedReason}` : ""}`;
  if (s === "error") return `Ошибка обработки файла${blockedReason ? `: ${blockedReason}` : ""}`;
  return kind === "voice" ? "Подготовка воспроизведения…" : "Получение ссылки…";
}

function guessMimeFromOriginalNameForUpload(name: string): string | null {
  const n = name.toLowerCase();
  if (/\.(jpe?g)$/.test(n)) return "image/jpeg";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".bmp")) return "image/bmp";
  if (n.endsWith(".svg")) return "image/svg+xml";
  if (n.endsWith(".avif")) return "image/avif";
  if (n.endsWith(".heic") || n.endsWith(".heif")) return "image/heic";
  if (n.endsWith(".webm")) return "audio/webm";
  if (n.endsWith(".m4a")) return "audio/mp4";
  if (n.endsWith(".mp3")) return "audio/mpeg";
  if (n.endsWith(".ogg") || n.endsWith(".opus")) return "audio/ogg";
  if (n.endsWith(".wav")) return "audio/wav";
  if (n.endsWith(".torrent")) return "application/x-bittorrent";
  return null;
}

/** Имя для списка чатов и заголовков — фамилия, имя, отчество (если есть); без email */
function displayUserNameForSidebar(
  u: { email: string; firstName?: string | null; middleName?: string | null; lastName?: string | null } | undefined,
  fallback: string,
): string {
  if (!u) {
    if (fallback && !fallback.includes("@")) return `Контакт ${fallback.slice(0, 8)}`;
    return "Участник";
  }
  const last = u.lastName != null ? String(u.lastName).trim() : "";
  const first = u.firstName != null ? String(u.firstName).trim() : "";
  const middle = u.middleName != null ? String(u.middleName).trim() : "";
  const name = [last, first, middle].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (fallback && !fallback.includes("@")) return `Контакт ${fallback.slice(0, 8)}`;
  return "Участник";
}

function isAppleMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function orgRoleLabelRu(role: string | null | undefined): string {
  switch (role) {
    case "owner":
      return "Владелец";
    case "admin":
      return "Администратор";
    case "manager":
      return "Менеджер";
    case "employee":
      return "Сотрудник";
    case "guest":
      return "Гость";
    default:
      return "Сотрудник";
  }
}

function isUnauthorizedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return msg.trim().toLowerCase() === "unauthorized" || msg.toLowerCase().includes("unauthorized");
}

/** Человекочитаемые формулировки вместо сырого «Unauthorized» из GraphQL */
function formatGqlUserMessage(msg: string): string {
  const t = String(msg ?? "").trim();
  if (!t) return "Ошибка запроса";
  if (/^unauthorized$/i.test(t) || (/\bunauthorized\b/i.test(t) && t.length < 40)) {
    return "Нет доступа: сессия истекла или недостаточно прав. Выйдите и войдите снова.";
  }
  return t;
}

const GROUP_CALL_INVITE_LIVE_MS = 45 * 60 * 1000;

/** Префикс «группового» mesh id для личного чата (тот же стек WebRTC, что и у группы) */
const DM_MESH_PREFIX = "dm-mesh:";
function dmMeshGroupChatId(directChatId: string) {
  return `${DM_MESH_PREFIX}${directChatId}`;
}

/** Ссылка-приглашение в сообщении: группа или личка */
function parseCallInviteFromContent(
  content: string | null | undefined,
): { type: "group"; groupId: string } | { type: "dm"; directChatId: string } | null {
  const t = String(content ?? "").trim();
  if (!t) return null;
  const groupM = t.match(/[#&?]group=([^&\s#]+)/i);
  if (groupM && /gcall=1/i.test(t)) {
    try {
      return { type: "group", groupId: decodeURIComponent(groupM[1]) };
    } catch {
      return { type: "group", groupId: groupM[1] };
    }
  }
  const dmM = t.match(/[#&?]dm=([^&\s#]+)/i);
  if (dmM && /call=1/i.test(t)) {
    try {
      return { type: "dm", directChatId: decodeURIComponent(dmM[1]) };
    } catch {
      return { type: "dm", directChatId: dmM[1] };
    }
  }
  return null;
}

/** Одна «стикерная» графема (эмодзи) — для увеличенного отображения в чате */
function isSingleStickerContent(content: string): boolean {
  const t = content.trim();
  if (!t || t.length > 64) return false;
  try {
    const seg = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)];
    return seg.length === 1;
  } catch {
    return false;
  }
}

/**
 * Если UI (например :5173) и API (:3000) на разных origin, <img>/<audio> не шлют Bearer —
 * встраиваемые медиа с /files/… не открываются. Тогда подгружаем байты через fetch + Authorization → blob:.
 * Внешние presigned URL и тот же origin, что у страницы, оставляем прямой ссылкой.
 *
 * Для /files/access/ нельзя начинать с прямого URL: первый запрос без заголовка даст 401 и плеер/img «зависнут».
 */
function initialBlobMediaSrc(downloadUrl: string | null | undefined, token: string | null): string {
  const u = normalizeDownloadUrl(downloadUrl);
  if (!u) return "";
  if (token && isFilesAccessProxyUrl(u)) return "";
  return u;
}

function useAuthenticatedBlobMediaUrl(downloadUrl: string | null | undefined, token: string | null): string {
  const [src, setSrc] = useState(() => initialBlobMediaSrc(downloadUrl, token));

  useEffect(() => {
    const u = normalizeDownloadUrl(downloadUrl);
    if (!u) {
      setSrc("");
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    const cleanup = () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };

    const base = API_BASE.replace(/\/$/, "");
    const isOurApi = Boolean(token && base) && (u === base || u.startsWith(`${base}/`));
    const pageOrigin = typeof window !== "undefined" ? window.location.origin : "";

    async function toBlob(getRes: () => Promise<Response>): Promise<boolean> {
      try {
        const r = await getRes();
        if (!r.ok || cancelled) return false;
        let blob = await r.blob();
        const ct = r.headers.get("content-type")?.split(";")[0]?.trim();
        if (ct && !blob.type) {
          blob = new Blob([blob], { type: ct });
        }
        if (cancelled) return false;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
        return true;
      } catch {
        return false;
      }
    }

    (async () => {
      let pathname = "";
      try {
        pathname = new URL(u).pathname;
      } catch {
        pathname = "";
      }
      const isAccessProxy = pathname.includes("/files/access/");
      if (token && isAccessProxy) {
        if (await toBlob(() => fetch(u, { headers: { authorization: `Bearer ${token}` } }))) return;
        if (!cancelled) setSrc("");
        return;
      } else if (isOurApi && pageOrigin && !u.startsWith(pageOrigin)) {
        if (await toBlob(() => fetch(u, { headers: { authorization: `Bearer ${token}` } }))) return;
      } else if (!isOurApi && /^https?:\/\//i.test(u) && pageOrigin && !u.startsWith(pageOrigin)) {
        if (await toBlob(() => fetch(u, { mode: "cors", credentials: "omit" }))) return;
      }
      if (!cancelled) setSrc(u);
    })();

    return cleanup;
  }, [downloadUrl, token]);

  return src;
}

function ChatAttachmentImage(props: {
  downloadUrl: string | null | undefined;
  token: string | null;
  alt: string;
  className?: string;
  fileId?: string;
  onNeedsUrlRefresh?: (fileId: string) => void;
}) {
  const src = useAuthenticatedBlobMediaUrl(props.downloadUrl, props.token);
  return (
    <img
      src={src}
      alt={props.alt}
      className={props.className}
      loading="lazy"
      onError={() => {
        if (props.fileId && props.onNeedsUrlRefresh) props.onNeedsUrlRefresh(props.fileId);
      }}
    />
  );
}

/** Плеер с blob: после fetch — `src` на `<audio>`, иначе Safari/Chrome не подхватывают `<source>` после 401 на первом URL. */
function ChatAttachmentAudio(props: {
  messageKey: string;
  downloadUrl: string | null | undefined;
  token: string | null;
  className?: string;
}) {
  const src = useAuthenticatedBlobMediaUrl(props.downloadUrl, props.token);
  return (
    <audio
      className={props.className}
      controls
      preload="auto"
      playsInline
      key={`${props.messageKey}-${src ? "ready" : "pending"}`}
      src={src || undefined}
    />
  );
}

export default function App() {
  const [organizationId, setOrganizationId] = useState(() => initialSession?.organizationId ?? "");
  const [organizationCode, setOrganizationCode] = useState("");
  const [orgBrandName, setOrgBrandName] = useState("");
  const [orgBrandLogoUrl, setOrgBrandLogoUrl] = useState("");
  const [infoPanelGroupPickUserId, setInfoPanelGroupPickUserId] = useState("");
  const [infoPanelChannelPickUserId, setInfoPanelChannelPickUserId] = useState("");
  const [infoPanelMembersMsg, setInfoPanelMembersMsg] = useState("");
  const [loginIdentifier, setLoginIdentifier] = useState("admin@seed.local");
  const [password, setPassword] = useState("SeedPass123!");
  const [otpCode, setOtpCode] = useState("");
  const [pendingEmailOtp, setPendingEmailOtp] = useState<{ challengeId: string; emailMasked?: string } | null>(null);
  const [workspaceId, setWorkspaceId] = useState(() => initialSession?.workspaceId ?? "");

  const [token, setToken] = useState(() => initialSession?.token ?? "");
  useEffect(() => {
    gqlAuthTokenRef.current = token;
  }, [token]);
  const [userId, setUserId] = useState(() => initialSession?.userId ?? "");
  const [viewerRole, setViewerRole] = useState<"owner" | "admin" | "manager" | "employee" | "guest" | "">(
    () => (initialSession?.viewerRole as any) ?? "",
  );
  const [systemAccessLevel, setSystemAccessLevel] = useState<"platform" | "organization" | "basic" | "">(
    () => (initialSession?.systemAccessLevel as any) ?? "",
  );

  const [mode, setMode] = useState<"channels" | "groups" | "dms">("channels");
  /** Список слева: все чаты сразу или только один тип */
  const [chatListScope, setChatListScope] = useState<"all" | "dms" | "groups" | "channels">(() => {
    try {
      const isMobile = typeof window !== "undefined" && window.innerWidth < 800;
      const v = localStorage.getItem("tg:chatListScope");
      if (isMobile) return "all";
      return (v === "all" || v === "dms" || v === "groups" || v === "channels" ? v : "all") as any;
    } catch {
      return "all";
    }
  });
  const [chatListFilterOpen, setChatListFilterOpen] = useState(false);
  const chatListFilterAnchorRef = useRef<HTMLDivElement | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState("");
  const [groupChats, setGroupChats] = useState<GroupChat[]>([]);
  const groupChatsRef = useRef(groupChats);
  useEffect(() => {
    groupChatsRef.current = groupChats;
  }, [groupChats]);
  const [activeGroupChatId, setActiveGroupChatId] = useState("");
  const [directChats, setDirectChats] = useState<DirectChat[]>([]);
  const [activeDirectChatId, setActiveDirectChatId] = useState("");
  const modeRef = useRef(mode);
  const activeChannelIdRef = useRef(activeChannelId);
  const activeGroupChatIdRef = useRef(activeGroupChatId);
  const activeDirectChatIdRef = useRef(activeDirectChatId);
  const myAccountEmailRef = useRef("");
  const lastDeepLinkHashRef = useRef("");

  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [replyTo, setReplyTo] = useState<{ id: string; preview: string } | null>(null);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [showPins, setShowPins] = useState(false);
  const [forwardSelecting, setForwardSelecting] = useState(false);
  const [forwardSelectedIds, setForwardSelectedIds] = useState<Set<string>>(new Set());
  const [showForwardPicker, setShowForwardPicker] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [webrtcDiagOpen, setWebrtcDiagOpen] = useState(false);
  const [webrtcDiagLines, setWebrtcDiagLines] = useState<string[]>([]);
  const webrtcDiagPcRef = useRef<RTCPeerConnection | null>(null);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockedRef = useRef(false);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    return localStorage.getItem("tg:theme") === "light" ? "light" : "dark";
  });
  const [browserNotify, setBrowserNotify] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      if (typeof Notification === "undefined") return false;
      const raw = localStorage.getItem("tg:browserNotify");
      if (raw === "0") return false;
      if (raw === "1") return true;
      return true;
    } catch {
      return true;
    }
  });
  const browserNotifyRef = useRef(browserNotify);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [newChatMenuOpen, setNewChatMenuOpen] = useState(false);
  const [newThingWizardKind, setNewThingWizardKind] = useState<null | "dm" | "group">(null);
  const [wizardUserQuery, setWizardUserQuery] = useState("");
  const [wizardSelectedUserIds, setWizardSelectedUserIds] = useState<string[]>([]);
  const [wizardGroupName, setWizardGroupName] = useState("Новая группа");
  const [wizardBusy, setWizardBusy] = useState(false);
  const [wizardError, setWizardError] = useState("");
  const [showRightPanel, setShowRightPanel] = useState(false);
  const [infoPanelSection, setInfoPanelSection] = useState<
    "about" | "photos" | "files" | "voice" | "links" | "notify"
  >("about");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [viewportW, setViewportW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1280));
  const [authError, setAuthError] = useState("");
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [chatSearch, setChatSearch] = useState("");
  const [showCompanyCabinet, setShowCompanyCabinet] = useState(false);
  // Админ-страница "Пользователи организации" отключена по требованию
  const [showUserCabinet, setShowUserCabinet] = useState(false);
  const [companyUserQuery, setCompanyUserQuery] = useState("");
  const [companyRoleFilter, setCompanyRoleFilter] = useState<"all" | "owner" | "admin" | "manager" | "employee" | "guest">("all");
  const [companyActionMsg, setCompanyActionMsg] = useState("");
  const [adminCreateEmail, setAdminCreateEmail] = useState("");
  const [adminCreateLastName, setAdminCreateLastName] = useState("");
  const [adminCreateFirstName, setAdminCreateFirstName] = useState("");
  const [adminCreateMiddleName, setAdminCreateMiddleName] = useState("");
  const [adminCreatePassword, setAdminCreatePassword] = useState("");
  const [adminCreatePhone, setAdminCreatePhone] = useState("");
  const [adminCreateDepartment, setAdminCreateDepartment] = useState("");
  const [adminCreateRole, setAdminCreateRole] = useState<"owner" | "admin" | "manager" | "employee" | "guest">("employee");
  const [chatPreviewByKey, setChatPreviewByKey] = useState<Record<string, { text: string; at: string }>>({});
  const [chatError, setChatError] = useState("");
  const [pendingCallDeepLink, setPendingCallDeepLink] = useState(false);
  const [pendingGroupCallDeepLink, setPendingGroupCallDeepLink] = useState(false);
  const [myProfileId, setMyProfileId] = useState("");
  const [myProfileEmail, setMyProfileEmail] = useState("");
  /** Email текущего пользователя для оптимистичных сообщений (после загрузки профиля — из API). */
  const selfAuthorEmail = useMemo(
    () => myProfileEmail.trim() || (loginIdentifier.includes("@") ? loginIdentifier.trim() : ""),
    [myProfileEmail, loginIdentifier],
  );
  /** Сравнение «моё сообщение» в ленте — по email из профиля после загрузки. */
  const myAccountEmailForMessages = useMemo(
    () => myProfileEmail.trim() || selfAuthorEmail,
    [myProfileEmail, selfAuthorEmail],
  );
  const isMyMessageEmail = useCallback(
    (email: string | undefined | null) =>
      !!email &&
      !!myAccountEmailForMessages &&
      String(email).trim().toLowerCase() === myAccountEmailForMessages.trim().toLowerCase(),
    [myAccountEmailForMessages],
  );
  useEffect(() => {
    modeRef.current = mode;
    activeChannelIdRef.current = activeChannelId;
    activeGroupChatIdRef.current = activeGroupChatId;
    activeDirectChatIdRef.current = activeDirectChatId;
    myAccountEmailRef.current = myAccountEmailForMessages;
  }, [mode, activeChannelId, activeGroupChatId, activeDirectChatId, myAccountEmailForMessages]);
  useEffect(() => {
    browserNotifyRef.current = browserNotify;
    try {
      localStorage.setItem("tg:browserNotify", browserNotify ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [browserNotify]);

  /** PWA на ПК/Android: один раз авто-запрос разрешения. На iPhone запрос без нажатия обычно игнорируется — там баннер с кнопкой «Разрешить». */
  useEffect(() => {
    if (!token) return;
    if (!isStandaloneWebApp()) return;
    if (isIosLikeBrowser()) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "default") return;
    try {
      if (localStorage.getItem("tg:pwaNotifyRequested") === "1") return;
    } catch {
      /* ignore */
    }
    const tid = window.setTimeout(() => {
      void Notification.requestPermission().then((r) => {
        try {
          localStorage.setItem("tg:pwaNotifyRequested", "1");
        } catch {
          /* ignore */
        }
        if (r === "granted") setBrowserNotify(true);
      });
    }, 1500);
    return () => window.clearTimeout(tid);
  }, [token]);

  /** Почему на телефоне «не включаются» уведомления: iOS Safari в вкладке часто без Notification API; нужен PWA на экран «Домой». */
  const browserNotifyHint = useMemo(() => {
    if (typeof window === "undefined") return "";
    if (!window.isSecureContext) return "Нужен адрес по HTTPS — иначе браузер не покажет уведомления.";
    if (typeof Notification === "undefined") {
      const ua = navigator.userAgent || "";
      if (/iPhone|iPad|iPod/i.test(ua)) {
        return "На iPhone/iPad в Safari во вкладке веб-уведомления обычно недоступны. Добавьте сайт на экран «Домой» (Поделиться → На экран «Домой»), откройте ярлык — там запрос разрешения возможен (iOS 16.4+). Либо проверьте в Chrome на Android.";
      }
      return "Этот браузер не отдаёт API уведомлений для сайта. Попробуйте Chrome на Android или другой браузер.";
    }
    if (Notification.permission === "denied") {
      return "Разрешение заблокировано. Откройте настройки сайта в браузере и включите «Уведомления», затем обновите страницу.";
    }
    return "";
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("tg:chatListScope", chatListScope);
    } catch {
      /* ignore */
    }
  }, [chatListScope]);

  // Deep-link: #dm=<directChatId>&call=1 | #group=<groupChatId>&gcall=1
  useEffect(() => {
    if (!token) return;
    const onHash = () => {
      const raw = typeof window !== "undefined" ? String(window.location.hash || "") : "";
      if (!raw || raw === lastDeepLinkHashRef.current) return;
      if (!raw.startsWith("#")) return;
      const params = new URLSearchParams(raw.slice(1));
      const dm = params.get("dm");
      const call = params.get("call");
      const group = params.get("group");
      const gcall = params.get("gcall");
      if (group) {
        lastDeepLinkHashRef.current = raw;
        void (async () => {
          try {
            await openChatFromList(`g:${group}`);
            setPendingGroupCallDeepLink(gcall === "1");
            setPendingCallDeepLink(false);
          } catch {
            /* ignore */
          }
        })();
        return;
      }
      if (!dm) return;
      lastDeepLinkHashRef.current = raw;
      void (async () => {
        try {
          await openChatFromList(`d:${dm}`);
          setPendingGroupCallDeepLink(false);
          // На мобильных браузерах getUserMedia часто запрещён без явного клика пользователя.
          // Поэтому deep-link только открывает чат и показывает кнопку "Начать звонок".
          setPendingCallDeepLink(call === "1");
        } catch {
          /* ignore */
        }
      })();
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [token]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
    try {
      localStorage.setItem("tg:theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  const [profileFirstName, setProfileFirstName] = useState("");
  const [profileLastName, setProfileLastName] = useState("");
  const [profileMiddleName, setProfileMiddleName] = useState("");
  const [profileBirthDate, setProfileBirthDate] = useState(""); // yyyy-mm-dd для input type=date
  const [profileAvatarUrl, setProfileAvatarUrl] = useState("");
  const [profileStatusText, setProfileStatusText] = useState("");
  const [profileTitle, setProfileTitle] = useState("");
  const [profileDepartment, setProfileDepartment] = useState("");
  const [profilePhone, setProfilePhone] = useState("");
  const [profileMsg, setProfileMsg] = useState("");
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [chatMetaNameDraft, setChatMetaNameDraft] = useState("");
  const [chatMetaAvatarData, setChatMetaAvatarData] = useState("");
  const [chatMetaMsg, setChatMetaMsg] = useState("");
  const [infoPanelChannelMembers, setInfoPanelChannelMembers] = useState<
    { id: string; email: string; firstName?: string | null; middleName?: string | null; lastName?: string | null }[]
  >([]);
  const [stickerCatalog, setStickerCatalog] = useState(defaultStickerCatalog);
  const [installedStickerPackIds, setInstalledStickerPackIds] = useState<string[]>([]);
  const [activeStickerPackId, setActiveStickerPackId] = useState(defaultStickerCatalog[0].id);
  const [unreadByKey, setUnreadByKey] = useState<Record<string, number>>({});
  const [pinnedChatByKey, setPinnedChatByKey] = useState<Record<string, boolean>>({});
  const [pinnedOrderByKey, setPinnedOrderByKey] = useState<Record<string, number>>({});
  const [dragPinnedKey, setDragPinnedKey] = useState<string>("");
  const [dragOverPinnedKey, setDragOverPinnedKey] = useState<string>("");
  /** Ключ чата → ISO до какого времени без уведомлений, либо `"forever"` */
  const [chatMuteMap, setChatMuteMap] = useState<Record<string, string>>({});
  const chatMuteMapRef = useRef<Record<string, string>>({});
  useEffect(() => {
    chatMuteMapRef.current = chatMuteMap;
  }, [chatMuteMap]);
  const [archivedChatByKey, setArchivedChatByKey] = useState<Record<string, boolean>>({});
  const [chatFolder, setChatFolder] = useState<"all" | "unread" | "archived">("all");
  const [userChatFolderLayout, setUserChatFolderLayout] = useState<UserChatFolderLayout>(() => loadChatFolders());
  const chatFoldersHydratedRef = useRef(false);
  const chatFoldersSkipServerSaveRef = useRef(false);
  const [chatFoldersEditorOpen, setChatFoldersEditorOpen] = useState(false);
  const [newChatFolderDraft, setNewChatFolderDraft] = useState("");
  /** Какие папки в списке чатов развёрнуты (строки как у чата). При смене активного чата сбрасываются. */
  const [expandedChatFolderIds, setExpandedChatFolderIds] = useState<Record<string, boolean>>({});
  /** Внутренний групповой mesh WebRTC (несколько peer connections; лимит см. GROUP_MESH_MAX_PEERS). */
  const [groupMeshUi, setGroupMeshUi] = useState<null | {
    title: string;
    groupChatId: string;
    audioOnly: boolean;
    localStream: MediaStream;
    remotes: Record<string, MediaStream | undefined>;
    hangup: () => void;
  }>(null);
  const [groupMeshMediaTick, setGroupMeshMediaTick] = useState(0);
  /** Крупное видео внизу; миниатюры сверху — при клике переключают «экран». */
  const [groupMeshSpotlightPeerId, setGroupMeshSpotlightPeerId] = useState<string | null>(null);
  const [groupMeshHands, setGroupMeshHands] = useState<Record<string, boolean>>({});
  const [groupCallPreJoinMic, setGroupCallPreJoinMic] = useState(true);
  const [groupCallPreJoinCam, setGroupCallPreJoinCam] = useState(true);
  /** Входящий offer группового mesh — подключение только по кнопке «Присоединиться» */
  const [pendingGroupMeshIncoming, setPendingGroupMeshIncoming] = useState<any>(null);
  const pendingGroupMeshIncomingRef = useRef<any>(null);
  useEffect(() => {
    pendingGroupMeshIncomingRef.current = pendingGroupMeshIncoming;
  }, [pendingGroupMeshIncoming]);
  /** Созвон «идёт» (приглашение или мы в mesh) — для кнопки на карточке в ленте */
  const [groupCallLiveAt, setGroupCallLiveAt] = useState<Record<string, number>>({});
  /** Модалка мик/кам с карточки «Созвон» в сообщении */
  const [inviteCardJoinModal, setInviteCardJoinModal] = useState<null | { groupChatId: string }>(null);
  const groupMeshSessionRef = useRef<GroupMeshSession | null>(null);
  const groupMeshUiRef = useRef<typeof groupMeshUi>(null);
  useEffect(() => {
    groupMeshUiRef.current = groupMeshUi;
  }, [groupMeshUi]);
  useEffect(() => {
    if (!groupMeshUi) {
      setGroupMeshSpotlightPeerId(null);
      setGroupMeshHands({});
    }
  }, [groupMeshUi]);
  const groupMeshStagePeerId = useMemo(() => {
    if (!groupMeshUi || groupMeshUi.audioOnly) return null;
    const ids = Object.keys(groupMeshUi.remotes).sort();
    if (ids.length === 0) return null;
    if (groupMeshSpotlightPeerId && groupMeshUi.remotes[groupMeshSpotlightPeerId]) return groupMeshSpotlightPeerId;
    return ids[0];
  }, [groupMeshUi, groupMeshSpotlightPeerId]);
  const groupMeshJoiningRef = useRef(false);
  const meshSignalIceBufferRef = useRef<Record<string, unknown[]>>({});
  const meshOfferWhileJoiningRef = useRef<unknown[]>([]);
  const joinGroupMeshFromPeerOfferRef = useRef<(data: any, mediaPrefs?: { mic: boolean; cam: boolean }) => Promise<void>>(
    async () => {},
  );
  const sidebarChatsScrollRef = useRef<HTMLDivElement | null>(null);
  const pullRefreshLockRef = useRef(false);
  const refreshChatsAndPresenceRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    saveChatFolders(userChatFolderLayout);
  }, [userChatFolderLayout]);

  useEffect(() => {
    if (!chatFoldersHydratedRef.current || !token || !userId) return;
    if (chatFoldersSkipServerSaveRef.current) {
      chatFoldersSkipServerSaveRef.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      void gql<{ updateUser: { id: string } }>(
        `mutation($input: UpdateUserInput!) { updateUser(input: $input) { id } }`,
        { input: { userId, chatFoldersJson: JSON.stringify(userChatFolderLayout) } },
        token,
      ).catch(() => {});
    }, 1400);
    return () => window.clearTimeout(t);
  }, [userChatFolderLayout, token, userId]);
  const [chatMenu, setChatMenu] = useState<null | { x: number; y: number; key: string; sub: "main" | "notify" | "folder" }>(null);
  const chatMenuRef = useRef<HTMLDivElement | null>(null);
  /** null | group — mesh; dm — личный 1:1 */
  const [callJoinModalKind, setCallJoinModalKind] = useState<null | "group" | "dm">(null);
  const [photoLightboxUrl, setPhotoLightboxUrl] = useState<string | null>(null);
  /** В группе: сначала список участников, затем выбор аудио/видео */
  const [chatMetaPopoverOpen, setChatMetaPopoverOpen] = useState(false);
  const callMenuWrapRef = useRef<HTMLDivElement | null>(null);
  const [msgMenu, setMsgMenu] = useState<null | { x: number; y: number; messageId: string }>(null);
  const [threadReadByKey, setThreadReadByKey] = useState<Record<string, Record<string, string>>>({});
  const [readReceiptModalForId, setReadReceiptModalForId] = useState<string | null>(null);
  const [readReceiptUsers, setReadReceiptUsers] = useState<
    { id: string; email: string; firstName?: string | null; lastName?: string | null }[]
  >([]);
  const totalUnread = useMemo(
    () => Object.values(unreadByKey).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0),
    [unreadByKey],
  );
  /** Значок на иконке PWA (Chrome/Edge/Android): непрочитанные. */
  useEffect(() => {
    if (!isStandaloneWebApp()) return;
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!nav.setAppBadge) return;
    void (async () => {
      try {
        if (totalUnread > 0) {
          const n = totalUnread > 99 ? 99 : totalUnread;
          await nav.setAppBadge(n);
        } else {
          await nav.clearAppBadge?.();
        }
      } catch {
        /* ignore */
      }
    })();
  }, [totalUnread]);
  const [threadSearchQ, setThreadSearchQ] = useState("");
  const [threadSearchHits, setThreadSearchHits] = useState<Message[]>([]);
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [webrtcUi, setWebrtcUi] = useState<null | {
    remoteStream: MediaStream | null;
    localStream: MediaStream;
    hangup: () => void;
    audioOnly: boolean;
    activeCall: ActiveCall;
    callPeerId: string;
  }>(null);
  const [webrtcMicOn, setWebrtcMicOn] = useState(true);
  const [webrtcCamOn, setWebrtcCamOn] = useState(true);
  const [webrtcScreenSharing, setWebrtcScreenSharing] = useState(false);
  const [webrtcPeerHandRaised, setWebrtcPeerHandRaised] = useState(false);
  const [webrtcLocalHandRaised, setWebrtcLocalHandRaised] = useState(false);
  const [incomingCall, setIncomingCall] = useState<null | { fromUserId: string; offerSdp: string; audioOnly: boolean }>(
    null,
  );
  const incomingCallRef = useRef<null | { fromUserId: string; offerSdp: string; audioOnly: boolean }>(null);
  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);
  useEffect(() => {
    if (!webrtcUi || webrtcUi.audioOnly) return;
    const tick = () => setWebrtcScreenSharing(webrtcUi.activeCall.isScreenSharing());
    const id = window.setInterval(tick, 400);
    tick();
    return () => window.clearInterval(id);
  }, [webrtcUi]);

  /** Удалённое видео: video muted (иначе autoplay часто блокируется у инициатора) + отдельный audio с дорожками звука. */
  useEffect(() => {
    const stream = webrtcUi?.remoteStream ?? null;
    const videoEl = webrtcRemoteVideoRef.current;
    const audioEl = webrtcRemoteAudioRef.current;
    const audioOnly = !!webrtcUi?.audioOnly;
    const tryPlay = (el: HTMLMediaElement) => void el.play().catch(() => {});

    if (audioOnly) {
      if (videoEl) videoEl.srcObject = null;
      if (!audioEl) return;
      if (!stream) {
        audioEl.srcObject = null;
        return;
      }
      audioEl.srcObject = stream;
      tryPlay(audioEl);
      const onTrack = () => tryPlay(audioEl);
      stream.addEventListener("addtrack", onTrack);
      stream.addEventListener("removetrack", onTrack);
      return () => {
        stream.removeEventListener("addtrack", onTrack);
        stream.removeEventListener("removetrack", onTrack);
      };
    }

    if (!videoEl) return;
    if (!stream) {
      videoEl.srcObject = null;
      if (audioEl) audioEl.srcObject = null;
      return;
    }
    videoEl.srcObject = stream;
    try {
      videoEl.setAttribute("playsinline", "");
      videoEl.setAttribute("webkit-playsinline", "");
      videoEl.playsInline = true;
    } catch {
      /* ignore */
    }
    videoEl.muted = true;
    if (audioEl) {
      /** Полный поток в audio: отдельный MediaStream только из audio-треков иногда даёт тишину у инициатора. */
      audioEl.srcObject = stream;
      audioEl.muted = false;
      try {
        audioEl.volume = 1;
      } catch {
        /* ignore */
      }
    }
    const onMeta = () => {
      tryPlay(videoEl);
      if (audioEl) tryPlay(audioEl);
    };
    videoEl.addEventListener("loadedmetadata", onMeta);
    onMeta();
    const onTrack = () => {
      videoEl.srcObject = stream;
      if (audioEl) {
        audioEl.srcObject = stream;
        tryPlay(audioEl);
      }
      onMeta();
    };
    stream.addEventListener("addtrack", onTrack);
    stream.addEventListener("removetrack", onTrack);
    for (const t of stream.getTracks()) {
      t.addEventListener("unmute", onTrack);
      t.addEventListener("mute", onTrack);
    }
    const playKick = window.setInterval(() => {
      tryPlay(videoEl);
      if (audioEl) tryPlay(audioEl);
    }, 1200);
    return () => {
      window.clearInterval(playKick);
      videoEl.removeEventListener("loadedmetadata", onMeta);
      stream.removeEventListener("addtrack", onTrack);
      stream.removeEventListener("removetrack", onTrack);
      for (const t of stream.getTracks()) {
        t.removeEventListener("unmute", onTrack);
        t.removeEventListener("mute", onTrack);
      }
    };
  }, [
    webrtcUi?.audioOnly,
    webrtcUi?.remoteStream,
    webrtcUi?.remoteStream
      ? webrtcUi.remoteStream
          .getTracks()
          .map((t) => `${t.id}:${t.readyState}:${t.muted ? "m" : "u"}`)
          .join("|")
      : "",
  ]);

  /** Локальное превью в PWA/iOS: надёжнее держать srcObject и playsInline в эффекте. */
  useEffect(() => {
    if (!webrtcUi || webrtcUi.audioOnly) return;
    const stream = webrtcUi.localStream;
    const el = webrtcLocalVideoRef.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    try {
      el.playsInline = true;
      el.setAttribute("webkit-playsinline", "");
    } catch {
      /* ignore */
    }
    const bump = () => void el.play().catch(() => {});
    bump();
    requestAnimationFrame(bump);
    window.setTimeout(bump, 120);
    const tracks = stream.getVideoTracks();
    for (const t of tracks) {
      t.addEventListener("unmute", bump);
      t.addEventListener("mute", bump);
      t.addEventListener("ended", bump);
    }
    return () => {
      for (const t of tracks) {
        t.removeEventListener("unmute", bump);
        t.removeEventListener("mute", bump);
        t.removeEventListener("ended", bump);
      }
    };
  }, [
    webrtcUi?.audioOnly,
    webrtcUi?.localStream,
    webrtcUi?.localStream
      ? webrtcUi.localStream
          .getVideoTracks()
          .map((t) => `${t.id}:${t.readyState}:${t.muted ? "m" : "u"}`)
          .join("|")
      : "",
  ]);
  const userIdRef = useRef("");
  const directChatsRef = useRef<DirectChat[]>([]);
  const webrtcBusyRef = useRef(false);
  /** Пока звонок не принят, ICE только здесь — обработчик webrtcDm ещё не подписан. */
  const incomingCallIceBufferRef = useRef<Array<{ candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }>>(
    [],
  );
  const webrtcPeerRef = useRef("");
  const webrtcRemoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const webrtcLocalVideoRef = useRef<HTMLVideoElement | null>(null);
  /** Аудиозвонок: отдельный audio-элемент надёжнее скрытого video в части браузеров/PWA. */
  const webrtcRemoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [reactionPopover, setReactionPopover] = useState<null | { messageId: string; top: number; left: number }>(null);
  const reactionPopoverRef = useRef<HTMLDivElement | null>(null);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [voiceHoldMs, setVoiceHoldMs] = useState(0);
  const [chatFileDragActive, setChatFileDragActive] = useState(false);
  const [chatDragPreview, setChatDragPreview] = useState<
    null | { kind: "image"; url: string; name: string } | { kind: "file"; name: string; ext: string; mime: string }
  >(null);
  const chatDragPreviewKeyRef = useRef<string>("");
  const [users, setUsers] = useState<
    {
      id: string;
      email: string;
      avatarUrl?: string | null;
      firstName?: string | null;
      middleName?: string | null;
      lastName?: string | null;
      birthDate?: string | null;
      role?: "owner" | "admin" | "manager" | "employee" | "guest" | null;
      department?: string | null;
      status?: string | null;
      phone?: string | null;
      lastSeen?: string | null;
    }[]
  >([]);
  const usersRef = useRef(users);
  useEffect(() => {
    usersRef.current = users;
  }, [users]);
  const companyUsersFiltered = useMemo(() => {
    const q = companyUserQuery.trim().toLowerCase();
    return users.filter((u) => {
      const roleOk = companyRoleFilter === "all" ? true : (u.role ?? "employee") === companyRoleFilter;
      const textOk = !q
        ? true
        : `${u.email} ${u.phone ?? ""} ${u.firstName ?? ""} ${u.lastName ?? ""} ${u.department ?? ""}`.toLowerCase().includes(q);
      return roleOk && textOk;
    });
  }, [users, companyUserQuery, companyRoleFilter]);

  const newThingWizardUsers = useMemo(() => {
    const q = wizardUserQuery.trim().toLowerCase();
    return users
      .filter((u) => (newThingWizardKind === "dm" ? true : u.id !== userId))
      .filter(
        (u) =>
          !q ||
          `${u.email} ${u.firstName ?? ""} ${u.lastName ?? ""} ${u.department ?? ""}`.toLowerCase().includes(q),
      )
      .slice()
      .sort((a, b) => a.email.localeCompare(b.email));
  }, [users, userId, wizardUserQuery, newThingWizardKind]);

  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, { status: string; lastSeen?: string }>>({});
  const presenceByUserIdRef = useRef(presenceByUserId);
  useEffect(() => {
    presenceByUserIdRef.current = presenceByUserId;
  }, [presenceByUserId]);
  const loadUsersRef = useRef<((tokenOverride?: string, orgIdOverride?: string) => Promise<void>) | null>(null);
  /** Внутриприложенческое всплывающее уведомление, если OS Notification недоступен или не сработал. */
  const [appToast, setAppToast] = useState<null | { text: string; id: number }>(null);
  const pushAppToast = useCallback((text: string) => {
    const id = Date.now();
    setAppToast({ text, id });
    window.setTimeout(() => {
      setAppToast((t) => (t?.id === id ? null : t));
    }, 5200);
  }, []);
  const isCompanyAdmin = viewerRole === "owner" || viewerRole === "admin";
  useEffect(() => {
    if (!isCompanyAdmin) {
      setShowLogs(false);
    }
  }, [isCompanyAdmin]);
  const orgChatLogoCss = useMemo(() => {
    if (!orgBrandLogoUrl?.trim()) return "";
    const u = normalizeDownloadUrl(orgBrandLogoUrl.trim());
    if (!u) return "";
    return `url(${JSON.stringify(u)})`;
  }, [orgBrandLogoUrl]);

  const orgBrandDisplay = orgBrandName.trim() === "Seed Org" ? "" : orgBrandName.trim();

  const displayOrganizationId = useMemo(() => {
    const code = organizationCode.trim().toUpperCase();
    if (/^ID\d{6}$/.test(code)) return code;
    try {
      const rawCodeMap = localStorage.getItem("tg:orgCodeBindings");
      const codeMap = rawCodeMap ? (JSON.parse(rawCodeMap) as Record<string, string>) : {};
      const found = Object.entries(codeMap).find(([, id]) => id === organizationId)?.[0] || "";
      if (/^ID\d{6}$/.test(found)) return found;
    } catch {
      // ignore localStorage read errors
    }
    return organizationId || "—";
  }, [organizationCode, organizationId]);
  const accessByRole: Record<string, string[]> = {
    owner: ["Полный доступ", "Управление организацией", "Назначение ролей"],
    admin: ["Администрирование пользователей", "Управление настройками"],
    manager: ["Работа с каналами и отделом", "Управление профилем отдела", "Созвоны и видео встречи"],
    employee: ["Чаты и каналы", "Создание групп/каналов", "Личные сообщения", "Созвоны и видео встречи"],
    guest: ["Ограниченный доступ к чатам"],
  };
  const isBasicSystemAccess = systemAccessLevel === "basic";
  const canReadChats = ["owner", "admin", "manager", "employee", "guest"].includes(viewerRole);
  const canWriteChats =
    !isBasicSystemAccess && ["owner", "admin", "manager", "employee"].includes(viewerRole);
  const canCreateChannelsAndGroups =
    !isBasicSystemAccess && ["owner", "admin", "manager", "employee"].includes(viewerRole);
  const canStartCalls =
    !isBasicSystemAccess && ["owner", "admin", "manager", "employee"].includes(viewerRole);

  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  const pendingFileHydrateCount = useMemo(
    () =>
      messages.filter(
        (m) =>
          (m.type === "voice" || m.type === "file") &&
          Boolean(m.file?.id) &&
          !m.file?.downloadUrl &&
          !m._localFileState,
      ).length,
    [messages],
  );

  useEffect(() => {
    if (!isRecordingVoice) {
      setVoiceHoldMs(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setVoiceHoldMs(Date.now() - startedAt);
    }, 100);
    return () => window.clearInterval(timer);
  }, [isRecordingVoice]);

  /** Не вешаем pointerup на window — после клика «старт» сразу приходит отпускание и рвёт запись. Только Esc и сворачивание вкладки. */
  useEffect(() => {
    if (!isRecordingVoice) return;
    const end = () => {
      stopVoiceRecordRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") end();
    };
    window.addEventListener("keydown", onKey, true);
    const onVis = () => {
      if (document.visibilityState === "hidden") end();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [isRecordingVoice]);

  const activeChannel = useMemo(() => channels.find((c) => c.id === activeChannelId), [channels, activeChannelId]);
  const activeGroupChat = useMemo(() => groupChats.find((g) => g.id === activeGroupChatId), [groupChats, activeGroupChatId]);
  const activeDirectChat = useMemo(() => directChats.find((d) => d.id === activeDirectChatId), [directChats, activeDirectChatId]);

  const groupCallInviteUrlForHeader = useMemo(() => {
    if (!activeGroupChat?.id) return "";
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}#group=${encodeURIComponent(activeGroupChat.id)}&gcall=1`;
  }, [activeGroupChat?.id]);

  const canEditActiveGroupMeta = useMemo(() => {
    if (!activeGroupChatId || !userId) return false;
    const g = groupChats.find((x) => x.id === activeGroupChatId);
    if (!g?.createdByUserId) return false;
    return g.createdByUserId === userId || isCompanyAdmin;
  }, [groupChats, activeGroupChatId, userId, isCompanyAdmin]);

  const canEditActiveChannelMeta = useMemo(() => {
    if (!activeChannelId || !userId) return false;
    const c = channels.find((x) => x.id === activeChannelId);
    if (!c?.createdByUserId) return false;
    return c.createdByUserId === userId || isCompanyAdmin;
  }, [channels, activeChannelId, userId, isCompanyAdmin]);

  useEffect(() => {
    if (mode === "groups" && activeGroupChat) {
      setChatMetaNameDraft(activeGroupChat.name);
      setChatMetaAvatarData(activeGroupChat.avatarUrl?.trim() ?? "");
    } else if (mode === "channels" && activeChannel) {
      setChatMetaNameDraft(activeChannel.name);
      setChatMetaAvatarData(activeChannel.avatarUrl?.trim() ?? "");
    } else {
      setChatMetaNameDraft("");
      setChatMetaAvatarData("");
    }
    setChatMetaMsg("");
  }, [mode, activeGroupChat, activeChannel]);

  useEffect(() => {
    if (!showRightPanel || !token || mode !== "channels" || !activeChannelId) {
      setInfoPanelChannelMembers([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await gql<{
          channelMembers: { id: string; email: string; firstName?: string | null; middleName?: string | null; lastName?: string | null }[];
        }>(
          `query($id: ID!) { channelMembers(channelId: $id) { id email firstName middleName lastName } }`,
          { id: activeChannelId },
          token,
        );
        if (!cancelled) setInfoPanelChannelMembers(data.channelMembers ?? []);
      } catch {
        if (!cancelled) setInfoPanelChannelMembers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showRightPanel, mode, activeChannelId, token]);

  useEffect(() => {
    setInfoPanelMembersMsg("");
  }, [mode, activeGroupChatId, activeChannelId]);

  function initials(s: string) {
    const v = (s || "").trim();
    if (!v) return "?";
    const parts = v.split(/[\s@._-]+/g).filter(Boolean);
    const a = parts[0]?.[0] ?? v[0];
    const b = parts[1]?.[0] ?? "";
    return (a + b).toUpperCase().slice(0, 2);
  }

  const chatSearchQ = chatSearch.trim().toLowerCase();
  const filteredChannels = useMemo(() => {
    if (!chatSearchQ) return channels;
    const needle = chatSearchQ.replace(/^#/, "").trim();
    if (!needle) return channels;
    return channels.filter((c) => {
      const name = c.name.toLowerCase();
      const typeStr = String(c.type ?? "").toLowerCase();
      return name.includes(needle) || typeStr.includes(needle);
    });
  }, [channels, chatSearchQ]);
  const filteredGroups = useMemo(() => {
    if (!chatSearchQ) return groupChats;
    return groupChats.filter((g) => g.name.toLowerCase().includes(chatSearchQ));
  }, [groupChats, chatSearchQ]);
  const filteredDMs = useMemo(() => {
    if (!chatSearchQ) return directChats;
    return directChats.filter((d) => {
      const key = `d:${d.id}`;
      const otherId = d.userIds.find((id) => id !== userId) ?? d.userIds[0] ?? "";
      const u = users.find((x) => x.id === otherId);
      const label = displayUserNameForSidebar(u, otherId || d.id);
      const preview = (chatPreviewByKey[key]?.text ?? "").toLowerCase();
      const hay = `${label} ${u?.email ?? ""} ${otherId} ${preview}`.toLowerCase();
      return hay.includes(chatSearchQ);
    });
  }, [directChats, users, userId, chatSearchQ, chatPreviewByKey]);

  function chatKeyFor(kind: "c" | "g" | "d", id: string) {
    return `${kind}:${id}`;
  }

  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  useEffect(() => {
    directChatsRef.current = directChats;
  }, [directChats]);

  async function mergeThreadReadStates(kind: "c" | "g" | "d", chatId: string) {
    if (!token || !chatId) return;
    try {
      const variables =
        kind === "c"
          ? { channelId: chatId, groupChatId: null, directChatId: null }
          : kind === "g"
            ? { channelId: null, groupChatId: chatId, directChatId: null }
            : { channelId: null, groupChatId: null, directChatId: chatId };
      const data = await gql<{
        threadReadStates: { userId: string; lastReadAt: string }[];
      }>(
        `query($channelId: ID, $groupChatId: ID, $directChatId: ID) {
          threadReadStates(channelId: $channelId, groupChatId: $groupChatId, directChatId: $directChatId) { userId lastReadAt }
        }`,
        variables,
        token,
      );
      const inner: Record<string, string> = {};
      for (const r of data.threadReadStates) inner[r.userId] = r.lastReadAt;
      setThreadReadByKey((prev) => ({ ...prev, [chatKeyFor(kind, chatId)]: inner }));
    } catch {
      /* ignore */
    }
  }

  function unreadFor(key: string) {
    return unreadByKey[key] ?? 0;
  }
  function isPinned(key: string) {
    return !!pinnedChatByKey[key];
  }
  function isMuted(key: string) {
    const v = chatMuteMap[key];
    if (!v) return false;
    if (v === "forever") return true;
    const t = Date.parse(v);
    if (Number.isNaN(t)) return false;
    return Date.now() < t;
  }
  function setChatMute(key: string, mode: "off" | "forever" | number) {
    setChatMuteMap((prev) => {
      const next = { ...prev };
      if (mode === "off") {
        delete next[key];
        return next;
      }
      if (mode === "forever") {
        next[key] = "forever";
        return next;
      }
      next[key] = new Date(Date.now() + mode * 3600 * 1000).toISOString();
      return next;
    });
  }
  function muteStatusLabel(key: string): string {
    const v = chatMuteMap[key];
    if (!v) return "Оповещения включены";
    if (v === "forever") return "Без звука навсегда";
    const t = Date.parse(v);
    if (Number.isNaN(t) || Date.now() >= t) return "Оповещения включены";
    try {
      return `Без звука до ${new Date(t).toLocaleString()}`;
    } catch {
      return "Без звука";
    }
  }
  function togglePin(key: string) {
    setPinnedChatByKey((prev) => {
      const nextPinned = !prev[key];
      if (nextPinned) {
        setPinnedOrderByKey((ord) => {
          const max = Math.max(0, ...Object.values(ord));
          return { ...ord, [key]: max + 1 };
        });
      }
      return { ...prev, [key]: nextPinned };
    });
  }
  function isArchived(key: string) {
    return !!archivedChatByKey[key];
  }
  function toggleArchive(key: string) {
    setArchivedChatByKey((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function removeChatFromList(key: string) {
    if (!window.confirm("Убрать чат из списка? Его можно снова открыть через вкладку «Архив».")) return;
    setArchivedChatByKey((prev) => ({ ...prev, [key]: true }));
    const [kind, id] = key.split(":");
    if (kind === "c" && id === activeChannelId) {
      setActiveChannelId("");
      setMessages([]);
    } else if (kind === "g" && id === activeGroupChatId) {
      setActiveGroupChatId("");
      setMessages([]);
    } else if (kind === "d" && id === activeDirectChatId) {
      setActiveDirectChatId("");
      setMessages([]);
    }
    setChatMenu(null);
  }

  function assignChatToFolderKey(chatKey: string, folderId: string | null) {
    setUserChatFolderLayout((prev) => {
      const assignment = { ...prev.assignment };
      if (folderId == null) delete assignment[chatKey];
      else assignment[chatKey] = folderId;
      return { ...prev, assignment };
    });
    setChatMenu(null);
  }
  function addNamedChatFolder(name: string) {
    const id = createFolderId();
    const trimmed = name.trim().slice(0, 64) || "Папка";
    setUserChatFolderLayout((prev) => ({
      ...prev,
      folders: [...prev.folders, { id, name: trimmed, order: prev.folders.length }],
    }));
  }
  function removeNamedChatFolder(folderId: string) {
    setUserChatFolderLayout((prev) => {
      const assignment = { ...prev.assignment };
      for (const k of Object.keys(assignment)) {
        if (assignment[k] === folderId) delete assignment[k];
      }
      return { ...prev, folders: prev.folders.filter((f) => f.id !== folderId), assignment };
    });
  }

  function reorderPinned(dragKey: string, targetKey: string) {
    if (!dragKey || !targetKey || dragKey === targetKey) return;
    const pinnedKeys = Object.keys(pinnedChatByKey).filter((k) => pinnedChatByKey[k]);
    const list = pinnedKeys
      .map((k) => ({ k, o: pinnedOrderByKey[k] ?? 999999 }))
      .sort((a, b) => a.o - b.o)
      .map((x) => x.k);
    const from = list.indexOf(dragKey);
    const to = list.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    list.splice(to, 0, list.splice(from, 1)[0]);
    const next: Record<string, number> = {};
    list.forEach((k, idx) => {
      next[k] = idx + 1;
    });
    setPinnedOrderByKey((prev) => ({ ...prev, ...next }));
  }
  function includeByFolder(key: string) {
    const unread = unreadFor(key) > 0;
    const archived = isArchived(key);
    if (chatFolder === "unread") return unread && !archived;
    if (chatFolder === "archived") return archived;
    return !archived;
  }

  function previewTimeMs(iso?: string) {
    if (!iso) return 0;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  }

  function compareChatsByPinThenRecency(ka: string, kb: string): number {
    const pinA = !!pinnedChatByKey[ka];
    const pinB = !!pinnedChatByKey[kb];
    const pinDiff = Number(pinB) - Number(pinA);
    if (pinDiff !== 0) return pinDiff;
    if (pinA && pinB) {
      return (pinnedOrderByKey[ka] ?? 999999) - (pinnedOrderByKey[kb] ?? 999999);
    }
    const ta = previewTimeMs(chatPreviewByKey[ka]?.at);
    const tb = previewTimeMs(chatPreviewByKey[kb]?.at);
    if (tb !== ta) return tb - ta;
    return ka.localeCompare(kb);
  }

  const orderedChannels = useMemo(
    () =>
      [...filteredChannels]
        .sort((a, b) => compareChatsByPinThenRecency(chatKeyFor("c", a.id), chatKeyFor("c", b.id)))
        .filter((c) => includeByFolder(chatKeyFor("c", c.id))),
    [filteredChannels, pinnedChatByKey, pinnedOrderByKey, archivedChatByKey, unreadByKey, chatFolder, chatPreviewByKey],
  );
  const orderedGroups = useMemo(
    () =>
      [...filteredGroups]
        .sort((a, b) => compareChatsByPinThenRecency(chatKeyFor("g", a.id), chatKeyFor("g", b.id)))
        .filter((g) => includeByFolder(chatKeyFor("g", g.id))),
    [filteredGroups, pinnedChatByKey, pinnedOrderByKey, archivedChatByKey, unreadByKey, chatFolder, chatPreviewByKey],
  );
  const orderedDMs = useMemo(
    () =>
      [...filteredDMs]
        .sort((a, b) => compareChatsByPinThenRecency(chatKeyFor("d", a.id), chatKeyFor("d", b.id)))
        .filter((d) => includeByFolder(chatKeyFor("d", d.id))),
    [filteredDMs, pinnedChatByKey, pinnedOrderByKey, archivedChatByKey, unreadByKey, chatFolder, chatPreviewByKey],
  );

  const unifiedChatRows = useMemo(() => {
    type Row =
      | { kind: "d"; d: (typeof orderedDMs)[number] }
      | { kind: "g"; g: (typeof orderedGroups)[number] }
      | { kind: "c"; c: (typeof orderedChannels)[number] };
    const rows: Row[] = [
      ...orderedDMs.map((d) => ({ kind: "d" as const, d })),
      ...orderedGroups.map((g) => ({ kind: "g" as const, g })),
      ...orderedChannels.map((c) => ({ kind: "c" as const, c })),
    ];
    rows.sort((a, b) => {
      const ka = a.kind === "d" ? chatKeyFor("d", a.d.id) : a.kind === "g" ? chatKeyFor("g", a.g.id) : chatKeyFor("c", a.c.id);
      const kb = b.kind === "d" ? chatKeyFor("d", b.d.id) : b.kind === "g" ? chatKeyFor("g", b.g.id) : chatKeyFor("c", b.c.id);
      return compareChatsByPinThenRecency(ka, kb);
    });
    return rows;
  }, [orderedDMs, orderedGroups, orderedChannels, pinnedChatByKey, pinnedOrderByKey, chatPreviewByKey]);

  const sidebarFolderLayout = useMemo(():
    | { mode: "flat"; rows: (typeof unifiedChatRows)[number][] }
    | {
        mode: "grouped";
        sections: { id: string; name: string; rows: (typeof unifiedChatRows)[number][] }[];
      } => {
    type Row = (typeof unifiedChatRows)[number];
    const keyOf = (r: Row) =>
      r.kind === "d" ? chatKeyFor("d", r.d.id) : r.kind === "g" ? chatKeyFor("g", r.g.id) : chatKeyFor("c", r.c.id);
    const st = userChatFolderLayout;
    const folderIdSet = new Set(st.folders.map((f) => f.id));
    const sortedFolders = [...st.folders].sort((a, b) => a.order - b.order);
    if (sortedFolders.length === 0) {
      return { mode: "flat" as const, rows: unifiedChatRows };
    }
    const sections: { id: string; name: string; rows: Row[] }[] = [];
    for (const f of sortedFolders) {
      const rows = unifiedChatRows.filter((row) => st.assignment[keyOf(row)] === f.id);
      if (rows.length === 0) continue;
      sections.push({ id: f.id, name: f.name, rows });
    }
    const unfiled = unifiedChatRows.filter((row) => {
      const k = st.assignment[keyOf(row)];
      return !k || !folderIdSet.has(k);
    });
    if (unfiled.length > 0) {
      const anyFoldered = sections.length > 0;
      sections.push({
        id: "__unfiled__",
        name: anyFoldered ? "Без папки" : "Чаты",
        rows: unfiled,
      });
    }
    return { mode: "grouped" as const, sections };
  }, [unifiedChatRows, userChatFolderLayout]);

  const activeChatKeyForPanel = useMemo(() => {
    if (mode === "channels" && activeChannelId) return chatKeyFor("c", activeChannelId);
    if (mode === "groups" && activeGroupChatId) return chatKeyFor("g", activeGroupChatId);
    if (mode === "dms" && activeDirectChatId) return chatKeyFor("d", activeDirectChatId);
    return "";
  }, [mode, activeChannelId, activeGroupChatId, activeDirectChatId]);

  const isSelfNotesActiveDm = useMemo(
    () =>
      mode === "dms" &&
      !!userId &&
      !!activeDirectChat &&
      activeDirectChat.userIds.length === 1 &&
      activeDirectChat.userIds[0] === userId,
    [mode, userId, activeDirectChat],
  );

  const dmCallStripVisible = useMemo(() => {
    if (mode !== "dms" || !activeDirectChat || isSelfNotesActiveDm) return false;
    const meshId = dmMeshGroupChatId(activeDirectChat.id);
    const t = groupCallLiveAt[meshId];
    if (t == null || Date.now() - t >= GROUP_CALL_INVITE_LIVE_MS) return false;
    if (groupMeshUi?.groupChatId === meshId) return false;
    return true;
  }, [mode, activeDirectChat, isSelfNotesActiveDm, groupCallLiveAt, groupMeshUi]);

  const dmPeerAvatarUrl = useMemo(() => {
    if (mode !== "dms" || isSelfNotesActiveDm || !activeDirectChat || !userId) return null;
    const otherId = activeDirectChat.userIds.find((id) => id !== userId) ?? activeDirectChat.userIds[0] ?? "";
    if (!otherId) return null;
    const u = users.find((x) => x.id === otherId);
    return u?.avatarUrl ? String(u.avatarUrl) : null;
  }, [mode, isSelfNotesActiveDm, activeDirectChat, userId, users]);

  const headerAvatarPhotoUrl = useMemo(() => {
    if (mode === "channels") return activeChannel?.avatarUrl ? String(activeChannel.avatarUrl) : null;
    if (mode === "groups") return activeGroupChat?.avatarUrl ? String(activeGroupChat.avatarUrl) : null;
    if (mode === "dms") {
      if (isSelfNotesActiveDm) return profileAvatarUrl ? String(profileAvatarUrl) : null;
      return dmPeerAvatarUrl;
    }
    return null;
  }, [mode, activeChannel, activeGroupChat, isSelfNotesActiveDm, profileAvatarUrl, dmPeerAvatarUrl]);

  const infoPanelPhotos = useMemo(
    () =>
      messages.filter(
        (m) =>
          m.type === "file" &&
          looksLikeImageAttachment(attachmentOriginalNameHint(m), m.file?.mimeType) &&
          m.file?.downloadUrl &&
          !m.isDeleted,
      ),
    [messages],
  );
  const infoPanelFiles = useMemo(
    () =>
      messages.filter(
        (m) =>
          m.type === "file" &&
          !looksLikeImageAttachment(attachmentOriginalNameHint(m), m.file?.mimeType) &&
          m.file?.downloadUrl &&
          !m.isDeleted,
      ),
    [messages],
  );
  const infoPanelVoice = useMemo(
    () => messages.filter((m) => m.type === "voice" && m.file?.downloadUrl && !m.isDeleted),
    [messages],
  );
  const infoPanelLinks = useMemo(() => {
    const out: { id: string; url: string; preview: string }[] = [];
    const re = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    for (const m of messages) {
      if (m.isDeleted || !m.content) continue;
      const ms = m.content.match(re);
      if (ms) {
        for (const url of ms) {
          out.push({ id: `${m.id}-${url.slice(0, 48)}`, url, preview: (m.content || "").slice(0, 100) });
        }
      }
    }
    return out;
  }, [messages]);

  function previewForMessages(arr: Message[]) {
    const last = [...arr].reverse().find((m) => !m._localFileState); // skip placeholders if possible
    if (!last) return { text: "", at: "" };
    const txt =
      last.type === "file"
        ? `📎 ${last.file?.originalName ?? "Файл"}`
        : last.type === "voice"
          ? "🎤 Голосовое"
          : (last.content || "(без текста)");
    return { text: String(txt).slice(0, 80), at: last.createdAt };
  }

  function timeHHMM(iso?: string) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  const pushLog = (line: string) => setLog((prev) => [line, ...prev].slice(0, 80));

  function displayUser(userId: string) {
    const u = users.find((x) => x.id === userId);
    return displayUserNameForSidebar(u, userId);
  }

  function messageAuthorLabel(m: { author?: { email?: string } }) {
    const em = m.author?.email ?? "";
    const u = users.find((x) => x.email === em);
    return displayUserNameForSidebar(u, em);
  }

  function readerDisplayName(u: { id: string; email: string; firstName?: string | null; lastName?: string | null }) {
    const fromList = users.find((x) => x.id === u.id);
    return displayUserNameForSidebar(fromList ?? u, u.email);
  }

  function currentChatKeyStr(): string {
    if (mode === "channels" && activeChannelId) return chatKeyFor("c", activeChannelId);
    if (mode === "groups" && activeGroupChatId) return chatKeyFor("g", activeGroupChatId);
    if (mode === "dms" && activeDirectChatId) return chatKeyFor("d", activeDirectChatId);
    return "";
  }
  function peerReadMapForCurrentChat(): Record<string, string> {
    const k = currentChatKeyStr();
    if (!k) return {};
    return threadReadByKey[k] ?? {};
  }
  function messageReadByOthers(m: Message, myEmail: string, myUserId: string, peerMap: Record<string, string>) {
    if (m.author?.email !== myEmail) return false;
    if (m._sendState === "sending" || m._sendState === "failed") return false;
    if (String(m.id).startsWith("tmp-")) return false;
    for (const [uid, iso] of Object.entries(peerMap)) {
      if (uid === myUserId) continue;
      try {
        if (new Date(iso).getTime() >= new Date(m.createdAt).getTime()) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  useEffect(() => {
    if (!token || threadRootId || showPins || showSaved) return;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          if (mode === "channels" && activeChannelId) {
            await gql(`mutation($input: MarkThreadReadInput!) { markThreadRead(input: $input) }`, { input: { channelId: activeChannelId } }, token);
          } else if (mode === "groups" && activeGroupChatId) {
            await gql(`mutation($input: MarkThreadReadInput!) { markThreadRead(input: $input) }`, { input: { groupChatId: activeGroupChatId } }, token);
          } else if (mode === "dms" && activeDirectChatId) {
            await gql(`mutation($input: MarkThreadReadInput!) { markThreadRead(input: $input) }`, { input: { directChatId: activeDirectChatId } }, token);
          }
        } catch {
          /* ignore */
        }
      })();
    }, 600);
    return () => clearTimeout(t);
  }, [token, mode, activeChannelId, activeGroupChatId, activeDirectChatId, messages.length, threadRootId, showPins, showSaved]);

  useEffect(() => {
    if (!socket) return;
    // Clear typing when switching chat
    setTypingUserIds([]);
    if (mode === "channels" && activeChannelId) socket.emit("channel:join", { channelId: activeChannelId });
    else if (mode === "groups" && activeGroupChatId) socket.emit("group:join", { groupChatId: activeGroupChatId });
    else if (mode === "dms" && activeDirectChatId) socket.emit("dm:join", { directChatId: activeDirectChatId });
  }, [socket, mode, activeChannelId, activeGroupChatId, activeDirectChatId]);

  useEffect(() => {
    if (!forwardSelecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelForwardSelect();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forwardSelecting]);

  useEffect(() => {
    if (!chatMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChatMenu(null);
    };
    const onClick = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && chatMenuRef.current?.contains(t)) return;
      setChatMenu(null);
    };
    const onScroll = () => setChatMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true } as any);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
      window.removeEventListener("scroll", onScroll, { capture: true } as any);
    };
  }, [chatMenu]);

  useEffect(() => {
    setCallJoinModalKind(null);
  }, [mode, activeChannelId, activeGroupChatId, activeDirectChatId]);

  useEffect(() => {
    setChatMetaPopoverOpen(false);
  }, [mode, activeChannelId, activeGroupChatId]);

  useEffect(() => {
    if (!msgMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMsgMenu(null);
    };
    const onClick = () => setMsgMenu(null);
    const onScroll = () => setMsgMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true } as any);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
      window.removeEventListener("scroll", onScroll, { capture: true } as any);
    };
  }, [msgMenu]);

  useEffect(() => {
    // Auto-scroll to bottom on new messages (Telegram behavior)
    if (!stickToBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, mode, activeChannelId, activeGroupChatId, activeDirectChatId, threadRootId, showPins, showSaved]);

  useEffect(() => {
    const el = messagesWrapRef.current;
    if (!el) return;
    const hint = chatPullHintRef.current;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = distance < 200;
      stickToBottomRef.current = nearBottom;
      setShowScrollToBottom(!nearBottom);
    };
    const onTouchStart = (e: TouchEvent) => {
      if (threadRootId || showPins || showSaved) return;
      chatPullTouchRef.current = { y: e.touches[0].clientY, active: el.scrollTop <= 2 };
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!chatPullTouchRef.current.active) return;
      if (el.scrollTop > 2) {
        chatPullTouchRef.current.active = false;
        if (hint) hint.style.height = "0px";
        return;
      }
      const dy = e.touches[0].clientY - chatPullTouchRef.current.y;
      if (dy > 0 && hint) {
        hint.style.height = `${Math.min(56, dy * 0.45)}px`;
      }
    };
    const onTouchEnd = () => {
      if (!chatPullTouchRef.current.active) return;
      chatPullTouchRef.current.active = false;
      const h = hint ? parseInt(hint.style.height || "0", 10) || 0 : 0;
      if (hint) hint.style.height = "0px";
      if (h < 28) return;
      if (!token || threadRootId || showPins || showSaved) return;
      void refreshChatsAndPresenceRef.current?.();
    };
    let wheelPullAcc = 0;
    const onWheel = (e: WheelEvent) => {
      if (threadRootId || showPins || showSaved) return;
      if (el.scrollTop > 2) {
        wheelPullAcc = 0;
        return;
      }
      if (e.deltaY >= 0) {
        wheelPullAcc = 0;
        return;
      }
      wheelPullAcc += -e.deltaY;
      if (wheelPullAcc < 100) return;
      wheelPullAcc = 0;
      if (!token) return;
      void refreshChatsAndPresenceRef.current?.();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("wheel", onWheel, { passive: true });
    stickToBottomRef.current = true;
    onScroll();
    queueMicrotask(() => {
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("wheel", onWheel);
    };
  }, [
    activeChannelId,
    activeGroupChatId,
    activeDirectChatId,
    threadRootId,
    showPins,
    showSaved,
    token,
    mode,
  ]);

  // Ringtone for incoming calls when tab is hidden / another tab
  useEffect(() => {
    const a = ringtoneRef.current;
    if (!a) return;
    if (!incomingCall) {
      try {
        a.pause();
        a.currentTime = 0;
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      a.loop = true;
      void a.play();
    } catch {
      /* ignore */
    }
    return () => {
      try {
        a.pause();
        a.currentTime = 0;
      } catch {
        /* ignore */
      }
    };
  }, [incomingCall]);

  const typingRef = useRef<{ started: boolean; stopTimerId: number | null }>({ started: false, stopTimerId: null });
  const localFileMessageIdByFileIdRef = useRef(new Map<string, string>());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<BlobPart[]>([]);
  const voiceStartAtRef = useRef<number>(0);
  /** Пользователь отпустил кнопку до окончания await getUserMedia / до rec.start */
  const voiceRecordAbortRef = useRef(false);
  const voiceStartingRef = useRef(false);
  /** Чтобы глобальный pointerup (ниже) вызывал актуальный stopVoiceRecord */
  const stopVoiceRecordRef = useRef<() => void>(() => {});
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const threadSearchInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesWrapRef = useRef<HTMLDivElement | null>(null);
  const chatPullHintRef = useRef<HTMLDivElement | null>(null);
  const chatPullTouchRef = useRef<{ y: number; active: boolean }>({ y: 0, active: false });
  const chatSearchRef = useRef<HTMLInputElement | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const stickToBottomRef = useRef(true);

  function scrollMessagesToBottom() {
    stickToBottomRef.current = true;
    queueMicrotask(() => {
      messagesEndRef.current?.scrollIntoView({ block: "end" });
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ block: "end" });
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ block: "end" });
        });
      });
    });
  }

  // Unlock audio on first user gesture (mobile/desktop autoplay restrictions)
  useEffect(() => {
    const unlock = () => {
      if (audioUnlockedRef.current) return;
      audioUnlockedRef.current = true;
      try {
        const a = ringtoneRef.current;
        if (a) {
          a.muted = true;
          void a.play().finally(() => {
            a.pause();
            a.currentTime = 0;
            a.muted = false;
          });
        }
      } catch {
        /* ignore */
      }
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
    };
  }, []);

  function diagLog(line: string) {
    const msg = `[webrtc] ${line}`;
    pushLog(msg);
    setWebrtcDiagLines((prev) => [msg, ...prev].slice(0, 300));
  }

  function attachWebrtcDiagnostics(pc: RTCPeerConnection, peerLabel: string) {
    webrtcDiagPcRef.current = pc;
    setWebrtcDiagLines([]);
    diagLog(`peer=${peerLabel} created; ua=${typeof navigator !== "undefined" ? navigator.userAgent : ""}`);
    const safe = (v: any) => (v == null ? "" : String(v));
    pc.onicegatheringstatechange = () => diagLog(`iceGatheringState=${pc.iceGatheringState}`);
    pc.oniceconnectionstatechange = () => diagLog(`iceConnectionState=${pc.iceConnectionState}`);
    pc.onsignalingstatechange = () => diagLog(`signalingState=${pc.signalingState}`);
    pc.onconnectionstatechange = () => diagLog(`connectionState=${pc.connectionState}`);
    pc.onnegotiationneeded = () => diagLog(`negotiationneeded`);
    pc.ontrack = (ev) => {
      diagLog(`ontrack kind=${safe(ev.track?.kind)} id=${safe(ev.track?.id)} ready=${safe(ev.track?.readyState)}`);
    };
  }

  async function snapshotWebrtcStats() {
    const pc = webrtcDiagPcRef.current;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      let selectedPair: any = null;
      const pairStates: Record<string, number> = {};
      const localTypes: Record<string, number> = {};
      const remoteTypes: Record<string, number> = {};
      stats.forEach((r: any) => {
        if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") selectedPair = r;
        if (r.type === "candidate-pair") {
          const k = String(r.state ?? "unknown");
          pairStates[k] = (pairStates[k] ?? 0) + 1;
        }
        if (r.type === "local-candidate") {
          const t = String(r.candidateType ?? "unknown");
          localTypes[t] = (localTypes[t] ?? 0) + 1;
        }
        if (r.type === "remote-candidate") {
          const t = String(r.candidateType ?? "unknown");
          remoteTypes[t] = (remoteTypes[t] ?? 0) + 1;
        }
      });
      const localCand = selectedPair?.localCandidateId ? stats.get(selectedPair.localCandidateId) : null;
      const remoteCand = selectedPair?.remoteCandidateId ? stats.get(selectedPair.remoteCandidateId) : null;
      diagLog(
        `stats conn=${pc.connectionState} ice=${pc.iceConnectionState} selectedPair=${selectedPair ? `rtt=${selectedPair.currentRoundTripTime ?? "?"}` : "none"}`,
      );
      const fmt = (m: Record<string, number>) =>
        Object.keys(m).length ? Object.entries(m).map(([k, v]) => `${k}=${v}`).join(" ") : "none";
      diagLog(`pairs ${fmt(pairStates)} | localCandidates ${fmt(localTypes)} | remoteCandidates ${fmt(remoteTypes)}`);
      if (localCand || remoteCand) {
        diagLog(
          `candidates local=${localCand ? `${localCand.candidateType}/${localCand.protocol} ${localCand.address ?? localCand.ip ?? ""}:${localCand.port ?? ""}` : "?"} remote=${remoteCand ? `${remoteCand.candidateType}/${remoteCand.protocol} ${remoteCand.address ?? remoteCand.ip ?? ""}:${remoteCand.port ?? ""}` : "?"}`,
        );
      }
      if (!selectedPair) {
        const hasLocal = Object.keys(localTypes).length > 0;
        const hasRemote = Object.keys(remoteTypes).length > 0;
        if (hasLocal && !hasRemote && pc.connectionState !== "closed") {
          diagLog(
            "hint: remote-candidate в stats нет при живом соединении — часто не дошли ICE/answer по сигналингу или peer не прислал кандидаты.",
          );
        } else if (
          hasLocal &&
          hasRemote &&
          !(localTypes as any).relay &&
          !(remoteTypes as any).relay
        ) {
          diagLog(
            "hint: relay candidates отсутствуют → без TURN сеть/файрвол может не пропускать P2P. Добавьте TURN в VITE_ICE_SERVERS.",
          );
        }
      }
    } catch (e: any) {
      diagLog(`getStats error: ${String(e?.message ?? e)}`);
    }
  }

  async function runMediaSelfTest() {
    try {
      const secure = typeof window !== "undefined" ? (window as any).isSecureContext : false;
      diagLog(`media secureContext=${secure ? "true" : "false"}`);
      const md = typeof navigator !== "undefined" ? (navigator.mediaDevices as any) : null;
      if (!md?.getUserMedia) {
        diagLog("media error: getUserMedia not supported");
        return;
      }

      // Permissions API (not supported everywhere)
      try {
        const p = (navigator as any).permissions;
        if (p?.query) {
          const cam = await p.query({ name: "camera" });
          const mic = await p.query({ name: "microphone" });
          diagLog(`media permissions camera=${cam?.state ?? "?"} microphone=${mic?.state ?? "?"}`);
        }
      } catch {
        diagLog("media permissions: not available");
      }

      try {
        const devices = await md.enumerateDevices();
        const cams = devices.filter((d: any) => d.kind === "videoinput");
        const mics = devices.filter((d: any) => d.kind === "audioinput");
        diagLog(`media devices cameras=${cams.length} microphones=${mics.length}`);
        if (cams.length) diagLog(`media camera[0]=${String(cams[0].label || "(no label)")}`);
        if (mics.length) diagLog(`media mic[0]=${String(mics[0].label || "(no label)")}`);
      } catch (e: any) {
        diagLog(`media enumerateDevices error: ${String(e?.name ?? "")} ${String(e?.message ?? e)}`);
      }

      // Actual getUserMedia probe
      diagLog("media getUserMedia probe: requesting audio+video…");
      const stream = await md.getUserMedia({ audio: true, video: true });
      const tracks = stream.getTracks();
      diagLog(`media getUserMedia ok: tracks=${tracks.map((t: any) => `${t.kind}:${t.readyState}:${t.label || ""}`).join(", ")}`);
      stream.getTracks().forEach((t: any) => {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      });
    } catch (e: any) {
      const name = String(e?.name ?? "");
      const msg = String(e?.message ?? e);
      const constraint = e?.constraintName ? String(e.constraintName) : "";
      diagLog(`media getUserMedia FAIL: ${name} ${msg}${constraint ? ` constraint=${constraint}` : ""}`);
    }
  }

  function dumpIceServersConfig() {
    try {
      const dbg = debugIceServers();
      diagLog(`ice env raw=${dbg.raw ? dbg.raw.slice(0, 400) : "null"}`);
      if (dbg.error) diagLog(`ice env parse error: ${dbg.error}`);
      if (dbg.parsed) diagLog(`ice servers parsed: ${JSON.stringify(dbg.parsed)}`);
      else diagLog(`ice servers fallback: ${JSON.stringify(dbg.fallback)}`);
    } catch (e: any) {
      diagLog(`ice debug error: ${String(e?.message ?? e)}`);
    }
  }

  useEffect(() => {
    if (!chatListFilterOpen) return;
    const onDown = (e: Event) => {
      const el = chatListFilterAnchorRef.current;
      if (el && !el.contains(e.target as Node)) setChatListFilterOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [chatListFilterOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = String(e.key || "").toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "k") {
        e.preventDefault();
        chatSearchRef.current?.focus();
        chatSearchRef.current?.select();
        return;
      }
      if (e.key === "Escape") {
        setChatListFilterOpen(false);
        setMsgMenu(null);
        setChatMenu(null);
        setShowForwardPicker(false);
        setShowStickerPicker(false);
        setMoreMenuOpen(false);
        setNewChatMenuOpen(false);
        setShowRightPanel(false);
        setMobileSidebarOpen(false);
        return;
      }
      if (k === "end" && !showSaved && !showPins) {
        stickToBottomRef.current = true;
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSaved, showPins]);

  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (viewportW < 800) setMobileSidebarOpen(false);
  }, [activeChannelId, activeGroupChatId, activeDirectChatId, viewportW]);

  useEffect(() => {
    const legacyStickerPackId: Record<string, string> = {
      "basic-emoji": "pack-01-smiles",
      "work-pack": "pack-02-work",
      "mood-pack": "pack-03-mood",
    };
    try {
      const rawInstalled = localStorage.getItem("tg:installedStickerPackIds");
      const rawCustom = localStorage.getItem("tg:customStickerPacks");
      let catalogIds = defaultStickerCatalog.map((p) => p.id);
      if (rawCustom) {
        const custom = JSON.parse(rawCustom);
        if (Array.isArray(custom)) {
          const safe = custom.filter(
            (x: unknown) =>
              x && typeof x === "object" && x !== null && "id" in x && typeof (x as { id?: string }).id === "string",
          ) as { id: string; title: string; stickers: string[] }[];
          if (safe.length) {
            setStickerCatalog((prev) => [...prev, ...safe]);
            catalogIds = [...catalogIds, ...safe.map((p) => p.id)];
          }
        }
      }
      const valid = new Set(catalogIds);
      if (rawInstalled) {
        const arr = JSON.parse(rawInstalled);
        if (Array.isArray(arr)) {
          const next = arr
            .filter((x: unknown) => typeof x === "string")
            .map((id: string) => legacyStickerPackId[id] ?? id)
            .filter((id: string) => valid.has(id));
          setInstalledStickerPackIds(next.length ? next : [defaultStickerCatalog[0].id]);
        } else setInstalledStickerPackIds([defaultStickerCatalog[0].id]);
      } else {
        setInstalledStickerPackIds([defaultStickerCatalog[0].id]);
      }
    } catch {
      setInstalledStickerPackIds([defaultStickerCatalog[0].id]);
    }
  }, []);

  useEffect(() => {
    if (!installedStickerPackIds.length) return;
    if (!installedStickerPackIds.includes(activeStickerPackId)) {
      setActiveStickerPackId(installedStickerPackIds[0]!);
    }
  }, [installedStickerPackIds, activeStickerPackId]);

  useEffect(() => {
    try {
      localStorage.setItem("tg:installedStickerPackIds", JSON.stringify(installedStickerPackIds));
      const custom = stickerCatalog.filter((p) => !defaultStickerCatalog.some((d) => d.id === p.id));
      localStorage.setItem("tg:customStickerPacks", JSON.stringify(custom));
    } catch {
      // ignore
    }
  }, [installedStickerPackIds, stickerCatalog]);

  async function resolveSeedOrgForEmail(emailValue: string) {
    const emailKey = emailValue.trim().toLowerCase();
    if (!emailKey) return;
    try {
      const rawMap = localStorage.getItem("tg:emailOrgBindings");
      const map = rawMap ? (JSON.parse(rawMap) as Record<string, string>) : {};
      const mappedOrg = map[emailKey];
      if (mappedOrg) {
        setOrganizationId(mappedOrg);
        try {
          const rawCodeMap = localStorage.getItem("tg:orgCodeBindings");
          const codeMap = rawCodeMap ? (JSON.parse(rawCodeMap) as Record<string, string>) : {};
          const code = Object.entries(codeMap).find(([, id]) => id === mappedOrg)?.[0] || "";
          if (code) setOrganizationCode(code);
        } catch {
          // ignore
        }
        return;
      }
    } catch {
      // ignore localStorage read errors
    }
    try {
      const res = await fetch(`${API_BASE}/playground-ru/seed-info`);
      const data = await res.json();
      if (!res.ok || !data?.organizationId) return;
      const orgId = String(data.organizationId);
      setOrganizationId(orgId);
      if (data?.workspaceId) setWorkspaceId(String(data.workspaceId));
      try {
        const rawMap = localStorage.getItem("tg:emailOrgBindings");
        const map = rawMap ? (JSON.parse(rawMap) as Record<string, string>) : {};
        map[emailKey] = orgId;
        localStorage.setItem("tg:emailOrgBindings", JSON.stringify(map));
        const rawCodeMap = localStorage.getItem("tg:orgCodeBindings");
        const codeMap = rawCodeMap ? (JSON.parse(rawCodeMap) as Record<string, string>) : {};
        let code = Object.entries(codeMap).find(([, id]) => id === orgId)?.[0] || "";
        if (!code) {
          const nums = Object.keys(codeMap)
            .map((k) => Number((k.match(/^ID(\d{6})$/)?.[1] ?? "0")))
            .filter((n) => Number.isFinite(n));
          const next = (nums.length ? Math.max(...nums) : 0) + 1;
          code = `ID${String(next).padStart(6, "0")}`;
          codeMap[code] = orgId;
          localStorage.setItem("tg:orgCodeBindings", JSON.stringify(codeMap));
        }
        setOrganizationCode(code);
      } catch {
        // ignore localStorage write errors
      }
    } catch {
      // ignore seed info network errors
    }
  }

  useEffect(() => {
    if (!token) return;
    void refreshSavedIds();
  }, [token]);

  useEffect(() => {
    if (!token) return;
    try {
      localStorage.setItem(
        TG_SESSION_KEY,
        JSON.stringify({
          token,
          userId,
          viewerRole,
          organizationId,
          workspaceId,
          systemAccessLevel,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [token, userId, viewerRole, organizationId, workspaceId, systemAccessLevel]);

  useEffect(() => {
    if (!token) return;
    let key = "";
    if (mode === "channels" && activeChannelId) key = `c:${activeChannelId}`;
    else if (mode === "groups" && activeGroupChatId) key = `g:${activeGroupChatId}`;
    else if (mode === "dms" && activeDirectChatId) key = `d:${activeDirectChatId}`;
    if (!key) return;
    try {
      localStorage.setItem(TG_LAST_OPEN_CHAT_KEY, JSON.stringify({ key }));
    } catch {
      /* ignore */
    }
  }, [token, mode, activeChannelId, activeGroupChatId, activeDirectChatId]);

  useEffect(() => {
    if (!showRightPanel) return;
    setInfoPanelSection(mode === "dms" ? "photos" : "about");
  }, [showRightPanel, mode]);

  useEffect(() => {
    if (mode === "dms" && infoPanelSection === "about") setInfoPanelSection("photos");
  }, [mode, infoPanelSection]);

  useEffect(() => {
    try {
      const p = localStorage.getItem("tg:pinnedChats");
      const po = localStorage.getItem("tg:pinnedOrder");
      const mm = localStorage.getItem("tg:chatMuteUntil");
      const mOld = localStorage.getItem("tg:mutedChats");
      const a = localStorage.getItem("tg:archivedChats");
      if (p) setPinnedChatByKey(JSON.parse(p));
      if (po) setPinnedOrderByKey(JSON.parse(po));
      if (mm) {
        setChatMuteMap(JSON.parse(mm));
      } else if (mOld) {
        const o = JSON.parse(mOld) as Record<string, boolean>;
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(o)) {
          if (v) next[k] = "forever";
        }
        setChatMuteMap(next);
      }
      if (a) setArchivedChatByKey(JSON.parse(a));
    } catch {
      // ignore
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("tg:pinnedChats", JSON.stringify(pinnedChatByKey));
      localStorage.setItem("tg:pinnedOrder", JSON.stringify(pinnedOrderByKey));
      localStorage.setItem("tg:chatMuteUntil", JSON.stringify(chatMuteMap));
      localStorage.setItem("tg:archivedChats", JSON.stringify(archivedChatByKey));
    } catch {
      // ignore
    }
  }, [pinnedChatByKey, pinnedOrderByKey, chatMuteMap, archivedChatByKey]);

  useEffect(() => {
    if (!loginIdentifier.includes("@")) return;
    const t = window.setTimeout(() => {
      void resolveSeedOrgForEmail(loginIdentifier);
    }, 250);
    return () => window.clearTimeout(t);
  }, [loginIdentifier]);

  async function loadSavedMessages() {
    if (!token) return;
    const data = await gql<{ savedMessages: Message[] }>(
      `query($limit: Int!) {
        savedMessages(limit: $limit) {
          id content createdAt editedAt isDeleted type parentMessageId author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl avStatus blockedReason }
        }
      }`,
      { limit: 100 },
      token,
    );
    setMessages(data.savedMessages);
    setShowSaved(true);
    pushLog(`Saved messages: ${data.savedMessages.length}`);
  }

  async function loadPinnedMessages() {
    if (!token || !activeChannelId) return;
    const data = await gql<{ pinnedMessages: Message[] }>(
      `query($channelId: ID!, $limit: Int!) {
        pinnedMessages(channelId: $channelId, limit: $limit) {
          id content createdAt editedAt isDeleted type parentMessageId author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl avStatus blockedReason }
        }
      }`,
      { channelId: activeChannelId, limit: 50 },
      token,
    );
    setMessages(data.pinnedMessages);
    setShowPins(true);
    pushLog(`Pinned messages: ${data.pinnedMessages.length}`);
  }

  async function pinMessage(messageId: string) {
    if (!token) return;
    await gql<{ pinMessage: boolean }>(
      `mutation($input: PinMessageInput!) { pinMessage(input: $input) }`,
      { input: { messageId } },
      token,
    );
    pushLog("Pin ok");
  }

  async function unpinMessage(messageId: string) {
    if (!token) return;
    await gql<{ unpinMessage: boolean }>(
      `mutation($input: UnpinMessageInput!) { unpinMessage(input: $input) }`,
      { input: { messageId } },
      token,
    );
    pushLog("Unpin ok");
  }

  function startForwardSelect(firstId?: string) {
    setForwardSelecting(true);
    setShowForwardPicker(false);
    setForwardSelectedIds(() => {
      const s = new Set<string>();
      if (firstId) s.add(firstId);
      return s;
    });
  }

  function toggleForwardSelected(messageId: string) {
    setForwardSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }

  function cancelForwardSelect() {
    setForwardSelecting(false);
    setShowForwardPicker(false);
    setForwardSelectedIds(new Set());
  }

  async function forwardSelectedTo(target: { channelId?: string; groupChatId?: string; directChatId?: string }) {
    if (!token) return;
    const ids = Array.from(forwardSelectedIds);
    if (!ids.length) throw new Error("Нечего пересылать");
    const hideAuthor = window.confirm("Скрыть автора при пересылке? (hideAuthor=true)");
    await gql<{ forwardMessages: boolean }>(
      `mutation($input: ForwardMessagesInput!) { forwardMessages(input: $input) }`,
      { input: { messageIds: ids, ...target, hideAuthor } },
      token,
    );
    pushLog(`Forward ok: ${ids.length}`);
    cancelForwardSelect();
  }

  async function refreshSavedIds() {
    if (!token) return;
    const data = await gql<{ savedMessageIds: string[] }>(
      `query($limit: Int!) { savedMessageIds(limit: $limit) }`,
      { limit: 500 },
      token,
    );
    setSavedIds(new Set(data.savedMessageIds ?? []));
  }

  async function login(e?: FormEvent) {
    e?.preventDefault();
    try {
      setAuthError("");
      setPendingEmailOtp(null);
      setOtpCode("");
      let orgId = organizationId.trim();
      if (!orgId) {
        try {
          const seedRes = await fetch(`${API_BASE}/playground-ru/seed-info`);
          const seedData = await seedRes.json();
          if (seedRes.ok && seedData?.organizationId) {
            orgId = String(seedData.organizationId);
            setOrganizationId(orgId);
            if (seedData?.workspaceId) setWorkspaceId(String(seedData.workspaceId));
          }
        } catch {
          /* ignore */
        }
      }
      if (!orgId) {
        throw new Error(
          "Не указана организация. Войдите под корпоративной почтой — организация подставится автоматически, либо уточните ID у администратора.",
        );
      }
      const ident = loginIdentifier.trim();
      if (!ident || !password) throw new Error("Укажите почту или телефон и пароль.");
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ identifier: ident, password, organizationId: orgId }),
      });
      const data = (await res.json()) as LoginResult & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error || "Login failed");
      if (data.needsEmailOtp && data.challengeId) {
        setPendingEmailOtp({ challengeId: data.challengeId, emailMasked: data.emailMasked });
        pushLog("Введите код из письма для подтверждения входа.");
        return;
      }
      if (!data.accessToken || !data.viewer) throw new Error("Неверный ответ сервера");
      setOrganizationId(orgId);
      setToken(data.accessToken);
      setUserId(data.viewer.userId);
      setViewerRole((data.viewer.role as any) ?? "");
      setSystemAccessLevel((data.viewer.systemAccessLevel as any) ?? "organization");
      pushLog("Успешный вход.");
    } catch (e: any) {
      let msg = String(e?.message ?? e ?? "Login failed");
      if (msg === "Failed to fetch") {
        msg =
          "Не удалось связаться с сервером (сеть / CORS / прокси). Проверьте, что backend запущен, в .env CLIENT_URL совпадает с адресом сайта (можно несколько через запятую), а Nginx проксирует /auth/ и /graphql.";
      }
      setAuthError(`Ошибка входа: ${msg}`);
    }
  }

  async function confirmLoginEmailOtp(e?: FormEvent) {
    e?.preventDefault();
    try {
      setAuthError("");
      if (!pendingEmailOtp) throw new Error("Сначала выполните вход с паролем.");
      const orgId = organizationId.trim();
      if (!orgId) throw new Error("Organization ID не указан");
      const code = otpCode.replace(/\D/g, "").slice(0, 6);
      if (code.length !== 6) throw new Error("Введите 6 цифр кода из письма");
      const res = await fetch(`${API_BASE}/auth/login/confirm-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ challengeId: pendingEmailOtp.challengeId, code, organizationId: orgId }),
      });
      const data = (await res.json()) as LoginResult & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error || "Ошибка подтверждения");
      if (!data.accessToken || !data.viewer) throw new Error("Неверный ответ сервера");
      setPendingEmailOtp(null);
      setOtpCode("");
      setToken(data.accessToken);
      setUserId(data.viewer.userId);
      setViewerRole((data.viewer.role as any) ?? "");
      setSystemAccessLevel((data.viewer.systemAccessLevel as any) ?? "organization");
      pushLog("Вход подтверждён по коду из письма.");
    } catch (e: any) {
      let msg = String(e?.message ?? e ?? "Ошибка");
      if (msg === "Failed to fetch") {
        msg =
          "Не удалось связаться с сервером. Проверьте сеть и что backend доступен по тому же домену (CORS / прокси).";
      }
      setAuthError(`Подтверждение: ${msg}`);
    }
  }

  async function logout() {
    try {
      await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "include" });
    } catch {
      // ignore
    }
    try {
      socketRef.current?.disconnect();
    } catch {
      // ignore
    }
    socketRef.current = null;
    setSocket(null);
    setToken("");
    chatFoldersHydratedRef.current = false;
    setUserId("");
    setViewerRole("");
    setSystemAccessLevel("");
    setPendingEmailOtp(null);
    setOtpCode("");
    try {
      localStorage.removeItem(TG_SESSION_KEY);
      localStorage.removeItem(TG_LAST_OPEN_CHAT_KEY);
    } catch {
      /* ignore */
    }
    setMessages([]);
    setChannels([]);
    setGroupChats([]);
    setDirectChats([]);
    setActiveChannelId("");
    setActiveGroupChatId("");
    setActiveDirectChatId("");
    setTypingUserIds([]);
    setShowSaved(false);
    setShowPins(false);
    cancelForwardSelect();
    setShowLogs(false);
    pushLog("Выход выполнен.");
  }

  function connectSocket() {
    if (!token) return;
    try {
      socketRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    socketRef.current = null;
    const iosLike = isIosLikeBrowser();
    const standalone = isStandaloneWebApp();
    /** PWA раньше были только polling + upgrade:false — на балансировщике без sticky каждый poll мог попадать на разный инстанс и рвать сессию/presence. Стартуем с polling, затем upgrade на websocket. */
    const pwaStandalone = standalone;
    const s = io(SOCKET_URL, {
      auth: { token },
      path: "/socket.io/",
      transports: pwaStandalone || iosLike ? ["polling", "websocket"] : ["websocket", "polling"],
      upgrade: true,
      reconnection: true,
      reconnectionAttempts: 25,
      reconnectionDelay: 800,
    });
    const refreshPresenceFromApi = () => {
      if (!organizationId.trim()) return;
      void loadUsers();
      window.setTimeout(() => void loadUsers(), 450);
      window.setTimeout(() => void loadUsers(), 2200);
    };
    s.on("connect", () => {
      pushLog(pwaStandalone ? "Socket подключен (PWA/ярлык, polling→websocket)." : "Socket подключен.");
      refreshPresenceFromApi();
    });
    s.on("reconnect", () => {
      pushLog("Socket переподключён.");
      refreshPresenceFromApi();
    });
    s.on("connect_error", (err: Error) => {
      pushLog(`Socket ошибка: ${err?.message || "connect_error"} (проверьте прокси /socket.io/ на nginx)`);
    });
    s.on("disconnect", (reason: string) => {
      if (reason === "io server disconnect") pushLog("Socket отключён сервером.");
    });
    s.on("presence:snapshot", (evt: any) => {
      const items = Array.isArray(evt?.items) ? evt.items : [];
      if (!items.length) return;
      const socketUp = !!socketRef.current?.connected;
      setPresenceByUserId((prev) => {
        const next = { ...prev };
        for (const it of items) {
          const uid = String(it?.userId ?? "");
          if (!uid) continue;
          const raw = it?.status;
          let status = raw != null && String(raw) !== "" ? String(raw) : "offline";
          if (socketUp && prev[uid]?.status === "online" && status === "offline") {
            status = "online";
          }
          next[uid] = {
            status,
            lastSeen: it?.lastSeen != null ? String(it.lastSeen) : next[uid]?.lastSeen,
          };
        }
        return next;
      });
      setUsers((prev) => {
        const byId = new Map(items.map((it: any) => [String(it?.userId ?? ""), it]));
        return prev.map((u) => {
          const it = byId.get(u.id) as { status?: string | null } | undefined;
          if (!it) return u;
          let st = it.status != null && String(it.status) !== "" ? String(it.status) : u.status;
          if (socketUp && u.status === "online" && st === "offline") {
            st = "online";
          }
          return { ...u, status: st as typeof u.status };
        });
      });
    });
    s.on("presence:update", (evt: any) => {
      const who = String(evt?.userId ?? "");
      const status = String(evt?.status ?? "");
      if (!who || !status) return;
      pushLog(`🟢 presence: ${displayUser(who)} -> ${status}`);
      setPresenceByUserId((prev) => ({ ...prev, [who]: { status, lastSeen: String(evt?.lastSeen ?? "") || undefined } }));
      setUsers((prev) => prev.map((u) => (u.id === who ? { ...u, status: status as typeof u.status } : u)));
    });
    s.on("message:new", (m: any) => {
      const channelId = String(m.channelId ?? "");
      const groupChatId = String(m.groupChatId ?? "");
      const directChatId = String(m.directChatId ?? "");
      const kind = channelId ? "c" : groupChatId ? "g" : directChatId ? "d" : "";
      const targetId = channelId || groupChatId || directChatId || "";
      const key = kind && targetId ? chatKeyFor(kind as any, targetId) : "";

      const msg: Message = {
        id: String(m.id),
        content: String(m.content ?? ""),
        createdAt: String(m.createdAt ?? new Date().toISOString()),
        editedAt: m.editedAt ?? null,
        isDeleted: !!m.isDeleted,
        author: {
          id: String((m as { author?: { id?: string } }).author?.id ?? ""),
          email: String(m.author?.email ?? "user"),
          firstName: m.author?.firstName ?? null,
          middleName: m.author?.middleName ?? null,
          lastName: m.author?.lastName ?? null,
        },
        type: m.type,
        parentMessageId: m.parentMessageId ?? null,
        file: mergeSocketFilePayload(null, m),
        reactions: Array.isArray(m.reactions) ? m.reactions : [],
      };

      // Update chat list preview for this chat
      if (key) {
        const p = previewForMessages([msg]);
        setChatPreviewByKey((prev) => ({ ...prev, [key]: p }));
      }

      const isActive =
        (modeRef.current === "channels" && channelId && channelId === activeChannelIdRef.current) ||
        (modeRef.current === "groups" && groupChatId && groupChatId === activeGroupChatIdRef.current) ||
        (modeRef.current === "dms" && directChatId && directChatId === activeDirectChatIdRef.current);

      const tabHidden = typeof document !== "undefined" && document.hidden;
      const authorId = String(msg.author?.id ?? "");
      const myEmail = myAccountEmailRef.current.trim().toLowerCase();
      const authorEmail = String(msg.author?.email ?? "").trim().toLowerCase();
      const fromMe =
        (!!userIdRef.current && !!authorId && authorId === userIdRef.current) ||
        (!!myEmail && !!authorEmail && authorEmail === myEmail);
      const v = key ? chatMuteMapRef.current[key] : undefined;
      const muted =
        v === "forever" ||
        (v && v !== "forever" && !Number.isNaN(Date.parse(v)) && Date.now() < Date.parse(v));

      const isCallOrMeetHint = /🎥|📞|🎬|Видеозвонок|видеовстреч|видео[\s-]?звон|видеосвяз|Аудиозвонок|видеовстречи|созвон|созвонились|звонок|групповой|личн(ый|ого)\s+созвон|mesh|gcall|#dm=|call=1|dm-mesh|videocall|video\s*call|\bmeet(ing)?\b/i.test(
        String(msg.content ?? ""),
      );
      const isDmSocketMessage = !!directChatId;
      const wantPing = key && !muted && !fromMe && (!isActive || tabHidden);
      const canBrowserOsNotify =
        wantPing &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        (browserNotifyRef.current || isCallOrMeetHint || isDmSocketMessage);

      const bodyPreview =
        msg.type === "voice"
          ? "Голосовое сообщение"
          : msg.type === "file"
            ? "Файл"
            : (msg.content || "Новое сообщение").slice(0, 160);
      const fromLabelPreview = displayUserNameForSidebar(msg.author as any, String(msg.author?.email ?? "Участник"));

      if (wantPing) {
        try {
          if (typeof navigator !== "undefined" && typeof (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }).vibrate === "function") {
            (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }).vibrate?.(85);
          }
        } catch {
          /* ignore */
        }
      }

      let osShown = false;
      if (canBrowserOsNotify) {
        try {
          const n = new Notification(fromLabelPreview || "Новое сообщение", {
            body: bodyPreview,
            tag: key ? `${key}:${msg.id}` : "dm",
          });
          osShown = true;
          n.onclick = () => {
            try {
              window.focus();
            } catch {
              /* ignore */
            }
            try {
              if (key) void openChatFromList(key);
            } catch {
              /* ignore */
            }
            try {
              n.close();
            } catch {
              /* ignore */
            }
          };
        } catch {
          /* ignore */
        }
      }
      if (wantPing && !osShown) {
        pushAppToast(`${fromLabelPreview}: ${bodyPreview.slice(0, 120)}`);
      }
      if (
        key &&
        !muted &&
        !fromMe &&
        browserNotifyRef.current &&
        (typeof window === "undefined" || !(window as any).isSecureContext) &&
        typeof Notification !== "undefined"
      ) {
        // Notification API часто не работает без https/localhost
        pushLog("⚠️ Уведомления: нужен https (или localhost) для Windows-уведомлений браузера");
      } else if (
        key &&
        !muted &&
        !fromMe &&
        browserNotifyRef.current &&
        typeof Notification !== "undefined" &&
        Notification.permission !== "granted"
      ) {
        pushLog(`⚠️ Уведомления: permission=${Notification.permission}`);
      }

      if (!isActive) {
        if (key && !muted) {
          setUnreadByKey((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
        }
        return;
      }

      // Active chat: append + mark read
      setUnreadByKey((prev) => {
        if (!key) return prev;
        if (!prev[key]) return prev;
        const next = { ...prev };
        next[key] = 0;
        return next;
      });
      setMessages((prev) => (prev.some((x) => x.id === msg.id) ? prev : [...prev, msg]));
      if (msg.file?.id && !msg.file.downloadUrl) void hydrateDownloadUrl(String(msg.file.id));
    });
    s.on("message:update", (m: any) => {
      const id = String(m?.id ?? "");
      if (!id) return;
      const existingRow = messagesRef.current.find((x) => x.id === id);
      const mergedFile = mergeSocketFilePayload(existingRow?.file, m);
      if (mergedFile?.id && !mergedFile.downloadUrl) void hydrateDownloadUrl(String(mergedFile.id));
      setMessages((prev) =>
        prev.map((x) =>
          x.id === id
            ? {
                ...x,
                content: String(m.content ?? ""),
                type: m.type ?? x.type,
                parentMessageId: m.parentMessageId ?? x.parentMessageId ?? null,
                file: mergeSocketFilePayload(x.file, m),
                reactions: Array.isArray(m.reactions) ? m.reactions : x.reactions,
                editedAt: m.editedAt ?? x.editedAt ?? null,
                isDeleted: typeof m.isDeleted === "boolean" ? m.isDeleted : x.isDeleted,
              }
            : x,
        ),
      );
    });
    s.on("message:delete", (evt: any) => {
      const id = String(evt?.id ?? "");
      if (!id) return;
      setMessages((prev) =>
        prev.map((x) =>
          x.id === id
            ? {
                ...x,
                content: "",
                _localError: undefined,
                isDeleted: true,
              }
            : x,
        ),
      );
    });
    s.on("reaction:update", (evt: any) => {
      const messageId = String(evt?.messageId ?? "");
      const reactions = Array.isArray(evt?.reactions) ? (evt.reactions as Reaction[]) : [];
      if (!messageId) return;
      setMessages((prev) => prev.map((mm) => (mm.id === messageId ? { ...mm, reactions } : mm)));
    });
    s.on("typing:start", (evt: any) => {
      const typingId = String(evt?.userId ?? "");
      if (!typingId || typingId === userIdRef.current) return;
      if (modeRef.current === "channels" && String(evt?.channelId ?? "") !== activeChannelIdRef.current) return;
      if (modeRef.current === "groups" && String(evt?.groupChatId ?? "") !== activeGroupChatIdRef.current) return;
      if (modeRef.current === "dms" && String(evt?.directChatId ?? "") !== activeDirectChatIdRef.current) return;
      setTypingUserIds((prev) => (prev.includes(typingId) ? prev : [...prev, typingId].slice(0, 5)));
    });
    s.on("typing:stop", (evt: any) => {
      const typingId = String(evt?.userId ?? "");
      if (!typingId) return;
      setTypingUserIds((prev) => prev.filter((x) => x !== typingId));
    });
    s.on("file:status", (evt: any) => {
      const fileId = String(evt?.fileId ?? "");
      const status = String(evt?.avStatus ?? "unknown");
      pushLog(`Файл ${fileId}: статус ${status}`);

      const localId = fileId ? localFileMessageIdByFileIdRef.current.get(fileId) : undefined;
      if (localId) {
        if (status === "clean") {
          setMessages((prev) => prev.map((m) => (m.id === localId ? { ...m, _localFileState: undefined } : m)));
        } else if (status === "infected" || status === "blocked" || status === "error") {
          const reason = evt?.blockedReason ? String(evt.blockedReason) : "";
          setMessages((prev) =>
            prev.map((m) => (m.id === localId ? { ...m, _localFileState: "failed", _localError: reason || status } : m)),
          );
        }
      }
      if (fileId && status === "clean") {
        void hydrateDownloadUrl(fileId);
      }
    });
    s.on("thread:read", (evt: any) => {
      const channelId = evt?.channelId ? String(evt.channelId) : null;
      const groupChatId = evt?.groupChatId ? String(evt.groupChatId) : null;
      const directChatId = evt?.directChatId ? String(evt.directChatId) : null;
      const readerUserId = String(evt?.readerUserId ?? "");
      const lastReadAt = String(evt?.lastReadAt ?? "");
      if (!readerUserId || !lastReadAt) return;
      const key = channelId
        ? chatKeyFor("c", channelId)
        : groupChatId
          ? chatKeyFor("g", groupChatId)
          : directChatId
            ? chatKeyFor("d", directChatId)
            : "";
      if (!key) return;
      setThreadReadByKey((prev) => ({
        ...prev,
        [key]: { ...(prev[key] ?? {}), [readerUserId]: lastReadAt },
      }));
    });
    s.on("call:signal", (data: any) => {
      const gc = data?.groupChatId ? String(data.groupChatId) : "";
      const mesh = groupMeshSessionRef.current;
      if (gc && mesh && gc === mesh.groupChatId) {
        void mesh.handleSignal(data);
        return;
      }
      const from = String(data?.fromUserId ?? "");
      const p = data?.payload;
      if (!from || !p) return;
      if (gc && p.type === "ice" && p.candidate && !mesh) {
        const k = `${gc}:${from}`;
        meshSignalIceBufferRef.current[k] = meshSignalIceBufferRef.current[k] ?? [];
        meshSignalIceBufferRef.current[k].push(data);
        return;
      }
      if (gc && p.type === "offer" && p.sdp && !mesh && webrtcBusyRef.current && groupMeshJoiningRef.current) {
        meshOfferWhileJoiningRef.current.push(data);
        return;
      }
      if (gc && p.type === "offer" && p.sdp && !mesh) {
        setPendingGroupMeshIncoming(data);
        setGroupCallLiveAt((prev) => ({ ...prev, [gc]: Date.now() }));
        return;
      }
      // Trickle ICE до принятия входящего: иначе события теряются (слушатель в webrtcDm ещё не зарегистрирован).
      if (p.type === "ice" && p.candidate) {
        const ic = incomingCallRef.current;
        if (ic && from === ic.fromUserId) {
          incomingCallIceBufferRef.current.push({
            candidate: p.candidate,
            sdpMid: p.sdpMid,
            sdpMLineIndex: p.sdpMLineIndex,
          });
        }
        return;
      }
      if (p.type !== "offer" || !p.sdp) return;
      const uid = userIdRef.current;
      if (!uid || from === uid) return;
      /** Сервер пропускает только участников одной организации; локальный список DM может быть ещё не загружен. */
      if (webrtcBusyRef.current) return;
      incomingCallIceBufferRef.current = [];
      const audioOnly = !String(p.sdp).includes("m=video");
      setIncomingCall({ fromUserId: from, offerSdp: p.sdp, audioOnly });
      const callerLabel = displayUser(from);
      let incomingCallOs = false;
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          const n = new Notification(callerLabel || "Входящий звонок", {
            body: audioOnly ? "Входящий аудиозвонок" : "Входящий видеозвонок",
            tag: `call:${from}:${Date.now()}`,
            requireInteraction: typeof document !== "undefined" && document.hidden,
          });
          incomingCallOs = true;
          n.onclick = () => {
            try {
              window.focus();
            } catch {
              /* ignore */
            }
            try {
              n.close();
            } catch {
              /* ignore */
            }
          };
        } catch {
          /* ignore */
        }
      }
      if (!incomingCallOs) {
        pushAppToast(`${callerLabel || "Входящий звонок"} — ${audioOnly ? "аудио" : "видео"}`);
      }
      try {
        if (typeof navigator !== "undefined" && typeof (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }).vibrate === "function") {
          (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }).vibrate?.([90, 60, 90]);
        }
      } catch {
        /* ignore */
      }
    });
    s.on("call:end", (data: any) => {
      const from = String(data?.fromUserId ?? "");
      if (!from) return;
      groupMeshSessionRef.current?.handleCallEnd(from);
    });
    s.on("call:hand", (data: any) => {
      const from = String(data?.fromUserId ?? "");
      if (!from) return;
      const raised = !!data?.raised;
      const meshGid = groupMeshUiRef.current?.groupChatId;
      if (meshGid?.startsWith(DM_MESH_PREFIX)) {
        const dcId = meshGid.slice(DM_MESH_PREFIX.length);
        const dc = directChatsRef.current.find((d) => d.id === dcId);
        const peer = dc?.userIds.find((id) => id !== userIdRef.current) ?? "";
        if (peer && from === peer) {
          setGroupMeshHands((prev) => ({ ...prev, [from]: raised }));
        }
        return;
      }
      if (from !== webrtcPeerRef.current) return;
      setWebrtcPeerHandRaised(raised);
    });
    s.on("groupCall:hand", (data: any) => {
      const gc = String(data?.groupChatId ?? "");
      const from = String(data?.fromUserId ?? "");
      const raised = !!data?.raised;
      if (!gc || !from) return;
      if (groupMeshUiRef.current?.groupChatId !== gc) return;
      setGroupMeshHands((prev) => ({ ...prev, [from]: raised }));
    });
    s.on("groupCall:invite", (data: any) => {
      const from = String(data?.fromUserId ?? "");
      const gc = String(data?.groupChatId ?? "");
      const audioOnly = !!data?.audioOnly;
      if (!from || !gc) return;
      if (from === userIdRef.current) return;
      const u = usersRef.current.find((x) => x.id === from);
      const label = displayUserNameForSidebar(u, from);
      const tabHidden = typeof document !== "undefined" && document.hidden;
      let showed = false;
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          const n = new Notification("Групповой звонок", {
            body: `${label} — ${audioOnly ? "аудио" : "видео"}. Откройте приложение.`,
            tag: `gcall-inv:${gc}`,
            requireInteraction: tabHidden,
          });
          showed = true;
          n.onclick = () => {
            try {
              window.focus();
            } catch {
              /* ignore */
            }
            try {
              n.close();
            } catch {
              /* ignore */
            }
          };
        } catch {
          /* ignore */
        }
      }
      if (!showed) {
        pushAppToast(`Групповой звонок: ${label} (${audioOnly ? "аудио" : "видео"})`);
      }
      setGroupCallLiveAt((prev) => ({ ...prev, [gc]: Date.now() }));
      try {
        if (typeof navigator !== "undefined" && typeof (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }).vibrate === "function") {
          (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }).vibrate?.([80, 50, 80]);
        }
      } catch {
        /* ignore */
      }
      pushLog(`Групповой звонок: ${label}`);
    });
    s.on("dmCall:notify", (data: any) => {
      const meshId = String(data?.meshGroupChatId ?? "");
      if (!meshId) return;
      setGroupCallLiveAt((prev) => ({ ...prev, [meshId]: Date.now() }));
      const from = String(data?.fromUserId ?? "");
      const audioOnly = !!data?.audioOnly;
      const label = from ? displayUserNameForSidebar(usersRef.current.find((x) => x.id === from), from) : "Собеседник";
      pushAppToast(`${label} — ${audioOnly ? "аудио" : "видео"} созвон`);
      try {
        if (
          typeof Notification !== "undefined" &&
          Notification.permission === "granted" &&
          (browserNotifyRef.current || typeof document === "undefined" || document.hidden)
        ) {
          new Notification("Личный созвон", {
            body: `${label} — ${audioOnly ? "звонок" : "видеозвонок"}`,
            tag: `dmcall:${meshId}`,
          });
        }
      } catch {
        /* ignore */
      }
    });
    s.on("dmCall:end", (data: any) => {
      const meshId = String(data?.meshGroupChatId ?? "");
      if (!meshId) return;
      setGroupCallLiveAt((prev) => {
        if (prev[meshId] == null) return prev;
        const { [meshId]: _, ...rest } = prev;
        return rest;
      });
    });
    socketRef.current = s;
    setSocket(s);
  }

  useEffect(() => {
    if (!token) return;
    const s = socketRef.current as (Socket & { auth?: { token?: string } }) | null;
    if (s) {
      s.auth = { ...(s.auth ?? {}), token };
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const onVisible = () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      const s = socketRef.current;
      if (s && !s.connected) {
        try {
          s.connect();
        } catch {
          /* ignore */
        }
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, [token]);

  function emitTypingStart() {
    if (!socket) return;
    if (mode === "channels" && activeChannelId) socket.emit("typing:start", { channelId: activeChannelId });
    else if (mode === "groups" && activeGroupChatId) socket.emit("typing:start", { groupChatId: activeGroupChatId });
    else if (mode === "dms" && activeDirectChatId) socket.emit("typing:start", { directChatId: activeDirectChatId });
  }
  function emitTypingStop() {
    if (!socket) return;
    if (mode === "channels" && activeChannelId) socket.emit("typing:stop", { channelId: activeChannelId });
    else if (mode === "groups" && activeGroupChatId) socket.emit("typing:stop", { groupChatId: activeGroupChatId });
    else if (mode === "dms" && activeDirectChatId) socket.emit("typing:stop", { directChatId: activeDirectChatId });
  }

  function onComposerChanged(nextValue: string) {
    setNewMessage(nextValue);
    // Auto-grow textarea like Telegram
    queueMicrotask(() => {
      const el = composerRef.current;
      if (!el) return;
      el.style.height = "0px";
      const next = Math.min(160, Math.max(40, el.scrollHeight));
      el.style.height = `${next}px`;
    });
    if (!socket) return;
    const hasText = !!nextValue.trim();
    if (!hasText) {
      if (typingRef.current.stopTimerId) window.clearTimeout(typingRef.current.stopTimerId);
      typingRef.current.stopTimerId = null;
      if (typingRef.current.started) {
        typingRef.current.started = false;
        emitTypingStop();
      }
      return;
    }
    if (!typingRef.current.started) {
      typingRef.current.started = true;
      emitTypingStart();
    }
    if (typingRef.current.stopTimerId) window.clearTimeout(typingRef.current.stopTimerId);
    typingRef.current.stopTimerId = window.setTimeout(() => {
      typingRef.current.stopTimerId = null;
      if (typingRef.current.started) {
        typingRef.current.started = false;
        emitTypingStop();
      }
    }, 1500);
  }

  async function loadChannels(opts?: { emptySelection?: boolean }) {
    if (!token || !workspaceId) return;
    const data = await gql<{ channels: Channel[] }>(
      `query($workspaceId: ID!) { channels(workspaceId: $workspaceId) { id workspaceId name type avatarUrl createdByUserId } }`,
      { workspaceId },
      token,
    );
    setChannels(data.channels);
    setActiveChannelId((prev) => {
      const ids = new Set(data.channels.map((c) => c.id));
      if (prev && ids.has(prev)) return prev;
      if (prev === "") return "";
      if (opts?.emptySelection) return "";
      return data.channels[0]?.id ?? "";
    });
    pushLog(`Каналов: ${data.channels.length}`);
  }

  async function loadGroupChats(opts?: { emptySelection?: boolean }) {
    if (!token) return;
    const data = await gql<{ groupChats: GroupChat[] }>(
      `query { groupChats { id name memberIds createdByUserId avatarUrl } }`,
      {},
      token,
    );
    setGroupChats(data.groupChats);
    setActiveGroupChatId((prev) => {
      const ids = new Set(data.groupChats.map((g) => g.id));
      if (prev && ids.has(prev)) return prev;
      if (prev === "") return "";
      if (opts?.emptySelection) return "";
      return data.groupChats[0]?.id ?? "";
    });
    pushLog(`Групп: ${data.groupChats.length}`);
  }

  async function loadDirectChats(opts?: { emptySelection?: boolean }) {
    if (!token) return;
    const data = await gql<{ dms: DirectChat[] }>(`query { dms { id userIds } }`, {}, token);
    setDirectChats(data.dms);
    setActiveDirectChatId((prev) => {
      const ids = new Set(data.dms.map((d) => d.id));
      if (prev && ids.has(prev)) return prev;
      if (prev === "") return "";
      if (opts?.emptySelection) return "";
      return data.dms[0]?.id ?? "";
    });
    pushLog(`DM: ${data.dms.length}`);
  }

  async function openChatFromList(raw: string) {
    const value = String(raw || "");
    if (!value) return;
    const [kind, id] = value.split(":");
    if (!id) return;
    if (kind === "c") {
      // Не ломаем выбранный фильтр: если пользователь в "Все чаты" — остаёмся там
      setChatListScope((prev) => (prev === "all" ? prev : "channels"));
      setMode("channels");
      setActiveChannelId(id);
      setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("c", id)]: 0 }));
      return;
    }
    if (kind === "g") {
      setChatListScope((prev) => (prev === "all" ? prev : "groups"));
      setMode("groups");
      setActiveGroupChatId(id);
      setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("g", id)]: 0 }));
      return;
    }
    if (kind === "d") {
      setChatListScope((prev) => (prev === "all" ? prev : "dms"));
      setMode("dms");
      setActiveDirectChatId(id);
      setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("d", id)]: 0 }));
    }
  }

  async function sendServiceMessageToCurrentChat(content: string) {
    if (!token || !content.trim()) return;
    if (mode === "channels") {
      if (!activeChannelId) return;
      const data = await gql<{ sendMessage: Message }>(
        `mutation($channelId: ID!, $content: String!) {
          sendMessage(input: { channelId: $channelId, content: $content }) { id content createdAt author { email } type }
        }`,
        { channelId: activeChannelId, content },
        token,
      );
      setMessages((prev) => [...prev, data.sendMessage]);
      return;
    }
    if (mode === "groups") {
      if (!activeGroupChatId) return;
      const data = await gql<{ sendGroupChatMessage: Message }>(
        `mutation($groupChatId: ID!, $content: String!) {
          sendGroupChatMessage(input: { groupChatId: $groupChatId, content: $content }) { id content createdAt author { email } type }
        }`,
        { groupChatId: activeGroupChatId, content },
        token,
      );
      setMessages((prev) => [...prev, data.sendGroupChatMessage]);
      return;
    }
    if (mode === "dms") {
      if (!activeDirectChat) return;
      const isSelfDm =
        activeDirectChat.userIds.length === 1 && activeDirectChat.userIds[0] === userId;
      const peerUserId = isSelfDm
        ? userId
        : (activeDirectChat.userIds.find((id) => id !== userId) ?? "");
      if (!peerUserId) return;
      const data = await gql<{ sendDirectMessage: DirectChatMessage }>(
        `mutation($userId: ID!, $content: String!) {
          sendDirectMessage(input: { userId: $userId, content: $content }) { id content createdAt author { email } type directChatId }
        }`,
        { userId: peerUserId, content },
        token,
      );
      setMessages((prev) => [
        ...prev,
        {
          id: data.sendDirectMessage.id,
          content: data.sendDirectMessage.content,
          createdAt: data.sendDirectMessage.createdAt,
          author: data.sendDirectMessage.author,
          type: data.sendDirectMessage.type,
        },
      ]);
    }
  }

  function scrollToMessageInChat(messageId: string) {
    const safe = messageId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const el = document.querySelector(`[data-message-id="${safe}"]`);
    if (!el || !(el instanceof HTMLElement)) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("msg--searchHit");
    window.setTimeout(() => el.classList.remove("msg--searchHit"), 2200);
  }

  async function runThreadSearch() {
    const q = threadSearchQ.trim();
    if (!token || !q) return;
    setThreadSearchOpen(true);
    try {
      const vars =
        mode === "channels" && activeChannelId
          ? { query: q, limit: 50, channelId: activeChannelId, groupChatId: null, directChatId: null }
          : mode === "groups" && activeGroupChatId
            ? { query: q, limit: 50, channelId: null, groupChatId: activeGroupChatId, directChatId: null }
            : mode === "dms" && activeDirectChatId
              ? { query: q, limit: 50, channelId: null, groupChatId: null, directChatId: activeDirectChatId }
              : null;
      if (!vars) {
        setChatError("Откройте чат для поиска по сообщениям");
        return;
      }
      const data = await gql<{ searchMessages: Message[] }>(
        `query($query: String!, $limit: Int!, $channelId: ID, $groupChatId: ID, $directChatId: ID) {
          searchMessages(query: $query, limit: $limit, channelId: $channelId, groupChatId: $groupChatId, directChatId: $directChatId) {
            id content createdAt author { email firstName middleName lastName }
          }
        }`,
        vars,
        token,
      );
      setThreadSearchHits(data.searchMessages);
      pushLog(`Поиск в чате: ${data.searchMessages.length} совпадений`);
    } catch (e: any) {
      setChatError(String(e?.message ?? e));
    }
  }

  async function openReadReceipts(messageId: string) {
    if (!token) return;
    try {
      const data = await gql<{
        messageReaders: { id: string; email: string; firstName?: string | null; lastName?: string | null }[];
      }>(`query($id: ID!) { messageReaders(messageId: $id) { id email firstName lastName } }`, { id: messageId }, token);
      setReadReceiptUsers(data.messageReaders);
      setReadReceiptModalForId(messageId);
    } catch (e: any) {
      setChatError(String(e?.message ?? e));
    }
  }

  async function acceptIncomingCall() {
    if (!incomingCall || !socket) return;
    if (webrtcBusyRef.current) return;
    webrtcBusyRef.current = true;
    const { fromUserId, offerSdp, audioOnly } = incomingCall;
    setIncomingCall(null);
    const preBufferedIceCandidates = incomingCallIceBufferRef.current.splice(0, incomingCallIceBufferRef.current.length);
    let pendingRemoteStream: MediaStream | null = null;
    try {
      const ac = await acceptIncomingOffer(socket, {
        fromUserId,
        offerSdp,
        audioOnly,
        preBufferedIceCandidates,
        onRemoteStream: (stream) => {
          setWebrtcUi((prev) => {
            if (prev) return { ...prev, remoteStream: stream };
            pendingRemoteStream = stream;
            return prev;
          });
        },
        onClose: () => {
          webrtcBusyRef.current = false;
          webrtcPeerRef.current = "";
          setWebrtcPeerHandRaised(false);
          setWebrtcLocalHandRaised(false);
          setWebrtcScreenSharing(false);
          setWebrtcUi(null);
        },
      });
      attachWebrtcDiagnostics(ac.pc, `in:${fromUserId}`);
      webrtcPeerRef.current = fromUserId;
      setWebrtcMicOn(true);
      setWebrtcCamOn(!audioOnly);
      setWebrtcPeerHandRaised(false);
      setWebrtcLocalHandRaised(false);
      setWebrtcUi({
        localStream: ac.localStream,
        remoteStream: pendingRemoteStream,
        hangup: () => {
          webrtcPeerRef.current = "";
          setWebrtcPeerHandRaised(false);
          setWebrtcLocalHandRaised(false);
          setWebrtcScreenSharing(false);
          ac.hangup();
        },
        audioOnly,
        activeCall: ac,
        callPeerId: fromUserId,
      });
    } catch (e: any) {
      webrtcBusyRef.current = false;
      setChatError(String(e?.message ?? e));
      diagLog(`acceptIncomingCall error: ${String(e?.name ?? "")} ${String(e?.message ?? e)}`);
    }
  }

  function declineIncomingCall() {
    if (!incomingCall || !socket) return;
    socket.emit("call:end", { targetUserId: incomingCall.fromUserId });
    incomingCallIceBufferRef.current = [];
    setIncomingCall(null);
  }

  const hangupGroupMesh = useCallback(() => {
    const ui = groupMeshUiRef.current;
    const sock = socketRef.current;
    if (ui?.groupChatId?.startsWith(DM_MESH_PREFIX) && sock) {
      sock.emit("dmCall:end", {
        directChatId: ui.groupChatId.slice(DM_MESH_PREFIX.length),
        meshGroupChatId: ui.groupChatId,
      });
    }
    groupMeshSessionRef.current?.hangupAll();
    groupMeshSessionRef.current = null;
    setGroupMeshUi(null);
    webrtcBusyRef.current = false;
    groupMeshJoiningRef.current = false;
  }, []);

  async function joinGroupMeshFromPeerOffer(
    data: any,
    mediaPrefs?: { mic: boolean; cam: boolean },
  ) {
    if (groupMeshJoiningRef.current || groupMeshSessionRef.current) return;
    if (webrtcBusyRef.current) {
      setChatError("Сначала завершите текущий звонок");
      return;
    }
    const gc = String(data?.groupChatId ?? "");
    const from = String(data?.fromUserId ?? "");
    const p = data?.payload;
    if (!gc || !from || !p || p.type !== "offer" || !p.sdp) return;
    const uid = userIdRef.current;
    if (!uid || from === uid) return;
    const sock = socketRef.current;
    if (!sock) return;
    let resolvedTitle = "";
    let memberIds: string[] = [];
    let isDmMesh = false;
    if (gc.startsWith(DM_MESH_PREFIX)) {
      isDmMesh = true;
      const directChatId = gc.slice(DM_MESH_PREFIX.length);
      const dc = directChatsRef.current.find((d) => d.id === directChatId);
      if (!dc) {
        pushLog("Входящий личный звонок: откройте список личных чатов или обновите страницу.");
        return;
      }
      const other = dc.userIds.find((id) => id !== uid) ?? "";
      if (!other) {
        setChatError("Нет собеседника для ответа на звонок");
        return;
      }
      memberIds = [other];
      const u = usersRef.current.find((x) => x.id === other);
      resolvedTitle = displayUserNameForSidebar(u, other);
    } else {
      const g = groupChatsRef.current.find((x) => x.id === gc);
      if (!g) {
        pushLog("Входящий групповой звонок: откройте список групп или обновите страницу.");
        return;
      }
      memberIds = (g.memberIds ?? []).filter((id) => id !== uid);
      resolvedTitle = g.name;
    }
    groupMeshJoiningRef.current = true;
    webrtcBusyRef.current = true;
    const audioOnly = !String(p.sdp).includes("m=video");
    const initialMic = mediaPrefs?.mic ?? true;
    const initialCam = mediaPrefs != null ? mediaPrefs.cam && !audioOnly : !audioOnly;
    const callerLabel = displayUser(from);
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification(isDmMesh ? "Личный звонок" : `Группа: ${resolvedTitle}`, {
            body: isDmMesh
              ? `${callerLabel} — ${audioOnly ? "звонок" : "видеозвонок"}`
              : `${callerLabel} — групповой ${audioOnly ? "звонок" : "видеозвонок"}`,
            tag: isDmMesh ? `dmcall:${gc}` : `gcall:${gc}`,
            requireInteraction: typeof document !== "undefined" && document.hidden,
          });
        } catch {
          /* ignore */
        }
      } else {
        pushAppToast(
          isDmMesh ? `Личный звонок: ${callerLabel}` : `Групповой звонок: ${resolvedTitle} (${callerLabel})`,
        );
      }
    } catch {
      /* ignore */
    }
    try {
      const { session, localStream, peerIds } = await createGroupMeshSession(sock, {
        groupChatId: gc,
        myUserId: uid,
        peerUserIds: memberIds,
        audioOnly,
        initialMicEnabled: initialMic,
        initialCamEnabled: initialCam,
        onRemoteStream: (peerId, stream) => {
          setGroupMeshUi((prev) => (prev ? { ...prev, remotes: { ...prev.remotes, [peerId]: stream } } : prev));
        },
        onPeerDisconnected: (peerId) => {
          setGroupMeshHands((prev) => {
            const { [peerId]: _, ...rest } = prev;
            return rest;
          });
          setGroupMeshUi((prev) => {
            if (!prev) return prev;
            const { [peerId]: _, ...rest } = prev.remotes;
            return { ...prev, remotes: rest };
          });
        },
      });
      groupMeshSessionRef.current = session;
      setGroupMeshUi({
        title: resolvedTitle,
        groupChatId: gc,
        audioOnly,
        localStream,
        remotes: {},
        hangup: hangupGroupMesh,
      });
      setGroupCallLiveAt((prev) => ({ ...prev, [gc]: Date.now() }));
      const bufKey = `${gc}:${from}`;
      const buffered = meshSignalIceBufferRef.current[bufKey];
      if (buffered?.length) {
        for (const sig of buffered) {
          void session.handleSignal(sig as Parameters<GroupMeshSession["handleSignal"]>[0]);
        }
        delete meshSignalIceBufferRef.current[bufKey];
      }
      await session.handleSignal(data);
      const extra = meshOfferWhileJoiningRef.current.splice(0, meshOfferWhileJoiningRef.current.length);
      for (const sig of extra) {
        void session.handleSignal(sig as Parameters<GroupMeshSession["handleSignal"]>[0]);
      }
      await session.startOfferers(peerIds);
    } catch (e: any) {
      setChatError(String(e?.message ?? e));
      groupMeshSessionRef.current = null;
      setGroupMeshUi(null);
      webrtcBusyRef.current = false;
      meshOfferWhileJoiningRef.current = [];
    } finally {
      groupMeshJoiningRef.current = false;
    }
  }
  joinGroupMeshFromPeerOfferRef.current = joinGroupMeshFromPeerOffer;

  async function startGroupMesh(prefs: { video: boolean; mic: boolean }) {
    setPendingGroupMeshIncoming(null);
    if (!canStartCalls) {
      setChatError("Недостаточно прав для звонков");
      return;
    }
    const sock = socketRef.current;
    if (!activeGroupChat || !userId || !sock) {
      setChatError("Откройте группу и дождитесь подключения");
      return;
    }
    if (webrtcBusyRef.current) return;
    const memberIds = (activeGroupChat.memberIds ?? []).filter((id) => id !== userId);
    if (memberIds.length === 0) {
      setChatError("Нет других участников в группе");
      return;
    }
    const audioOnly = !prefs.video;
    webrtcBusyRef.current = true;
    try {
      const { session, localStream, peerIds } = await createGroupMeshSession(sock, {
        groupChatId: activeGroupChat.id,
        myUserId: userId,
        peerUserIds: memberIds,
        audioOnly,
        initialMicEnabled: prefs.mic,
        initialCamEnabled: prefs.video,
        onRemoteStream: (peerId, stream) => {
          setGroupMeshUi((prev) => (prev ? { ...prev, remotes: { ...prev.remotes, [peerId]: stream } } : prev));
        },
        onPeerDisconnected: (peerId) => {
          setGroupMeshHands((prev) => {
            const { [peerId]: _, ...rest } = prev;
            return rest;
          });
          setGroupMeshUi((prev) => {
            if (!prev) return prev;
            const { [peerId]: _, ...rest } = prev.remotes;
            return { ...prev, remotes: rest };
          });
        },
      });
      groupMeshSessionRef.current = session;
      const base = `${window.location.origin}${window.location.pathname}`;
      const inviteUrl = `${base}#group=${encodeURIComponent(activeGroupChat.id)}&gcall=1`;
      setGroupMeshUi({
        title: activeGroupChat.name,
        groupChatId: activeGroupChat.id,
        audioOnly,
        localStream,
        remotes: {},
        hangup: hangupGroupMesh,
      });
      setGroupCallLiveAt((prev) => ({ ...prev, [activeGroupChat.id]: Date.now() }));
      await session.startOfferers(peerIds);
      sock.emit("groupCall:invite", { groupChatId: activeGroupChat.id, audioOnly, inviteUrl });
      void sendServiceMessageToCurrentChat(inviteUrl);
      pushLog("Групповой mesh-созвон");
    } catch (e: any) {
      setChatError(String(e?.message ?? e));
      groupMeshSessionRef.current = null;
      setGroupMeshUi(null);
      webrtcBusyRef.current = false;
    }
  }

  async function startDmCall(prefs: { video: boolean; mic: boolean }) {
    setPendingGroupMeshIncoming(null);
    if (!canStartCalls) {
      setChatError("Недостаточно прав для звонков");
      return;
    }
    const sock = socketRef.current;
    if (!activeDirectChat || !userId || !sock) {
      setChatError("Откройте личный чат и дождитесь подключения");
      return;
    }
    if (isSelfNotesActiveDm) {
      setChatError("Нельзя позвонить в «Избранное»");
      return;
    }
    const otherId = activeDirectChat.userIds.find((id) => id !== userId) ?? activeDirectChat.userIds[0] ?? "";
    if (!otherId || otherId === userId) {
      setChatError("Нет собеседника для звонка");
      return;
    }
    if (webrtcBusyRef.current) return;
    const meshId = dmMeshGroupChatId(activeDirectChat.id);
    const audioOnly = !prefs.video;
    webrtcBusyRef.current = true;
    try {
      const { session, localStream, peerIds } = await createGroupMeshSession(sock, {
        groupChatId: meshId,
        myUserId: userId,
        peerUserIds: [otherId],
        audioOnly,
        initialMicEnabled: prefs.mic,
        initialCamEnabled: prefs.video,
        onRemoteStream: (peerId, stream) => {
          setGroupMeshUi((prev) => (prev ? { ...prev, remotes: { ...prev.remotes, [peerId]: stream } } : prev));
        },
        onPeerDisconnected: (peerId) => {
          setGroupMeshHands((prev) => {
            const { [peerId]: _, ...rest } = prev;
            return rest;
          });
          setGroupMeshUi((prev) => {
            if (!prev) return prev;
            const { [peerId]: _, ...rest } = prev.remotes;
            return { ...prev, remotes: rest };
          });
        },
      });
      groupMeshSessionRef.current = session;
      const u = users.find((x) => x.id === otherId);
      const title = displayUserNameForSidebar(u, otherId);
      setGroupMeshUi({
        title,
        groupChatId: meshId,
        audioOnly,
        localStream,
        remotes: {},
        hangup: hangupGroupMesh,
      });
      setGroupCallLiveAt((prev) => ({ ...prev, [meshId]: Date.now() }));
      await session.startOfferers(peerIds);
      sock.emit("dmCall:notify", {
        directChatId: activeDirectChat.id,
        meshGroupChatId: meshId,
        audioOnly,
      });
      const base = `${window.location.origin}${window.location.pathname}`;
      const inviteUrl = `${base}#dm=${encodeURIComponent(activeDirectChat.id)}&call=1`;
      void sendServiceMessageToCurrentChat(inviteUrl);
      pushLog("Личный созвон (mesh)");
    } catch (e: any) {
      setChatError(String(e?.message ?? e));
      groupMeshSessionRef.current = null;
      setGroupMeshUi(null);
      webrtcBusyRef.current = false;
      diagLog(`startDmCall error: ${String(e?.name ?? "")} ${String(e?.message ?? e)}`);
    }
  }

  function copyCallInviteLink() {
    setChatError("Созвон по ссылке — только в групповом чате: откройте группу и нажмите «🔗 Ссылка» в панели созвона.");
  }

  function copyGroupCallInviteLink() {
    const gid = groupMeshUi?.groupChatId ?? (mode === "groups" ? activeGroupChatId : "");
    if (!gid) {
      setChatError("Ссылка на групповой созвон: откройте группу или начните групповой звонок");
      return;
    }
    const base = `${window.location.origin}${window.location.pathname}`;
    if (gid.startsWith(DM_MESH_PREFIX)) {
      const dcid = gid.slice(DM_MESH_PREFIX.length);
      const link = `${base}#dm=${encodeURIComponent(dcid)}&call=1`;
      void navigator.clipboard.writeText(link);
      pushLog("Ссылка на личный созвон скопирована в буфер");
      return;
    }
    const link = `${base}#group=${encodeURIComponent(gid)}&gcall=1`;
    void navigator.clipboard.writeText(link);
    pushLog("Ссылка на групповой созвон скопирована в буфер");
  }

  function toggleWebrtcMic() {
    if (!webrtcUi) return;
    const next = !webrtcMicOn;
    webrtcUi.activeCall.setMicEnabled(next);
    setWebrtcMicOn(next);
  }

  function toggleWebrtcCam() {
    if (!webrtcUi || webrtcUi.audioOnly) return;
    const next = !webrtcCamOn;
    webrtcUi.activeCall.setCamEnabled(next);
    setWebrtcCamOn(next);
  }

  async function toggleWebrtcScreenShare() {
    if (!webrtcUi || webrtcUi.audioOnly) return;
    try {
      if (webrtcScreenSharing || webrtcUi.activeCall.isScreenSharing()) {
        await webrtcUi.activeCall.stopScreenShare();
        setWebrtcScreenSharing(false);
      } else {
        await webrtcUi.activeCall.startScreenShare();
        setWebrtcScreenSharing(true);
      }
    } catch (e: any) {
      setChatError(String(e?.message ?? e));
    }
  }

  function toggleLocalRaiseHand() {
    if (!socket || !webrtcUi) return;
    const next = !webrtcLocalHandRaised;
    setWebrtcLocalHandRaised(next);
    socket.emit("call:hand", { targetUserId: webrtcUi.callPeerId, raised: next });
  }

  function toggleGroupMeshRaiseHand() {
    if (!socket || !groupMeshUi || !userId) return;
    const next = !groupMeshHands[userId];
    const meshGid = groupMeshUi.groupChatId;
    if (meshGid.startsWith(DM_MESH_PREFIX)) {
      const dcId = meshGid.slice(DM_MESH_PREFIX.length);
      const dc = directChatsRef.current.find((d) => d.id === dcId);
      const peer = dc?.userIds.find((id) => id !== userId) ?? "";
      if (!peer) return;
      setGroupMeshHands((prev) => ({ ...prev, [userId]: next }));
      socket.emit("call:hand", { targetUserId: peer, raised: next });
      return;
    }
    setGroupMeshHands((prev) => ({ ...prev, [userId]: next }));
    socket.emit("groupCall:hand", { groupChatId: meshGid, raised: next });
  }

  async function loadUsers(tokenOverride?: string, orgIdOverride?: string) {
    const t = tokenOverride ?? token;
    const orgId = orgIdOverride ?? organizationId;
    if (!t || !orgId) return;
    const data = await gql<{
      users: {
        id: string;
        email: string;
        avatarUrl?: string | null;
        firstName?: string | null;
        middleName?: string | null;
        lastName?: string | null;
        birthDate?: string | null;
        role?: "owner" | "admin" | "manager" | "employee" | "guest" | null;
        department?: string | null;
        status?: string | null;
        lastSeen?: string | null;
      }[];
    }>(
      `query($organizationId: ID!) { users(organizationId: $organizationId) { id email avatarUrl phone firstName middleName lastName birthDate role department status lastSeen } }`,
      { organizationId: orgId },
      t,
    );
    const socketUp = !!socketRef.current?.connected;
    setUsers((prevUsers) => {
      const prevById = new Map(prevUsers.map((u) => [u.id, u]));
      return data.users.map((u) => {
        const prevU = prevById.get(u.id);
        let st =
          u.status != null && String(u.status).trim() !== ""
            ? String(u.status)
            : (prevU?.status ?? "offline");
        if (socketUp && prevU?.status === "online" && st === "offline") {
          st = "online";
        }
        return { ...u, status: st as typeof u.status };
      });
    });
    setPresenceByUserId((prev) => {
      const next = { ...prev };
      for (const u of data.users) {
        let st =
          u.status != null && String(u.status).trim() !== "" ? String(u.status) : (next[u.id]?.status ?? "offline");
        if (socketUp && next[u.id]?.status === "online" && st === "offline") {
          st = "online";
        }
        next[u.id] = {
          status: st,
          lastSeen: u.lastSeen != null ? String(u.lastSeen) : next[u.id]?.lastSeen,
        };
      }
      return next;
    });
    pushLog(`Пользователей: ${data.users.length}`);
  }
  loadUsersRef.current = loadUsers;

  useEffect(() => {
    if (!token || !organizationId) return;
    const el = sidebarChatsScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollTop > 0) return;
      if (e.deltaY >= 0) return;
      if (pullRefreshLockRef.current) return;
      pullRefreshLockRef.current = true;
      void refreshChatsAndPresenceRef.current?.();
      pushLog("Список чатов и статусы обновлены.");
      window.setTimeout(() => {
        pullRefreshLockRef.current = false;
      }, 2800);
    };
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (el.scrollTop > 0) return;
      const y = e.touches[0]?.clientY ?? 0;
      if (y - touchStartY > 64) {
        if (pullRefreshLockRef.current) return;
        pullRefreshLockRef.current = true;
        void refreshChatsAndPresenceRef.current?.();
        pushLog("Список чатов и статусы обновлены.");
        touchStartY = y + 9999;
        window.setTimeout(() => {
          pullRefreshLockRef.current = false;
        }, 2800);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [token, organizationId, viewportW]);

  useEffect(() => {
    if (!token || !organizationId) return;
    const refresh = () => void loadUsersRef.current?.();
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      refresh();
    };
    const onFocus = () => refresh();
    const onPageShow = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [token, organizationId]);

  useEffect(() => {
    if (!token || !organizationId) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadUsersRef.current?.();
    }, 20_000);
    return () => window.clearInterval(id);
  }, [token, organizationId]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const savedChatKey = readTgLastOpenChatKey();
        /** Только если есть сохранённый чат — не выбираем «первый попавшийся» до открытия сохранённого. */
        const avoidAutoFirstChat = Boolean(savedChatKey);

        if (organizationId) {
          await loadUsers();
          if (cancelled) return;
        }
        await loadGroupChats({ emptySelection: avoidAutoFirstChat });
        if (cancelled) return;
        await loadDirectChats({ emptySelection: avoidAutoFirstChat });
        if (cancelled) return;
        if (workspaceId) await loadChannels({ emptySelection: avoidAutoFirstChat });
        if (cancelled) return;
        connectSocket();
        try {
          const folderData = await gql<{ me: { id: string; chatFoldersJson?: string | null } }>(
            `query { me { id chatFoldersJson } }`,
            {},
            token,
          );
          const meId = folderData.me?.id;
          const raw = folderData.me?.chatFoldersJson;
          const remote = raw && String(raw).trim() ? parseChatFolderStateJson(String(raw)) : null;
          const local = loadChatFolders();
          const remoteNonempty = remote && (remote.folders.length > 0 || Object.keys(remote.assignment).length > 0);
          if (remoteNonempty && remote) {
            chatFoldersSkipServerSaveRef.current = true;
            setUserChatFolderLayout(remote);
            saveChatFolders(remote);
          } else if (
            (local.folders.length > 0 || Object.keys(local.assignment).length > 0) &&
            meId
          ) {
            await gql(
              `mutation($input: UpdateUserInput!) { updateUser(input: $input) { id } }`,
              { input: { userId: meId, chatFoldersJson: JSON.stringify(local) } },
              token,
            );
          }
        } catch {
          /* ignore */
        } finally {
          chatFoldersHydratedRef.current = true;
        }
        try {
          if (savedChatKey) await openChatFromList(savedChatKey);
        } catch {
          /* ignore */
        }
      } catch (e) {
        console.error(e);
        if (isUnauthorizedError(e)) {
          setAuthError("Сессия истекла. Войдите снова.");
          await logout();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstrap runs when session/workspace is ready; chat loaders are stable enough for this app
  }, [token, organizationId, workspaceId]);

  useEffect(() => {
    if (!token || !organizationId) {
      setOrgBrandName("");
      setOrgBrandLogoUrl("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await gql<{ organization: { name: string; logoUrl?: string | null } }>(
          `query($id: ID!) { organization(organizationId: $id) { name logoUrl } }`,
          { id: organizationId },
          token,
        );
        if (!cancelled) {
          setOrgBrandName(data.organization.name ?? "");
          setOrgBrandLogoUrl(data.organization.logoUrl?.trim() ?? "");
        }
      } catch {
        if (!cancelled) {
          setOrgBrandName("");
          setOrgBrandLogoUrl("");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, organizationId]);

  async function loadMyProfile() {
    if (!token) return;
    const data = await gql<{
      me: {
        id: string;
        email: string;
        firstName?: string | null;
        lastName?: string | null;
        middleName?: string | null;
        birthDate?: string | null;
        avatarUrl?: string | null;
        statusText?: string | null;
        title?: string | null;
        department?: string | null;
        role?: string | null;
        phone?: string | null;
      };
    }>(
      `query {
        me {
          id
          email
          phone
          firstName
          lastName
          middleName
          birthDate
          avatarUrl
          statusText
          title
          department
          role
        }
      }`,
      {},
      token,
    );
    setMyProfileId(data.me.id);
    setMyProfileEmail(data.me.email);
    setProfileFirstName(data.me.firstName || "");
    setProfileLastName(data.me.lastName || "");
    setProfileMiddleName(data.me.middleName || "");
    setProfileBirthDate(data.me.birthDate ? data.me.birthDate.slice(0, 10) : "");
    setProfileAvatarUrl(data.me.avatarUrl || "");
    setProfileStatusText(data.me.statusText || "");
    setProfileTitle(data.me.title || "");
    setProfileDepartment(data.me.department || "");
    setProfilePhone(data.me.phone || "");
    setViewerRole((data.me.role as any) ?? viewerRole);
  }

  useEffect(() => {
    if (!moreMenuOpen || !token) return;
    void loadMyProfile();
  }, [moreMenuOpen, token]);

  useEffect(() => {
    if (!token || !isSelfNotesActiveDm) return;
    void loadMyProfile();
  }, [token, isSelfNotesActiveDm]);

  function applyAvatarFromFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      if (!url.startsWith("data:image/")) {
        setProfileMsg("Аватар должен быть изображением");
        return;
      }
      setProfileAvatarUrl(url);
    };
    reader.onerror = () => setProfileMsg("Не удалось прочитать файл аватара");
    reader.readAsDataURL(file);
  }

  async function saveMyProfile() {
    if (!token || !myProfileId) return;
    const input: Record<string, unknown> = { userId: myProfileId };
    if (profileFirstName.trim()) input.firstName = profileFirstName.trim();
    if (profileLastName.trim()) input.lastName = profileLastName.trim();
    input.middleName = profileMiddleName.trim() || null;
    input.birthDate = profileBirthDate.trim()
      ? new Date(`${profileBirthDate.trim()}T12:00:00`).toISOString()
      : null;
    if (profileAvatarUrl.trim()) input.avatarUrl = profileAvatarUrl.trim();
    if (profileStatusText.trim()) input.statusText = profileStatusText.trim();
    input.phone = profilePhone.trim() ? profilePhone.trim() : null;
    await gql<{ updateUser: { id: string } }>(
      `mutation($input: UpdateUserInput!) {
        updateUser(input: $input) { id }
      }`,
      { input },
      token,
    );
    setProfileMsg("Профиль сохранен");
    await loadUsers();
  }

  function applyChatAvatarFromFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      if (!url.startsWith("data:image/")) {
        setChatMetaMsg("Аватар: нужен файл изображения");
        return;
      }
      setChatMetaAvatarData(url);
    };
    reader.onerror = () => setChatMetaMsg("Не удалось прочитать файл");
    reader.readAsDataURL(file);
  }

  async function saveChatMeta() {
    if (!token) return;
    setChatMetaMsg("");
    try {
      if (mode === "groups" && activeGroupChatId && canEditActiveGroupMeta) {
        const input: Record<string, unknown> = { groupChatId: activeGroupChatId };
        if (chatMetaNameDraft.trim()) input.name = chatMetaNameDraft.trim();
        input.avatarUrl = chatMetaAvatarData.trim() || null;
        const data = await gql<{ updateGroupChat: GroupChat }>(
          `mutation($input: UpdateGroupChatInput!) {
            updateGroupChat(input: $input) { id name memberIds createdByUserId avatarUrl }
          }`,
          { input },
          token,
        );
        setGroupChats((prev) => prev.map((g) => (g.id === data.updateGroupChat.id ? data.updateGroupChat : g)));
        setChatMetaMsg("Сохранено");
        setChatMetaPopoverOpen(false);
        return;
      }
      if (mode === "channels" && activeChannelId && canEditActiveChannelMeta) {
        const input: Record<string, unknown> = { channelId: activeChannelId };
        if (chatMetaNameDraft.trim()) input.name = chatMetaNameDraft.trim();
        input.avatarUrl = chatMetaAvatarData.trim() || null;
        const data = await gql<{ updateChannel: Channel }>(
          `mutation($input: UpdateChannelInput!) {
            updateChannel(input: $input) { id workspaceId name type avatarUrl createdByUserId }
          }`,
          { input },
          token,
        );
        setChannels((prev) =>
          prev.map((c) => (c.id === data.updateChannel.id ? { ...c, ...data.updateChannel } : c)),
        );
        setChatMetaMsg("Сохранено");
        setChatMetaPopoverOpen(false);
      }
    } catch (e: unknown) {
      setChatMetaMsg(String((e as Error)?.message ?? e ?? "Ошибка"));
    }
  }

  async function addMembersToActiveGroup(userIds: string[]) {
    if (!token || !activeGroupChatId || !userIds.length) return;
    setInfoPanelMembersMsg("");
    try {
      const data = await gql<{ groupChatAddMembers: { id: string; memberIds: string[] } }>(
        `mutation($input: GroupChatAddMembersInput!) {
          groupChatAddMembers(input: $input) { id memberIds }
        }`,
        { input: { groupChatId: activeGroupChatId, userIds } },
        token,
      );
      setGroupChats((prev) =>
        prev.map((g) => (g.id === data.groupChatAddMembers.id ? { ...g, memberIds: data.groupChatAddMembers.memberIds } : g)),
      );
      setInfoPanelGroupPickUserId("");
    } catch (e: unknown) {
      setInfoPanelMembersMsg(String((e as Error)?.message ?? e ?? "Не удалось добавить"));
    }
  }

  async function addUserToActiveChannel(userIdToAdd: string) {
    if (!token || !activeChannelId || !userIdToAdd) return;
    setInfoPanelMembersMsg("");
    try {
      await gql<{ channelAddMember: boolean }>(
        `mutation($input: ChannelAddMemberInput!) { channelAddMember(input: $input) }`,
        { input: { channelId: activeChannelId, userId: userIdToAdd } },
        token,
      );
      const data = await gql<{
        channelMembers: { id: string; email: string; firstName?: string | null; lastName?: string | null; middleName?: string | null }[];
      }>(`query($id: ID!) { channelMembers(channelId: $id) { id email firstName middleName lastName } }`, { id: activeChannelId }, token);
      setInfoPanelChannelMembers(data.channelMembers ?? []);
      setInfoPanelChannelPickUserId("");
    } catch (e: unknown) {
      setInfoPanelMembersMsg(String((e as Error)?.message ?? e ?? "Не удалось добавить"));
    }
  }

  function toggleInstallStickerPack(packId: string) {
    setInstalledStickerPackIds((prev) => {
      if (prev.includes(packId)) return prev.filter((x) => x !== packId);
      return [...prev, packId];
    });
  }

  function downloadStickerPack(pack: { id: string; title: string; stickers: string[] }) {
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${pack.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importStickerPack(file: File) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const id = String(parsed?.id ?? "").trim() || `pack-${Date.now()}`;
    const title = String(parsed?.title ?? "Custom Pack").trim();
    const stickers = Array.isArray(parsed?.stickers) ? parsed.stickers.map((x: unknown) => String(x)).filter(Boolean) : [];
    if (!stickers.length) {
      setChatError("Стикер-пак пустой");
      return;
    }
    setStickerCatalog((prev) => {
      const without = prev.filter((x) => x.id !== id);
      return [...without, { id, title, stickers }];
    });
    setInstalledStickerPackIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveStickerPackId(id);
  }

  async function ensureDmWithUser(otherUserId: string) {
    if (!token) return;
    const data = await gql<{ ensureDirectChat: { id: string; userIds: string[] } }>(
      `mutation($userId: ID!) { ensureDirectChat(userId: $userId) { id userIds } }`,
      { userId: otherUserId },
      token,
    );
    setMode("dms");
    setActiveDirectChatId(data.ensureDirectChat.id);
    await loadDirectChats();
  }

  async function openSavedVaultChat() {
    if (!token || !userId) return;
    setChatListScope("dms");
    setShowSaved(false);
    await ensureDmWithUser(userId);
  }

  function closeNewThingWizard() {
    setNewThingWizardKind(null);
    setWizardSelectedUserIds([]);
    setWizardError("");
    setWizardUserQuery("");
    setWizardBusy(false);
  }

  async function openNewThingWizard(kind: "dm" | "group") {
    setNewChatMenuOpen(false);
    setNewThingWizardKind(kind);
    setWizardSelectedUserIds([]);
    setWizardError("");
    setWizardUserQuery("");
    if (kind === "group") setWizardGroupName("Новая группа");
    if (token && organizationId && users.length === 0) await loadUsers();
  }

  function toggleWizardUser(pickId: string) {
    if (!newThingWizardKind) return;
    if (pickId === userId && newThingWizardKind !== "dm") return;
    if (newThingWizardKind === "dm") {
      setWizardSelectedUserIds((prev) => (prev[0] === pickId ? [] : [pickId]));
      return;
    }
    if (newThingWizardKind === "group") {
      setWizardSelectedUserIds((prev) => {
        const s = new Set(prev);
        if (s.has(pickId)) s.delete(pickId);
        else if (s.size >= 100) return prev;
        else s.add(pickId);
        return Array.from(s);
      });
    }
  }

  async function submitNewThingWizard() {
    if (!newThingWizardKind || !token) return;
    setWizardError("");
    if (newThingWizardKind === "dm") {
      if (!canReadChats) {
        setWizardError("Недостаточно прав для личных чатов");
        return;
      }
      if (wizardSelectedUserIds.length !== 1) {
        setWizardError("Выберите ровно одного пользователя");
        return;
      }
      setWizardBusy(true);
      try {
        await ensureDmWithUser(wizardSelectedUserIds[0]);
        closeNewThingWizard();
        setMobileSidebarOpen(false);
        pushLog("Личный чат открыт");
      } catch (e: unknown) {
        setWizardError(e instanceof Error ? e.message : String(e));
      } finally {
        setWizardBusy(false);
      }
      return;
    }
    if (newThingWizardKind === "group") {
      if (!canCreateChannelsAndGroups) {
        setWizardError("Недостаточно прав для создания группы");
        return;
      }
      const gName = wizardGroupName.trim();
      if (!gName) {
        setWizardError("Введите название группы");
        return;
      }
      const others = wizardSelectedUserIds.filter((id) => id !== userId);
      if (others.length < 1 || others.length > 100) {
        setWizardError("Выберите от 1 до 100 участников");
        return;
      }
      const memberIds = Array.from(new Set([userId, ...others]));
      setWizardBusy(true);
      try {
        const data = await gql<{ createGroupChat: { id: string; name: string } }>(
          `mutation($input: CreateGroupChatInput!) {
            createGroupChat(input: $input) { id name memberIds }
          }`,
          { input: { name: gName, memberIds } },
          token,
        );
        await loadGroupChats();
        setMode("groups");
        setActiveGroupChatId(data.createGroupChat.id);
        closeNewThingWizard();
        setMobileSidebarOpen(false);
        pushLog(`Группа создана: ${data.createGroupChat.name}`);
      } catch (e: unknown) {
        setWizardError(e instanceof Error ? e.message : String(e));
      } finally {
        setWizardBusy(false);
      }
      return;
    }
  }

  async function createCompanyUser(input: {
    email: string;
    fullName: string;
    password: string;
    role: "owner" | "admin" | "manager" | "employee" | "guest";
    department?: string;
  }) {
    if (!token || !organizationId) throw new Error("Нет organizationId или токена");
    const emailLower = input.email.trim().toLowerCase();
    try {
      const data = await gql<{ createOrganizationUser: { id: string; email: string } }>(
        `mutation($input: CreateOrganizationUserInput!) { createOrganizationUser(input: $input) { id email } }`,
        {
          input: {
            organizationId,
            email: emailLower,
            password: input.password,
            fullName: input.fullName?.trim() || undefined,
            role: input.role,
            department: input.department?.trim() || undefined,
          },
        },
        token,
      );
      return { createOrganizationUser: data.createOrganizationUser };
    } catch {
      // Fallback: inviteUser (в старых бэках может не быть createOrganizationUser).
      const mutation = `mutation($input: InviteUserInput!) { inviteUser(input: $input) { id email inviteToken } }`;
      let data: { inviteUser: { id: string; email: string; inviteToken?: string | null } } | null = null;
      try {
        data = await gql<{ inviteUser: { id: string; email: string; inviteToken?: string | null } }>(
          mutation,
          { input: { organizationId, email: emailLower } },
          token,
        );
      } catch {
        data = await gql<{ inviteUser: { id: string; email: string; inviteToken?: string | null } }>(
          mutation,
          { input: { organizationId, email: emailLower, role: input.role } },
          token,
        );
      }
      return { createOrganizationUser: { id: data.inviteUser.id, email: data.inviteUser.email } };
    }
  }

  async function adminUpdateNewUserExtras(userIdToUpdate: string, extras: { phone?: string; statusText?: string }) {
    if (!token || !userIdToUpdate) return;
    const phone = (extras.phone ?? "").trim();
    const statusText = (extras.statusText ?? "").trim();
    if (!phone && !statusText) return;
    try {
      await gql<{ updateUser: { id: string } }>(
        `mutation($input: UpdateUserInput!) { updateUser(input: $input) { id } }`,
        { input: { userId: userIdToUpdate, ...(phone ? { phone } : {}), ...(statusText ? { statusText } : {}) } },
        token,
      );
    } catch {
      /* ignore */
    }
  }

  async function createCompanyUserSingle() {
    if (!isCompanyAdmin) {
      setCompanyActionMsg("Только owner/admin могут добавлять сотрудников");
      return;
    }
    const emailV = adminCreateEmail.trim().toLowerCase();
    const fullNameV = [adminCreateLastName, adminCreateFirstName, adminCreateMiddleName].map((x) => x.trim()).filter(Boolean).join(" ");
    const deptV = adminCreateDepartment.trim();
    if (!emailV || !adminCreatePassword.trim()) {
      setCompanyActionMsg("Заполните email и пароль");
      return;
    }
    try {
      setCompanyActionMsg("Создание пользователя…");
      const res = await createCompanyUser({
        email: emailV,
        fullName: fullNameV,
        password: adminCreatePassword.trim(),
        role: adminCreateRole,
        department: deptV || undefined,
      });
      await adminUpdateNewUserExtras(res.createOrganizationUser.id, { phone: adminCreatePhone });
      setCompanyActionMsg(`Сотрудник добавлен: ${emailV}. Если пароль не применился, сотруднику уйдет инвайт для завершения регистрации.`);
      setAdminCreateEmail("");
      setAdminCreateLastName("");
      setAdminCreateFirstName("");
      setAdminCreateMiddleName("");
      setAdminCreatePassword("");
      setAdminCreatePhone("");
      setAdminCreateDepartment("");
      await loadUsers();
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "Не удалось создать пользователя");
      setCompanyActionMsg(`Ошибка создания пользователя: ${msg}`);
      pushLog(`createOrganizationUser error: ${msg}`);
    }
  }

  async function importCompanyUsersFromExcel(file: File) {
    if (!isCompanyAdmin) {
      setCompanyActionMsg("Только owner/admin могут импортировать сотрудников");
      return;
    }
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    let ok = 0;
    let fail = 0;
    for (const row of rows) {
      const emailV = String(row.email ?? row.Email ?? row["почта"] ?? "").trim().toLowerCase();
      const lastNameV = String(row.lastName ?? row["Фамилия"] ?? row["фамилия"] ?? "").trim();
      const firstNameV = String(row.firstName ?? row["Имя"] ?? row["имя"] ?? "").trim();
      const middleNameV = String(row.middleName ?? row["Отчество"] ?? row["отчество"] ?? "").trim();
      const fioFallback = String(row.fullName ?? row.fio ?? row["ФИО"] ?? row["фио"] ?? "").trim();
      const fullNameV = ([lastNameV, firstNameV, middleNameV].filter(Boolean).join(" ") || fioFallback).trim();
      const passwordV = String(row.password ?? row.Password ?? row["пароль"] ?? "").trim();
      const roleRaw = String(row.role ?? row.Role ?? "employee").trim().toLowerCase();
      const phoneV = String(row.phone ?? row.Phone ?? row["телефон"] ?? row["Телефон"] ?? "").trim();
      const deptV = String(row.department ?? row.Department ?? row["отдел"] ?? row["Отдел"] ?? "").trim();
      const roleV = (["owner", "admin", "manager", "employee", "guest"].includes(roleRaw) ? roleRaw : "employee") as
        | "owner"
        | "admin"
        | "manager"
        | "employee"
        | "guest";
      if (!emailV || !passwordV) {
        fail += 1;
        continue;
      }
      try {
        const res = await createCompanyUser({ email: emailV, fullName: fullNameV, password: passwordV, role: roleV, department: deptV || undefined });
        await adminUpdateNewUserExtras(res.createOrganizationUser.id, { phone: phoneV });
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setCompanyActionMsg(`Импорт завершен. Успешно: ${ok}, с ошибками: ${fail}`);
    await loadUsers();
  }

  async function setCompanyUserRole(targetUserId: string, role: "owner" | "admin" | "manager" | "employee" | "guest") {
    if (!token || !organizationId || !targetUserId) return;
    await gql<{ setUserRole: { id: string; role?: string | null } }>(
      `mutation($input: SetUserRoleInput!) { setUserRole(input: $input) { id role } }`,
      { input: { organizationId, userId: targetUserId, role } },
      token,
    );
    setCompanyActionMsg(`Роль обновлена: ${role}`);
    await loadUsers();
  }

  async function deactivateCompanyUser(targetUserId: string) {
    if (!token || !organizationId || !targetUserId) return;
    if (!window.confirm("Деактивировать пользователя?")) return;
    await gql<{ deactivateUser: boolean }>(
      `mutation($input: DeactivateUserInput!) { deactivateUser(input: $input) }`,
      { input: { organizationId, userId: targetUserId } },
      token,
    );
    setCompanyActionMsg("Пользователь деактивирован");
    await loadUsers();
  }

  // loadAdminOrganizationName скрыт/убран по требованию

  // openAdminUsersPanel скрыт/убран по требованию

  // adminPanelCreateUser / adminPanelSetPassword отключены по требованию

  function openChatMenuAtTime(e: MouseEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const menuW = 260;
    const menuH = 168;
    const pad = 8;
    let x = r.left - menuW - 8;
    if (x < pad) x = r.right + 8;
    if (x + menuW > window.innerWidth - pad) x = window.innerWidth - menuW - pad;
    let y = r.top;
    if (y + menuH > window.innerHeight - pad) y = window.innerHeight - menuH - pad;
    y = Math.max(pad, y);
    setChatMenu({ x, y, key, sub: "main" });
  }

  function openChatMenuAtEditButton(e: MouseEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const menuW = 260;
    const menuH = 220;
    const pad = 8;
    let x = r.right - menuW;
    if (x < pad) x = pad;
    if (x + menuW > window.innerWidth - pad) x = window.innerWidth - menuW - pad;
    let y = r.bottom + 4;
    if (y + menuH > window.innerHeight - pad) y = Math.max(pad, r.top - menuH - 4);
    setChatMenu({ x, y, key, sub: "main" });
  }

  function renderUnifiedChatRow(row: (typeof unifiedChatRows)[number]) {
    if (row.kind === "d") {
      const d = row.d;
      const isSelfNotesDm = d.userIds.length === 1 && d.userIds[0] === userId;
      const otherId = d.userIds.find((id) => id !== userId) ?? d.userIds[0] ?? "";
      const u = users.find((x) => x.id === otherId);
      const pr = otherId ? presenceByUserId[otherId] : undefined;
      const st = pr?.status ?? u?.status ?? "unknown";
      const dot = isSelfNotesDm ? "⭐" : st === "online" ? "●" : st === "away" ? "◐" : st === "dnd" ? "◍" : "○";
      const title = isSelfNotesDm ? "Избранное" : displayUserNameForSidebar(u, otherId || d.id);
      return (
        <div
          key={`all-d-${d.id}`}
          role="button"
          tabIndex={0}
          className={`tgChatRow ${activeDirectChatId === d.id ? "active" : ""} ${dragPinnedKey === chatKeyFor("d", d.id) ? "dragging" : ""} ${dragOverPinnedKey === chatKeyFor("d", d.id) ? "dragover" : ""}`}
          draggable={isPinned(chatKeyFor("d", d.id))}
          onDragStart={() => setDragPinnedKey(chatKeyFor("d", d.id))}
          onDragEnd={() => {
            setDragPinnedKey("");
            setDragOverPinnedKey("");
          }}
          onDragOver={(e) => {
            if (!dragPinnedKey || !isPinned(chatKeyFor("d", d.id))) return;
            e.preventDefault();
            setDragOverPinnedKey(chatKeyFor("d", d.id));
          }}
          onDrop={(e) => {
            e.preventDefault();
            reorderPinned(dragPinnedKey, chatKeyFor("d", d.id));
            setDragPinnedKey("");
            setDragOverPinnedKey("");
          }}
          onClick={() => {
            setMode("dms");
            setActiveDirectChatId(d.id);
            setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("d", d.id)]: 0 }));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setMode("dms");
              setActiveDirectChatId(d.id);
              setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("d", d.id)]: 0 }));
            }
          }}
        >
          {(() => {
            const avatarHref = isSelfNotesDm ? normalizeDownloadUrl(profileAvatarUrl) : normalizeDownloadUrl(u?.avatarUrl);
            return avatarHref ? (
              <div className="tgAvatar tgAvatar--img">
                <img src={avatarHref} alt="" className="tgAvatarImg" />
              </div>
            ) : (
              <div className="tgAvatar">{initials(title)}</div>
            );
          })()}
          <div className="tgChatMain">
            <div className="tgChatTop">
              <div className="tgChatTitle">
                {isPinned(chatKeyFor("d", d.id)) ? "📌 " : ""}
                <span className="tgPresence">{dot}</span> {title}
              </div>
              <div className="tgChatTopRight">
                <button
                  type="button"
                  className="tgChatRowMenuBtn"
                  title="Чат: закрепить, архив, удалить"
                  aria-label="Действия с чатом"
                  onClick={(e) => openChatMenuAtEditButton(e, chatKeyFor("d", d.id))}
                >
                  ⋮
                </button>
                <div className="tgChatTime" onContextMenu={(e) => openChatMenuAtTime(e, chatKeyFor("d", d.id))}>
                  {timeHHMM(chatPreviewByKey[chatKeyFor("d", d.id)]?.at)}
                </div>
              </div>
            </div>
            <div className="tgChatSub">
              {isMuted(chatKeyFor("d", d.id)) ? "🔕 " : ""}
              {chatPreviewByKey[chatKeyFor("d", d.id)]?.text?.trim() || "Нет сообщений"}
            </div>
          </div>
          {unreadFor(chatKeyFor("d", d.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("d", d.id))}</div> : null}
        </div>
      );
    }
    if (row.kind === "g") {
      const g = row.g;
      return (
        <div
          key={`all-g-${g.id}`}
          role="button"
          tabIndex={0}
          className={`tgChatRow ${activeGroupChatId === g.id ? "active" : ""} ${dragPinnedKey === chatKeyFor("g", g.id) ? "dragging" : ""} ${dragOverPinnedKey === chatKeyFor("g", g.id) ? "dragover" : ""}`}
          draggable={isPinned(chatKeyFor("g", g.id))}
          onDragStart={() => setDragPinnedKey(chatKeyFor("g", g.id))}
          onDragEnd={() => {
            setDragPinnedKey("");
            setDragOverPinnedKey("");
          }}
          onDragOver={(e) => {
            if (!dragPinnedKey || !isPinned(chatKeyFor("g", g.id))) return;
            e.preventDefault();
            setDragOverPinnedKey(chatKeyFor("g", g.id));
          }}
          onDrop={(e) => {
            e.preventDefault();
            reorderPinned(dragPinnedKey, chatKeyFor("g", g.id));
            setDragPinnedKey("");
            setDragOverPinnedKey("");
          }}
          onClick={() => {
            setMode("groups");
            setActiveGroupChatId(g.id);
            setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("g", g.id)]: 0 }));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setMode("groups");
              setActiveGroupChatId(g.id);
              setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("g", g.id)]: 0 }));
            }
          }}
        >
          <div className={`tgAvatar ${g.avatarUrl ? "tgAvatar--img" : ""}`}>
            {g.avatarUrl ? <img src={g.avatarUrl} alt="" className="tgAvatarImg" /> : initials(g.name)}
          </div>
          <div className="tgChatMain">
            <div className="tgChatTop">
              <div className="tgChatTitle">{isPinned(chatKeyFor("g", g.id)) ? "📌 " : ""}{g.name}</div>
              <div className="tgChatTopRight">
                <button
                  type="button"
                  className="tgChatRowMenuBtn"
                  title="Чат: закрепить, архив, удалить"
                  aria-label="Действия с чатом"
                  onClick={(e) => openChatMenuAtEditButton(e, chatKeyFor("g", g.id))}
                >
                  ⋮
                </button>
                <div className="tgChatTime" onContextMenu={(e) => openChatMenuAtTime(e, chatKeyFor("g", g.id))}>
                  {timeHHMM(chatPreviewByKey[chatKeyFor("g", g.id)]?.at)}
                </div>
              </div>
            </div>
            <div className="tgChatSub">
              {isMuted(chatKeyFor("g", g.id)) ? "🔕 " : ""}
              {chatPreviewByKey[chatKeyFor("g", g.id)]?.text?.trim() ||
                (g.memberIds?.length ? `Участников: ${g.memberIds.length}` : "Нет сообщений")}
            </div>
          </div>
          {unreadFor(chatKeyFor("g", g.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("g", g.id))}</div> : null}
        </div>
      );
    }
    const c = row.c;
    return (
      <div
        key={`all-c-${c.id}`}
        role="button"
        tabIndex={0}
        className={`tgChatRow ${activeChannelId === c.id ? "active" : ""} ${dragPinnedKey === chatKeyFor("c", c.id) ? "dragging" : ""} ${dragOverPinnedKey === chatKeyFor("c", c.id) ? "dragover" : ""}`}
        draggable={isPinned(chatKeyFor("c", c.id))}
        onDragStart={() => setDragPinnedKey(chatKeyFor("c", c.id))}
        onDragEnd={() => {
          setDragPinnedKey("");
          setDragOverPinnedKey("");
        }}
        onDragOver={(e) => {
          if (!dragPinnedKey || !isPinned(chatKeyFor("c", c.id))) return;
          e.preventDefault();
          setDragOverPinnedKey(chatKeyFor("c", c.id));
        }}
        onDrop={(e) => {
          e.preventDefault();
          reorderPinned(dragPinnedKey, chatKeyFor("c", c.id));
          setDragPinnedKey("");
          setDragOverPinnedKey("");
        }}
        onClick={() => {
          setMode("channels");
          setActiveChannelId(c.id);
          setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("c", c.id)]: 0 }));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setMode("channels");
            setActiveChannelId(c.id);
            setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("c", c.id)]: 0 }));
          }
        }}
      >
        <div className={`tgAvatar ${c.avatarUrl ? "tgAvatar--img" : ""}`}>
          {c.avatarUrl ? <img src={c.avatarUrl} alt="" className="tgAvatarImg" /> : "#"}
        </div>
        <div className="tgChatMain">
          <div className="tgChatTop">
            <div className="tgChatTitle">{isPinned(chatKeyFor("c", c.id)) ? "📌 " : ""}#{c.name}</div>
            <div className="tgChatTopRight">
              <button
                type="button"
                className="tgChatRowMenuBtn"
                title="Чат: закрепить, архив, удалить"
                aria-label="Действия с чатом"
                onClick={(e) => openChatMenuAtEditButton(e, chatKeyFor("c", c.id))}
              >
                ⋮
              </button>
              <div className="tgChatTime" onContextMenu={(e) => openChatMenuAtTime(e, chatKeyFor("c", c.id))}>
                {timeHHMM(chatPreviewByKey[chatKeyFor("c", c.id)]?.at)}
              </div>
            </div>
          </div>
          <div className="tgChatSub">
            {isMuted(chatKeyFor("c", c.id)) ? "🔕 " : ""}
            {chatPreviewByKey[chatKeyFor("c", c.id)]?.text?.trim() || `Канал · ${c.type}`}
          </div>
        </div>
        {unreadFor(chatKeyFor("c", c.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("c", c.id))}</div> : null}
      </div>
    );
  }

  async function loadMessages(channelId: string) {
    if (!token || !channelId) return;
    const data = await gql<{ messages: { items: Message[] } }>(
      `query($channelId: ID!, $limit: Int!) {
        messages(channelId: $channelId, limit: $limit) {
          items { id content createdAt editedAt isDeleted type parentMessageId author { email firstName middleName lastName } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl avStatus blockedReason } }
        }
      }`,
      { channelId, limit: 50 },
      token,
    );
    setMessages(data.messages.items);
    const p = previewForMessages(data.messages.items);
    setChatPreviewByKey((prev) => ({ ...prev, [chatKeyFor("c", channelId)]: p }));
    socket?.emit("channel:join", { channelId });
    await mergeThreadReadStates("c", channelId);
    scrollMessagesToBottom();
  }

  async function loadGroupMessages(groupChatId: string) {
    if (!token || !groupChatId) return;
    const data = await gql<{ groupChatMessages: Message[] }>(
      `query($groupChatId: ID!, $limit: Int!) {
        groupChatMessages(groupChatId: $groupChatId, limit: $limit) {
          id content createdAt editedAt isDeleted type parentMessageId author { email firstName middleName lastName } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl avStatus blockedReason }
        }
      }`,
      { groupChatId, limit: 200 },
      token,
    );
    setMessages(data.groupChatMessages);
    const p = previewForMessages(data.groupChatMessages);
    setChatPreviewByKey((prev) => ({ ...prev, [chatKeyFor("g", groupChatId)]: p }));
    socket?.emit("group:join", { groupChatId });
    await mergeThreadReadStates("g", groupChatId);
    scrollMessagesToBottom();
  }

  async function loadDirectMessages(directChatId: string) {
    if (!token || !directChatId) return;
    const data = await gql<{ directChatMessages: DirectChatMessage[] }>(
      `query($directChatId: ID!, $limit: Int!) {
        directChatMessages(directChatId: $directChatId, limit: $limit) {
          id
          directChatId
          content
          createdAt
          updatedAt
          type
          parentMessageId
          author { id email firstName middleName lastName }
          reactions { emoji count viewerHasReacted }
          file { id originalName mimeType size downloadUrl avStatus blockedReason }
        }
      }`,
      { directChatId, limit: 200 },
      token,
    );
    const mapped = data.directChatMessages.map((m) => ({
        id: m.id,
        content: m.content,
        createdAt: m.createdAt,
        editedAt: m.updatedAt ?? null,
        author: {
          id: String((m.author as { id?: string }).id ?? ""),
          email: m.author.email,
          firstName: m.author.firstName ?? null,
          middleName: m.author.middleName ?? null,
          lastName: m.author.lastName ?? null,
        },
        type: m.type,
        reactions: m.reactions ?? [],
        file: m.file ?? null,
        parentMessageId: m.parentMessageId ?? null,
      }));
    setMessages(mapped);
    const p = previewForMessages(mapped);
    setChatPreviewByKey((prev) => ({ ...prev, [chatKeyFor("d", directChatId)]: p }));
    socket?.emit("dm:join", { directChatId });
    await mergeThreadReadStates("d", directChatId);
    scrollMessagesToBottom();
  }

  async function refreshChatsAndPresence() {
    if (!token || !organizationId) return;
    await loadUsers();
    await loadGroupChats();
    await loadDirectChats();
    if (workspaceId) await loadChannels();
    if (mode === "channels" && activeChannelId) await loadMessages(activeChannelId);
    else if (mode === "groups" && activeGroupChatId) await loadGroupMessages(activeGroupChatId);
    else if (mode === "dms" && activeDirectChatId) await loadDirectMessages(activeDirectChatId);
    pushLog("Чаты и лента обновлены.");
  }
  refreshChatsAndPresenceRef.current = refreshChatsAndPresence;

  /** Вход в чат / смена активного чата: всегда подгружаем актуальные сообщения с сервера */
  useEffect(() => {
    if (!token || threadRootId || showPins || showSaved) return;
    if (mode === "channels" && activeChannelId) void loadMessages(activeChannelId);
    else if (mode === "groups" && activeGroupChatId) void loadGroupMessages(activeGroupChatId);
    else if (mode === "dms" && activeDirectChatId) void loadDirectMessages(activeDirectChatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load* пересоздаются; триггер только по id/mode/token/оверлеям
  }, [token, mode, activeChannelId, activeGroupChatId, activeDirectChatId, threadRootId, showPins, showSaved]);

  /** «Обновление страницы» без перезагрузки: при возврате на вкладку подтягиваем списки чатов и текущую переписку */
  useEffect(() => {
    if (!token) return;
    const softRefresh = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void loadGroupChats();
      void loadDirectChats();
      if (workspaceId) void loadChannels();
      if (organizationId) void loadUsers();
      if (threadRootId || showPins || showSaved) return;
      if (mode === "channels" && activeChannelId) void loadMessages(activeChannelId);
      else if (mode === "groups" && activeGroupChatId) void loadGroupMessages(activeGroupChatId);
      else if (mode === "dms" && activeDirectChatId) void loadDirectMessages(activeDirectChatId);
    };
    document.addEventListener("visibilitychange", softRefresh);
    return () => {
      document.removeEventListener("visibilitychange", softRefresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, workspaceId, organizationId, mode, activeChannelId, activeGroupChatId, activeDirectChatId, threadRootId, showPins, showSaved]);

  /** Ярлык на экран «Домой»: периодически подтягиваем статусы из API (резерв, если сокет снова отвалится). */
  useEffect(() => {
    if (!token || !organizationId.trim()) return;
    if (!isStandaloneWebApp()) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadUsers();
    }, 20000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, organizationId]);

  async function openThread(parentMessageId: string) {
    if (!token) return;
    const data = await gql<{ thread: Message[] }>(
      `query($parentMessageId: ID!, $limit: Int!) {
        thread(parentMessageId: $parentMessageId, limit: $limit) {
          id content createdAt editedAt updatedAt isDeleted type parentMessageId author { email firstName middleName lastName } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl avStatus blockedReason }
        }
      }`,
      { parentMessageId, limit: 200 },
      token,
    );
    setThreadRootId(parentMessageId);
    setMessages(
      data.thread.map((row) => ({
        ...row,
        editedAt: row.editedAt ?? row.updatedAt ?? null,
      })),
    );
    scrollMessagesToBottom();
  }

  async function backFromThread() {
    setThreadRootId(null);
    setReplyTo(null);
  }

  async function toggleReaction(messageId: string, emoji: string) {
    if (!token) return;
    const e = emoji.trim();
    if (!e) return;
    const data = await gql<{ toggleReaction: Reaction[] }>(
      `mutation($input: ToggleReactionInput!) { toggleReaction(input: $input) { emoji count viewerHasReacted } }`,
      { input: { messageId, emoji: e } },
      token,
    );
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions: data.toggleReaction } : m)));
  }

  async function toggleSave(messageId: string, isSaved: boolean) {
    if (!token) return;
    if (isSaved) {
      await gql<{ unsaveMessage: boolean }>(`mutation($id: ID!) { unsaveMessage(messageId: $id) }`, { id: messageId }, token);
      pushLog("Unsave ok");
      setSavedIds((prev) => {
        const n = new Set(prev);
        n.delete(messageId);
        return n;
      });
    } else {
      await gql<{ saveMessage: boolean }>(`mutation($id: ID!) { saveMessage(messageId: $id) }`, { id: messageId }, token);
      pushLog("Save ok");
      setSavedIds((prev) => {
        const n = new Set(prev);
        n.add(messageId);
        return n;
      });
    }
  }

  async function sendMessage(e?: FormEvent, contentOverride?: string) {
    e?.preventDefault();
    const content = (contentOverride !== undefined ? contentOverride : newMessage).trimEnd();
    if (!token || !content.trim()) return;
    setChatError("");

    if (typingRef.current.stopTimerId) window.clearTimeout(typingRef.current.stopTimerId);
    typingRef.current.stopTimerId = null;
    if (typingRef.current.started) {
      typingRef.current.started = false;
      emitTypingStop();
    }

    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const optimistic: Message = {
      id: tempId,
      content,
      createdAt: new Date().toISOString(),
      author: {
        id: userId || "",
        email: selfAuthorEmail || "user",
        firstName: profileFirstName || null,
        middleName: profileMiddleName || null,
        lastName: profileLastName || null,
      },
      _sendState: "sending",
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const parentMessageId = replyTo?.id;
      if (mode === "channels") {
        if (!activeChannelId) {
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
          return;
        }
        const data = await gql<{ sendMessage: Message }>(
          `mutation($channelId: ID!, $content: String!, $parentMessageId: ID) {
            sendMessage(input: { channelId: $channelId, content: $content, parentMessageId: $parentMessageId }) {
              id content createdAt editedAt isDeleted type parentMessageId author { email firstName middleName lastName } reactions { emoji count viewerHasReacted }
            }
          }`,
          { channelId: activeChannelId, content, ...(parentMessageId ? { parentMessageId } : {}) },
          token,
        );
        setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...data.sendMessage, _sendState: undefined } : m)));
      } else if (mode === "groups") {
        if (!activeGroupChatId) {
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
          return;
        }
        const data = await gql<{ sendGroupChatMessage: Message }>(
          `mutation($groupChatId: ID!, $content: String!, $parentMessageId: ID) {
            sendGroupChatMessage(input: { groupChatId: $groupChatId, content: $content, parentMessageId: $parentMessageId }) {
              id content createdAt editedAt isDeleted type parentMessageId author { email firstName middleName lastName } reactions { emoji count viewerHasReacted }
            }
          }`,
          { groupChatId: activeGroupChatId, content, ...(parentMessageId ? { parentMessageId } : {}) },
          token,
        );
        setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...data.sendGroupChatMessage, _sendState: undefined } : m)));
      } else {
        if (!activeDirectChat) {
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
          return;
        }
        const isSelfDm =
          activeDirectChat.userIds.length === 1 && activeDirectChat.userIds[0] === userId;
        const peerUserId = isSelfDm
          ? userId
          : (activeDirectChat.userIds.find((id) => id !== userId) ?? "");
        if (!peerUserId) {
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
          return;
        }
        const data = await gql<{ sendDirectMessage: DirectChatMessage }>(
          `mutation($userId: ID!, $content: String!, $parentMessageId: ID) {
            sendDirectMessage(input: { userId: $userId, content: $content, parentMessageId: $parentMessageId }) {
              id directChatId content createdAt updatedAt type parentMessageId author { email firstName middleName lastName } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl avStatus blockedReason }
            }
          }`,
          { userId: peerUserId, content, ...(parentMessageId ? { parentMessageId } : {}) },
          token,
        );
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId
              ? {
                  id: data.sendDirectMessage.id,
                  content: data.sendDirectMessage.content,
                  createdAt: data.sendDirectMessage.createdAt,
                  editedAt: data.sendDirectMessage.updatedAt ?? null,
                  author: data.sendDirectMessage.author,
                  type: data.sendDirectMessage.type,
                  reactions: data.sendDirectMessage.reactions ?? [],
                  file: data.sendDirectMessage.file ?? null,
                  parentMessageId: data.sendDirectMessage.parentMessageId ?? null,
                  _sendState: undefined,
                }
              : m,
          ),
        );
      }
      setNewMessage("");
      setReplyTo(null);
      setShowStickerPicker(false);
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "Не удалось отправить сообщение");
      setChatError(msg);
      pushLog(`sendMessage error: ${msg}`);
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _sendState: "failed" } : m)));
    }
  }

  async function editMessageInChat(messageId: string) {
    if (!token) return;
    const m = messages.find((x) => x.id === messageId);
    if (!m) return;
    const next = prompt("Новое сообщение", m.content ?? "") ?? "";
    if (!next.trim()) return;
    if (mode === "channels") {
      const data = await gql<{ editMessage: any }>(
        `mutation($input: EditMessageInput!) {
          editMessage(input: $input) { id content createdAt type author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl avStatus blockedReason } }
        }`,
        { input: { messageId, content: next } },
        token,
      );
      setMessages((prev) => prev.map((x) => (x.id === messageId ? (data.editMessage as any) : x)));
    } else if (mode === "groups") {
      const data = await gql<{ editGroupChatMessage: any }>(
        `mutation($groupChatId: ID!, $messageId: ID!, $content: String!) {
          editGroupChatMessage(groupChatId: $groupChatId, messageId: $messageId, content: $content) {
            id content createdAt type author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl avStatus blockedReason }
          }
        }`,
        { groupChatId: activeGroupChatId, messageId, content: next },
        token,
      );
      setMessages((prev) => prev.map((x) => (x.id === messageId ? (data.editGroupChatMessage as any) : x)));
    } else {
      const data = await gql<{ editDirectMessage: any }>(
        `mutation($directChatId: ID!, $messageId: ID!, $content: String!) {
          editDirectMessage(directChatId: $directChatId, messageId: $messageId, content: $content) {
            id directChatId content createdAt updatedAt type author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl avStatus blockedReason }
          }
        }`,
        { directChatId: activeDirectChatId, messageId, content: next },
        token,
      );
      setMessages((prev) =>
        prev.map((x) =>
          x.id === messageId
            ? {
                id: data.editDirectMessage.id,
                content: data.editDirectMessage.content,
                createdAt: data.editDirectMessage.createdAt,
                editedAt: data.editDirectMessage.updatedAt ?? null,
                author: data.editDirectMessage.author,
                type: data.editDirectMessage.type,
                reactions: data.editDirectMessage.reactions ?? [],
                file: data.editDirectMessage.file ?? null,
              }
            : x,
        ),
      );
    }
  }

  async function deleteMessageInChat(messageId: string) {
    if (!token) return;
    if (!confirm("Удалить сообщение?")) return;
    if (mode === "channels") {
      await gql<{ deleteMessage: boolean }>(`mutation($input: DeleteMessageInput!) { deleteMessage(input: $input) }`, { input: { messageId } }, token);
      setMessages((prev) => prev.map((x) => (x.id === messageId ? { ...x, content: "", type: x.type, _localError: undefined } : x)));
    } else if (mode === "groups") {
      await gql<{ deleteGroupChatMessage: boolean }>(
        `mutation($groupChatId: ID!, $messageId: ID!) { deleteGroupChatMessage(groupChatId: $groupChatId, messageId: $messageId) }`,
        { groupChatId: activeGroupChatId, messageId },
        token,
      );
      setMessages((prev) => prev.map((x) => (x.id === messageId ? { ...x, content: "" } : x)));
    } else {
      await gql<{ deleteDirectMessage: boolean }>(
        `mutation($directChatId: ID!, $messageId: ID!) { deleteDirectMessage(directChatId: $directChatId, messageId: $messageId) }`,
        { directChatId: activeDirectChatId, messageId },
        token,
      );
      setMessages((prev) => prev.map((x) => (x.id === messageId ? { ...x, content: "" } : x)));
    }
  }

  async function uploadAndSend(kind: "file" | "voice", blob: Blob, originalName?: string) {
    if (!token) return;
    const targetId = mode === "channels" ? activeChannelId : mode === "groups" ? activeGroupChatId : activeDirectChatId;
    if (!targetId) return;
    const nameLower = (originalName || "").toLowerCase();
    const effectiveMime =
      blob.type || guessMimeFromOriginalNameForUpload(nameLower) || "application/octet-stream";

    async function sleep(ms: number) {
      await new Promise((r) => setTimeout(r, ms));
    }
    /** Пока файл не clean, send падает; не раздуваем матч под «service unavailable». */
    function isFileNotReadyError(e: unknown) {
      const msg = String((e as Error)?.message ?? e ?? "").toLowerCase();
      return (
        msg.includes("file not available") ||
        msg.includes("not clean") ||
        (msg.includes("pending") && (msg.includes("file") || msg.includes("scan") || msg.includes("av"))) ||
        ((msg.includes("not available") || msg.includes("unavailable")) &&
          (msg.includes("file") || msg.includes("download")))
      );
    }

    const presign = await gql<{ createPresignedUpload: { fileId: string; uploadUrl: string } }>(
      `mutation($input: CreatePresignedUploadInput!) { createPresignedUpload(input: $input) { fileId uploadUrl key } }`,
      {
        input: {
          mimeType: effectiveMime,
          size: blob.size,
          originalName: originalName || null,
        },
      },
      token,
    );

    const fileId = presign.createPresignedUpload.fileId;
    const localId = `local-file-${fileId}`;
    localFileMessageIdByFileIdRef.current.set(fileId, localId);
    setMessages((prev) => [
      ...prev,
      {
        id: localId,
        createdAt: new Date().toISOString(),
        author: {
          email: selfAuthorEmail || "user",
          firstName: profileFirstName || null,
          middleName: profileMiddleName || null,
          lastName: profileLastName || null,
        },
        type: kind,
        content: "",
        file: { id: fileId, originalName: originalName || null, mimeType: effectiveMime, size: blob.size },
        _localFileState: "uploading",
      },
    ]);

    try {
      let uploaded = false;
      try {
        const direct = await fetch(presign.createPresignedUpload.uploadUrl, {
          method: "PUT",
          headers: { "content-type": effectiveMime },
          body: blob,
        });
        if (!direct.ok) {
          throw new Error(`Direct upload failed: ${direct.status}`);
        }
        uploaded = true;
      } catch {
        const targets = new Set<string>();
        targets.add(`${API_BASE}/files/upload/${encodeURIComponent(fileId)}`);
        targets.add(`/files/upload/${encodeURIComponent(fileId)}`);
        if (typeof window !== "undefined") {
          targets.add(`${window.location.origin}/files/upload/${encodeURIComponent(fileId)}`);
        }
        let lastErr = "Failed to fetch";
        for (const url of Array.from(targets).filter(Boolean)) {
          try {
            const fallback = await fetch(url, {
              method: "PUT",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": effectiveMime,
              },
              body: blob,
            });
            if (!fallback.ok) {
              const txt = await fallback.text().catch(() => "");
              lastErr = `Upload fallback failed: ${fallback.status}${txt ? ` ${txt}` : ""}`;
              continue;
            }
            uploaded = true;
            break;
          } catch (e: any) {
            lastErr = e?.message || "Failed to fetch";
          }
        }
        if (!uploaded) {
          // Last-resort fallback through GraphQL (same endpoint as app API).
          try {
            const buf = await blob.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = "";
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
            }
            const base64 = btoa(binary);
            await gql<{ uploadFileBase64: boolean }>(
              `mutation($fileId: ID!, $base64: String!, $mimeType: String) {
                uploadFileBase64(fileId: $fileId, base64: $base64, mimeType: $mimeType)
              }`,
              { fileId, base64, mimeType: effectiveMime },
              token,
            );
            uploaded = true;
          } catch (e: any) {
            throw new Error(e?.message || lastErr);
          }
        }
      }
      if (!uploaded) {
        throw new Error("Upload failed");
      }

      await gql<{ confirmFileUploaded: boolean }>(`mutation($fileId: ID!) { confirmFileUploaded(fileId: $fileId) }`, { fileId }, token);

      setMessages((prev) => prev.map((m) => (m.id === localId ? { ...m, _localFileState: "scanning" } : m)));

      /* Не запрашиваем `file { ... }` в ответе мутации: резолвер File тянет presigned URL и на старых бэках
         падает, пока запись ещё pending — мутация целиком ошибкой даже после успешного createMessage. */
      const maxSendAttempts = 60;
      for (let attempt = 0; attempt < maxSendAttempts; attempt++) {
        try {
          if (mode === "channels") {
            const data = await gql<{ sendFileMessage: Message }>(
              `mutation($input: SendFileMessageInput!) {
            sendFileMessage(input: $input) { id content createdAt type author { email } reactions { emoji count viewerHasReacted } }
          }`,
              { input: { channelId: activeChannelId, fileId, kind } },
              token,
            );
            const sent = data.sendFileMessage as any;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === localId
                  ? {
                      ...sent,
                      file: {
                        id: fileId,
                        originalName: originalName || null,
                        mimeType: effectiveMime,
                        size: blob.size,
                      },
                    }
                  : m,
              ),
            );
            void hydrateDownloadUrl(fileId);
            return;
          }
          if (mode === "groups") {
            const data = await gql<{ sendGroupChatFileMessage: Message }>(
              `mutation($input: SendGroupChatFileMessageInput!) {
            sendGroupChatFileMessage(input: $input) { id content createdAt type author { email } reactions { emoji count viewerHasReacted } }
          }`,
              { input: { groupChatId: activeGroupChatId, fileId, kind } },
              token,
            );
            const sent = data.sendGroupChatFileMessage as any;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === localId
                  ? {
                      ...sent,
                      file: {
                        id: fileId,
                        originalName: originalName || null,
                        mimeType: effectiveMime,
                        size: blob.size,
                      },
                    }
                  : m,
              ),
            );
            void hydrateDownloadUrl(fileId);
            return;
          }
          const data = await gql<{ sendDirectFileMessage: any }>(
            `mutation($input: SendDirectFileMessageInput!) {
            sendDirectFileMessage(input: $input) {
              id directChatId content createdAt type author { email }
            }
          }`,
            { input: { directChatId: activeDirectChatId, fileId, kind } },
            token,
          );
          setMessages((prev) =>
            prev.map((m) =>
              m.id === localId
                ? {
                    id: data.sendDirectFileMessage.id,
                    content: data.sendDirectFileMessage.content ?? "",
                    createdAt: data.sendDirectFileMessage.createdAt,
                    author: data.sendDirectFileMessage.author,
                    type: data.sendDirectFileMessage.type,
                    reactions: [],
                    file: { id: fileId, originalName: originalName || null, mimeType: effectiveMime, size: blob.size },
                  }
                : m,
            ),
          );
          void hydrateDownloadUrl(fileId);
          return;
        } catch (e: unknown) {
          if (isFileNotReadyError(e) && attempt < maxSendAttempts - 1) {
            await sleep(1000);
            continue;
          }
          throw e;
        }
      }
      throw new Error("Таймаут: файл не стал доступен для отправки (антивирус/очередь)");
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "Upload failed");
      setMessages((prev) => prev.map((m) => (m.id === localId ? { ...m, _localFileState: "failed", _localError: msg } : m)));
      throw e;
    }
  }

  async function hydrateDownloadUrl(fileId: string) {
    if (!token) return;
    const data = await gql<{
      file: {
        id: string;
        downloadUrl?: string | null;
        originalName?: string | null;
        mimeType: string;
        size: number;
        avStatus?: string | null;
        blockedReason?: string | null;
      };
    }>(
      `query($id: ID!) {
        file(id: $id) { id originalName mimeType size downloadUrl avStatus blockedReason }
      }`,
      { id: fileId },
      token,
    );
    const url = data.file.downloadUrl ? String(data.file.downloadUrl) : undefined;
    /** Ищем по fileId: после send сообщение уже с серверным id, а не local-file-… */
    setMessages((prev) =>
      prev.map((m) =>
        m.file?.id === fileId
          ? {
              ...m,
              file: {
                id: data.file.id,
                originalName: data.file.originalName ?? m.file?.originalName ?? null,
                mimeType: data.file.mimeType,
                size: data.file.size,
                avStatus: data.file.avStatus ?? m.file?.avStatus ?? null,
                blockedReason: data.file.blockedReason ?? m.file?.blockedReason ?? null,
                ...(url ? { downloadUrl: url } : {}),
              },
            }
          : m,
      ),
    );
  }

  /** Пока нет presigned URL у вложения — запрашиваем сразу и повторяем, пока файл не готов (скан и т.п.). */
  useEffect(() => {
    if (!token || pendingFileHydrateCount === 0) return;
    const tick = () => {
      const list = messagesRef.current;
      for (const m of list) {
        if (
          (m.type === "voice" || m.type === "file") &&
          m.file?.id &&
          !m.file.downloadUrl &&
          !m._localFileState
        ) {
          void hydrateDownloadUrl(m.file.id);
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 2500);
    return () => window.clearInterval(id);
  }, [token, pendingFileHydrateCount]);

  useEffect(() => {
    if (!reactionPopover) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-reaction-trigger]")) return;
      const el = reactionPopoverRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setReactionPopover(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setReactionPopover(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [reactionPopover]);

  async function pickFile() {
    const el = document.createElement("input");
    el.type = "file";
    el.onchange = async () => {
      const f = el.files?.[0];
      if (!f) return;
      await uploadAndSend("file", f, f.name);
    };
    el.click();
  }

  async function startVoiceRecord() {
    if (isRecordingVoice || mediaRecorderRef.current || voiceStartingRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("getUserMedia not supported");
    if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder not supported in browser");
    setChatError("");
    voiceRecordAbortRef.current = false;
    voiceStartingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (voiceRecordAbortRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      mediaStreamRef.current = stream;
      const isApple = isAppleMobileDevice();
      const preferredTypes = isApple
        ? ["audio/mp4", "audio/mp4;codecs=mp4a.40.2", "audio/aac", "audio/webm", "audio/webm;codecs=opus"]
        : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mp4;codecs=mp4a.40.2"];
      const supported = preferredTypes.find((t) => (MediaRecorder as any).isTypeSupported?.(t));
      const rec = supported ? new MediaRecorder(stream, { mimeType: supported }) : new MediaRecorder(stream);
      mediaRecorderRef.current = rec;
      voiceStartAtRef.current = Date.now();
      mediaChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data?.size) mediaChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        try {
          await new Promise((r) => setTimeout(r, isApple ? 240 : 80));
          const mime = (rec.mimeType && rec.mimeType !== "" ? rec.mimeType : "audio/webm").toLowerCase();
          const ext = mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
          const blob = new Blob(mediaChunksRef.current, { type: mime });
          mediaChunksRef.current = [];
          const durationMs = Date.now() - voiceStartAtRef.current;
          if (durationMs < 250) {
            setChatError("Слишком короткая запись. Запишите дольше.");
            return;
          }
          if (blob.size > 0) {
            await uploadAndSend("voice", blob, `voice-${Date.now()}.${ext}`);
          } else {
            setChatError("Голосовое не записалось. Разрешите доступ к микрофону и попробуйте снова.");
          }
        } catch (e: any) {
          const msg = String(e?.message ?? e ?? "Не удалось отправить голосовое");
          setChatError(msg);
          pushLog(`voice error: ${msg}`);
        } finally {
          mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
          mediaStreamRef.current = null;
          mediaRecorderRef.current = null;
          setIsRecordingVoice(false);
        }
      };
      if (voiceRecordAbortRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        return;
      }
      /* Интервал ms — иначе в части браузеров ondataavailable не даёт данные до stop и blob пустой */
      try {
        rec.start(250);
      } catch {
        rec.start();
      }
      setIsRecordingVoice(true);
      setVoiceHoldMs(0);
      pushLog("Запись голосового... нажмите 🎤 или «Готово» для отправки");
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "Не удалось начать запись");
      setChatError(msg);
      pushLog(`voice start error: ${msg}`);
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      mediaRecorderRef.current = null;
      setIsRecordingVoice(false);
    } finally {
      voiceStartingRef.current = false;
    }
  }

  function stopVoiceRecord() {
    voiceRecordAbortRef.current = true;
    setIsRecordingVoice(false);
    const rec = mediaRecorderRef.current;
    if (!rec) {
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      return;
    }
    if (rec.state === "inactive") {
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      mediaRecorderRef.current = null;
      return;
    }
    if (rec.state === "recording" || rec.state === "paused") {
      try {
        if (typeof (rec as MediaRecorder & { requestData?: () => void }).requestData === "function") {
          (rec as MediaRecorder & { requestData: () => void }).requestData();
        }
        rec.stop();
      } catch {
        mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        setIsRecordingVoice(false);
      }
    } else {
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      mediaRecorderRef.current = null;
    }
  }

  stopVoiceRecordRef.current = stopVoiceRecord;

  const composerDisabled = (mode === "channels" ? !activeChannelId : mode === "groups" ? !activeGroupChatId : !activeDirectChatId) || !canWriteChats;
  const uploadDisabled = composerDisabled;
  const canSendText = !!newMessage.trim() && canWriteChats;

  function clearChatDragPreview() {
    setChatDragPreview((prev) => {
      if (prev?.kind === "image") URL.revokeObjectURL(prev.url);
      return null;
    });
    chatDragPreviewKeyRef.current = "";
  }

  function syncChatDragPreview(dt: DataTransfer) {
    let file: File | null = null;
    const item = dt.items?.[0];
    if (item?.kind === "file") file = item.getAsFile();
    if (!file && dt.files?.length) file = dt.files[0];
    if (!file) return;
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (key === chatDragPreviewKeyRef.current) return;
    chatDragPreviewKeyRef.current = key;
    const mime = file.type || "";
    const looksLikeImage = looksLikeImageAttachment(file.name, mime);
    setChatDragPreview((prev) => {
      if (prev?.kind === "image") URL.revokeObjectURL(prev.url);
      if (looksLikeImage) {
        return { kind: "image", url: URL.createObjectURL(file), name: file.name };
      }
      return {
        kind: "file",
        name: file.name,
        ext: fileFormatLabel(file.name, file.type || "application/octet-stream"),
        mime: file.type || "application/octet-stream",
      };
    });
  }

  function onChatDragEnter(e: React.DragEvent<HTMLElement>) {
    e.preventDefault();
    if (!e.dataTransfer.types.includes("Files")) return;
    setChatFileDragActive(true);
    syncChatDragPreview(e.dataTransfer);
  }

  function onChatDragOver(e: React.DragEvent<HTMLElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = uploadDisabled ? "none" : "copy";
    if (!uploadDisabled && e.dataTransfer.types.includes("Files")) {
      setChatFileDragActive(true);
      syncChatDragPreview(e.dataTransfer);
    }
  }

  function onChatDragLeave(e: React.DragEvent<HTMLElement>) {
    e.preventDefault();
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setChatFileDragActive(false);
    clearChatDragPreview();
  }

  async function onChatDrop(e: React.DragEvent<HTMLElement>) {
    e.preventDefault();
    setChatFileDragActive(false);
    clearChatDragPreview();
    if (uploadDisabled || !token) return;
    const { files } = e.dataTransfer;
    if (!files?.length) return;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        await uploadAndSend("file", f, f.name);
      } catch {
        /* ошибка уже в пузыре сообщения */
      }
    }
  }

  /** Дважды нажать 🎤: старт / стоп (без удержания — надёжнее на мобильных). */
  function onVoiceMicClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    if (uploadDisabled) return;
    const rec = mediaRecorderRef.current;
    const active = Boolean(rec && (rec.state === "recording" || rec.state === "paused")) || isRecordingVoice;
    if (active) {
      stopVoiceRecord();
    } else {
      void startVoiceRecord();
    }
  }

  const isAuthed = !!token;

  if (!isAuthed) {
    return (
      <div className="authPage">
        <div className="authCard">
          <div className="authTitle">sf-communication</div>
          <div className="authSub">Вход</div>

          <label>Почта или телефон</label>
          <input
            value={loginIdentifier}
            onChange={(e) => setLoginIdentifier(e.target.value)}
            placeholder="+79991234567 или email@company.ru"
            autoComplete="username"
          />

          <label>Пароль</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Пароль"
            autoComplete="current-password"
          />

          {pendingEmailOtp ? (
            <>
              <label>Код из письма {pendingEmailOtp.emailMasked ? `(${pendingEmailOtp.emailMasked})` : ""}</label>
              <input
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                inputMode="numeric"
              />
              <div className="authRow">
                <button type="button" onClick={(e) => void confirmLoginEmailOtp(e as any)} disabled={otpCode.length !== 6}>
                  Подтвердить вход
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="authRow">
                <button
                  type="button"
                  onClick={(e) => void login(e as any)}
                  disabled={!loginIdentifier.trim() || !password}
                >
                  Войти
                </button>
              </div>
              <button
                type="button"
                className="authLinkBtn"
                onClick={() => setShowForgotPassword(true)}
              >
                Забыли пароль?
              </button>
            </>
          )}
          {authError ? <div style={{ color: "#ff9ea6", fontSize: 12, marginTop: 6 }}>{authError}</div> : null}

          {showForgotPassword ? (
            <div className="modalBackdrop" role="presentation" onClick={() => setShowForgotPassword(false)}>
              <div className="modalPanel" role="dialog" onClick={(e) => e.stopPropagation()}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Восстановление доступа</div>
                <p style={{ fontSize: 13, lineHeight: 1.4, marginTop: 0 }}>
                  Обратитесь к администратору вашей организации, чтобы сбросить пароль.
                </p>
                <button
                  type="button"
                  className="chip"
                  style={{ marginTop: 10 }}
                  onClick={() => setShowForgotPassword(false)}
                >
                  Понятно
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // Админ-страница "Пользователи организации" отключена по требованию

  return (
    <div
      className={`layout ${showRightPanel ? "layout--info" : ""} ${viewportW < 800 && mobileSidebarOpen ? "layout--sidebarOpen" : ""}`}
      style={orgChatLogoCss ? ({ ["--org-chat-logo" as string]: orgChatLogoCss } as CSSProperties) : undefined}
    >
      {appToast ? (
        <div className="appToast" role="status">
          <button type="button" className="appToastClose" onClick={() => setAppToast(null)} aria-label="Закрыть">
            ×
          </button>
          <div className="appToastText">{appToast.text}</div>
        </div>
      ) : null}
      {token &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default" &&
      (isIosLikeBrowser() || isStandaloneWebApp()) ? (
        <div className="notifyPermissionBanner" role="status">
          <span>
            Нажмите «Разрешить», чтобы показывать баннеры браузера, пока вкладка или PWA открыты. В фоне или при закрытом приложении нужны push-уведомления с сервера (Web Push) — без них сеть доставит событие только когда клиент снова онлайн. iPhone: ярлык «Домой», iOS 16.4+; в Яндекс.Браузере возможности могут отличаться от Safari.
          </span>
          <button
            type="button"
            onClick={() => {
              void Notification.requestPermission().then((r) => {
                if (r === "granted") setBrowserNotify(true);
              });
            }}
          >
            Разрешить
          </button>
        </div>
      ) : null}
      {chatFoldersEditorOpen ? (
        <>
          <div className="moreMenuBackdrop" role="presentation" onClick={() => setChatFoldersEditorOpen(false)} />
          <div className="chatFoldersEditor" role="dialog" aria-label="Папки с чатами">
            <div className="chatFoldersEditorHead">
              <span>Папки с чатами</span>
              <button type="button" className="tgCircleBtn" aria-label="Закрыть" onClick={() => setChatFoldersEditorOpen(false)}>
                ✕
              </button>
            </div>
            <p className="chatFoldersEditorHint">
              Хранится только в этом браузере. Чтобы положить чат в папку: откройте меню ⋮ у строки чата → «Папка…». Подчаты (темы) — откройте сообщение → «Ответить в теме» (ветка внутри чата).
            </p>
            <ul className="chatFoldersEditorList">
              {userChatFolderLayout.folders
                .slice()
                .sort((a, b) => a.order - b.order)
                .map((f) => (
                  <li key={f.id}>
                    <span className="chatFoldersEditorName">{f.name}</span>
                    <button type="button" className="chatFoldersEditorDel" onClick={() => removeNamedChatFolder(f.id)}>
                      Удалить
                    </button>
                  </li>
                ))}
            </ul>
            <div className="chatFoldersEditorAdd">
              <input
                className="tgSearch"
                placeholder="Название новой папки"
                value={newChatFolderDraft}
                onChange={(e) => setNewChatFolderDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    addNamedChatFolder(newChatFolderDraft);
                    setNewChatFolderDraft("");
                  }
                }}
              />
              <button
                type="button"
                className="chip"
                onClick={() => {
                  addNamedChatFolder(newChatFolderDraft);
                  setNewChatFolderDraft("");
                }}
              >
                Добавить папку
              </button>
            </div>
          </div>
        </>
      ) : null}
      {groupMeshUi ? (
        <div className="webrtcOverlay groupMeshOverlay groupMeshOverlay--meeting" role="dialog" aria-label="Групповой звонок">
          <div className="groupMeshPanel groupMeshPanel--meeting">
            <div className="groupMeshHead">
              <span className="groupMeshTitle">{groupMeshUi.title}</span>
              <button type="button" className="tgCircleBtn" aria-label="Завершить" onClick={() => groupMeshUi.hangup()}>
                ✕
              </button>
            </div>
            {groupMeshUi.audioOnly ? (
              <div
                className="groupMeshGrid"
                style={{
                  gridTemplateColumns: `repeat(${Math.min(4, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, 1 + Object.keys(groupMeshUi.remotes).length)))))}, minmax(0, 1fr))`,
                }}
              >
                {Object.entries(groupMeshUi.remotes).map(([pid, stream]) => (
                  <div key={pid} className="groupMeshCell">
                    {stream ? (
                      groupMeshUi.audioOnly ? (
                        <GroupMeshRemoteVideo userId={pid} stream={stream} showVideo={false} playAudio />
                      ) : (
                        <GroupMeshRemoteVideo userId={pid} stream={stream} />
                      )
                    ) : (
                      <div className="groupMeshAudioOnly">{displayUser(pid)}</div>
                    )}
                    <div className="groupMeshLabel">
                      {groupMeshHands[pid] ? "✋ " : ""}
                      {displayUser(pid)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="groupMeshMeetingBody">
                <div className="groupMeshAudioLayer" aria-hidden>
                  {Object.entries(groupMeshUi.remotes).map(([pid, stream]) =>
                    stream ? <GroupMeshRemoteVideo key={`ga-${pid}`} userId={pid} stream={stream} showVideo={false} playAudio /> : null,
                  )}
                </div>
                <div className="groupMeshFilmstrip">
                  {Object.entries(groupMeshUi.remotes).map(([pid, stream]) => (
                    <button
                      key={pid}
                      type="button"
                      className={`groupMeshFilmstripCell ${groupMeshStagePeerId === pid ? "groupMeshFilmstripCell--active" : ""}`}
                      onClick={() => setGroupMeshSpotlightPeerId(pid)}
                    >
                      <div className="groupMeshFilmstripThumb">
                        {stream ? (
                          <GroupMeshRemoteVideo userId={pid} stream={stream} playAudio={false} videoClassName="groupMeshFilmstripVideo" />
                        ) : (
                          <div className="groupMeshFilmstripPlaceholder">{displayUser(pid)}</div>
                        )}
                      </div>
                      <span className="groupMeshFilmstripName">
                        {groupMeshHands[pid] ? "✋ " : ""}
                        {displayUser(pid)}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="groupMeshStage">
                  {groupMeshStagePeerId && groupMeshUi.remotes[groupMeshStagePeerId] ? (
                    <GroupMeshRemoteVideo
                      userId={groupMeshStagePeerId}
                      stream={groupMeshUi.remotes[groupMeshStagePeerId]!}
                      playAudio={false}
                      videoClassName="groupMeshStageVideo"
                    />
                  ) : (
                    <div className="groupMeshStageEmpty">Ожидание участников…</div>
                  )}
                </div>
                <div className="groupMeshLocalPip">
                  <video
                    key={`gml-${groupMeshUi.groupChatId}-${groupMeshMediaTick}`}
                    className="webrtcLocal"
                    autoPlay
                    playsInline
                    muted
                    ref={(el) => {
                      if (el && groupMeshUi.localStream) {
                        el.srcObject = groupMeshUi.localStream;
                        void el.play().catch(() => {});
                      }
                    }}
                  />
                </div>
              </div>
            )}
            <div className="webrtcToolbar groupMeshToolbar">
              <button
                type="button"
                className={`webrtcToolBtn ${
                  groupMeshUi.localStream.getAudioTracks()[0]?.enabled !== false ? "webrtcToolBtn--on" : "webrtcToolBtn--off"
                }`}
                onClick={() => {
                  groupMeshUi.localStream.getAudioTracks().forEach((t) => {
                    t.enabled = !t.enabled;
                  });
                  setGroupMeshMediaTick((x) => x + 1);
                }}
              >
                🎤 Мик
              </button>
              {!groupMeshUi.audioOnly ? (
                <button
                  type="button"
                  className={`webrtcToolBtn ${
                    groupMeshUi.localStream.getVideoTracks()[0]?.enabled !== false ? "webrtcToolBtn--on" : "webrtcToolBtn--off"
                  }`}
                  onClick={() => {
                    groupMeshUi.localStream.getVideoTracks().forEach((t) => {
                      t.enabled = !t.enabled;
                    });
                    setGroupMeshMediaTick((x) => x + 1);
                  }}
                >
                  📷 Кам
                </button>
              ) : null}
              {!groupMeshUi.audioOnly ? (
                <button
                  type="button"
                  className={`webrtcToolBtn ${groupMeshSessionRef.current?.isScreenSharing() ? "webrtcToolBtn--on" : ""}`}
                  title="Показать экран (как в Телемосте)"
                  onClick={() => {
                    void (async () => {
                      try {
                        const s = groupMeshSessionRef.current;
                        if (!s) return;
                        if (s.isScreenSharing()) await s.stopScreenShare();
                        else await s.startScreenShare();
                        setGroupMeshMediaTick((x) => x + 1);
                      } catch (e: unknown) {
                        setChatError(String((e as Error)?.message ?? e ?? "Экран"));
                      }
                    })();
                  }}
                >
                  🖥 Экран
                </button>
              ) : null}
              <button
                type="button"
                className={`webrtcToolBtn ${groupMeshHands[userId] ? "webrtcToolBtn--accent" : ""}`}
                onClick={() => toggleGroupMeshRaiseHand()}
                title="Поднять руку"
              >
                ✋ Рука
              </button>
              <button type="button" className="webrtcToolBtn" onClick={() => copyGroupCallInviteLink()} title="Ссылка для новых участников">
                🔗 Ссылка
              </button>
              <button type="button" className="webrtcToolBtn webrtcToolBtn--danger" onClick={() => groupMeshUi.hangup()}>
                Завершить
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {viewportW < 800 && mobileSidebarOpen ? (
        <button type="button" className="sidebarBackdrop" aria-label="Закрыть список чатов" onClick={() => setMobileSidebarOpen(false)} />
      ) : null}
      <aside className={`sidebar ${viewportW < 800 ? "sidebar--mobile" : ""} ${viewportW < 800 && mobileSidebarOpen ? "sidebar--openMobile" : ""}`}>
        <div className="tgSidebarTopBar">
          <button
            type="button"
            className={`tgBurgerBtn ${viewportW < 800 ? "tgBurgerBtn--visible" : ""}`}
            aria-label="Список чатов"
            onClick={() => setMobileSidebarOpen((v) => !v)}
          >
            ☰
          </button>
          <div className="tgLogoMark tgLogoMark--brand" aria-hidden title="Sales factory">
            <span className="tgLogoPlane">SF</span>
            {totalUnread > 0 ? (
              <span className="tgLogoBadge" aria-hidden>
                {totalUnread > 9 ? "9+" : totalUnread}
              </span>
            ) : null}
          </div>
          <div className="tgTopBarTitle" title={orgBrandName || "Sales factory"}>
            <span className="tgBrandLine">
              <span className="tgBrandSales">Sales</span>{" "}
              <span className="tgBrandFactory">factory</span>
            </span>
            {orgBrandDisplay ? <span className="tgBrandOrg">{orgBrandDisplay}</span> : null}
          </div>
          <div className="tgTopBarActions">
            <div className="tgMenuAnchor">
              <button
                type="button"
                className="tgCircleBtn"
                title="Создать чат или группу"
                onClick={() => {
                  setNewChatMenuOpen((v) => !v);
                  setMoreMenuOpen(false);
                }}
              >
                +
              </button>
              {newChatMenuOpen ? (
                <div className="tgPopoverMenu">
                  <button
                    type="button"
                    className="tgPopoverItem"
                    onClick={() => void openNewThingWizard("dm")}
                    disabled={!token || !organizationId || !canReadChats}
                  >
                    ✉ Личный чат (1 на 1)
                  </button>
                  <button
                    type="button"
                    className="tgPopoverItem"
                    onClick={() => void openNewThingWizard("group")}
                    disabled={!token || !organizationId || !canCreateChannelsAndGroups}
                  >
                    👥 Группа (несколько человек)
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="tgCircleBtn"
              title="Ещё — поиск, профиль, компания…"
              onClick={() => {
                setMoreMenuOpen((v) => !v);
                setNewChatMenuOpen(false);
              }}
            >
              ⋮
            </button>
          </div>
        </div>
        <div className="tgSearchWrap">
          <span className="tgSearchIcon" aria-hidden>
            ⌕
          </span>
          <input
            className="tgSearch tgSearch--inWrap"
            placeholder="Поиск по названию чата…"
            value={chatSearch}
            onChange={(e) => setChatSearch(e.target.value)}
            ref={chatSearchRef}
            title="Ctrl/Cmd + K"
          />
        </div>

        <div
          className="sidebarChatsBlock"
          ref={sidebarChatsScrollRef}
          title="Потяните список вниз или прокрутите колесом вверх у верхнего края — обновить статусы онлайн"
        >
          <div className="tgFolderTabsWithFilter tgMenuAnchor" ref={chatListFilterAnchorRef}>
            <div className="row tgFolderTabs tgFolderTabs--grow">
              <button className={chatFolder === "all" ? "active" : ""} onClick={() => setChatFolder("all")}>
                Все
              </button>
              <button className={chatFolder === "unread" ? "active" : ""} onClick={() => setChatFolder("unread")}>
                Непрочитанные
              </button>
            </div>
            <button
              type="button"
              className="tgCircleBtn tgChatScopeFilterBtn"
              title={
                chatListScope === "all"
                  ? "Фильтр списка: все чаты"
                  : chatListScope === "dms"
                    ? "Фильтр: личные чаты"
                    : chatListScope === "groups"
                      ? "Фильтр: группы"
                      : "Фильтр: каналы"
              }
              aria-label={
                chatListScope === "all"
                  ? "Фильтр: все чаты"
                  : chatListScope === "dms"
                    ? "Фильтр: личные"
                    : chatListScope === "groups"
                      ? "Фильтр: группы"
                      : "Фильтр: каналы"
              }
              aria-expanded={chatListFilterOpen}
              aria-haspopup="menu"
              onClick={() => setChatListFilterOpen((v) => !v)}
            >
              <svg className="tgChatScopeFilterIcon" width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                <path
                  fill="currentColor"
                  d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"
                />
              </svg>
            </button>
            {chatListFilterOpen ? (
              <div className="tgPopoverMenu tgChatScopePopover" role="menu">
                <button
                  type="button"
                  className="tgPopoverItem"
                  role="menuitem"
                  onClick={() => {
                    setChatListScope("all");
                    setChatListFilterOpen(false);
                  }}
                >
                  Все чаты
                </button>
                <button
                  type="button"
                  className="tgPopoverItem"
                  role="menuitem"
                  onClick={() => {
                    setChatListScope("dms");
                    setChatListFilterOpen(false);
                  }}
                >
                  Личные чаты
                </button>
                <button
                  type="button"
                  className="tgPopoverItem"
                  role="menuitem"
                  onClick={() => {
                    setChatListScope("groups");
                    setChatListFilterOpen(false);
                  }}
                >
                  Группы
                </button>
                <button
                  type="button"
                  className="tgPopoverItem"
                  role="menuitem"
                  onClick={() => {
                    setChatListScope("channels");
                    setChatListFilterOpen(false);
                  }}
                >
                  Каналы
                </button>
                <div className="tgPopoverSep" role="separator" />
                <button
                  type="button"
                  className={`tgPopoverItem ${chatFolder === "archived" ? "tgPopoverItem--active" : ""}`}
                  role="menuitem"
                  onClick={() => {
                    setChatFolder("archived");
                    setChatListFilterOpen(false);
                  }}
                >
                  Архив
                </button>
              </div>
            ) : null}
          </div>
          <div className="tgChatList">
            {chatListScope === "all" ? (
              <>
                {sidebarFolderLayout.mode === "flat"
                  ? sidebarFolderLayout.rows.map((row) => renderUnifiedChatRow(row))
                  : sidebarFolderLayout.sections.map((sec) => {
                      if (sec.id === "__unfiled__") {
                        return <div key={sec.id}>{sec.rows.map((row) => renderUnifiedChatRow(row))}</div>;
                      }
                      const open = !!expandedChatFolderIds[sec.id];
                      return (
                        <div key={sec.id} className="tgFolderBlock">
                          <button
                            type="button"
                            className={`tgChatRow tgChatRow--folderToggle ${open ? "tgChatRow--folderToggleOpen" : ""}`}
                            onClick={(e) => {
                              e.preventDefault();
                              setExpandedChatFolderIds((prev) => {
                                const nextOpen = !prev[sec.id];
                                if (!nextOpen) return { ...prev, [sec.id]: false };
                                return { [sec.id]: true };
                              });
                            }}
                          >
                            <div className="tgAvatar tgAvatar--folder">{open ? "📂" : "📁"}</div>
                            <div className="tgChatMain">
                              <div className="tgChatTop">
                                <div className="tgChatTitle">
                                  <span className="tgFolderChevron" aria-hidden>
                                    {open ? "▼" : "▶"}
                                  </span>{" "}
                                  {sec.name}
                                </div>
                                <div className="tgChatTopRight">
                                  <span className="tgFolderCount">{sec.rows.length}</span>
                                </div>
                              </div>
                              <div className="tgChatSub tgChatSub--folderHint">Нажмите, чтобы развернуть или свернуть</div>
                            </div>
                          </button>
                          {open ? <div className="tgFolderBlockInner">{sec.rows.map((row) => renderUnifiedChatRow(row))}</div> : null}
                        </div>
                      );
                    })}
              </>
            ) : chatListScope === "channels"
              ? orderedChannels.map((c) => (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    className={`tgChatRow ${activeChannelId === c.id ? "active" : ""} ${dragPinnedKey === chatKeyFor("c", c.id) ? "dragging" : ""} ${dragOverPinnedKey === chatKeyFor("c", c.id) ? "dragover" : ""}`}
                    draggable={isPinned(chatKeyFor("c", c.id))}
                    onDragStart={() => setDragPinnedKey(chatKeyFor("c", c.id))}
                    onDragEnd={() => {
                      setDragPinnedKey("");
                      setDragOverPinnedKey("");
                    }}
                    onDragOver={(e) => {
                      if (!dragPinnedKey || !isPinned(chatKeyFor("c", c.id))) return;
                      e.preventDefault();
                      setDragOverPinnedKey(chatKeyFor("c", c.id));
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      reorderPinned(dragPinnedKey, chatKeyFor("c", c.id));
                      setDragPinnedKey("");
                      setDragOverPinnedKey("");
                    }}
                    onClick={() => {
                      setMode("channels");
                      setActiveChannelId(c.id);
                      setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("c", c.id)]: 0 }));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setMode("channels");
                        setActiveChannelId(c.id);
                        setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("c", c.id)]: 0 }));
                      }
                    }}
                  >
                    <div className={`tgAvatar ${c.avatarUrl ? "tgAvatar--img" : ""}`}>
                      {c.avatarUrl ? <img src={c.avatarUrl} alt="" className="tgAvatarImg" /> : "#"}
                    </div>
                    <div className="tgChatMain">
                      <div className="tgChatTop">
                        <div className="tgChatTitle">{isPinned(chatKeyFor("c", c.id)) ? "📌 " : ""}#{c.name}</div>
                        <div className="tgChatTopRight">
                          <button
                            type="button"
                            className="tgChatRowMenuBtn"
                            title="Чат: закрепить, архив, удалить"
                            aria-label="Действия с чатом"
                            onClick={(e) => openChatMenuAtEditButton(e, chatKeyFor("c", c.id))}
                          >
                            ⋮
                          </button>
                          <div
                            className="tgChatTime"
                            onContextMenu={(e) => openChatMenuAtTime(e, chatKeyFor("c", c.id))}
                          >
                            {timeHHMM(chatPreviewByKey[chatKeyFor("c", c.id)]?.at)}
                          </div>
                        </div>
                      </div>
                      <div className="tgChatSub">
                        {isMuted(chatKeyFor("c", c.id)) ? "🔕 " : ""}
                        {chatPreviewByKey[chatKeyFor("c", c.id)]?.text?.trim() || `Канал · ${c.type}`}
                      </div>
                    </div>
                    {unreadFor(chatKeyFor("c", c.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("c", c.id))}</div> : null}
                  </div>
                ))
              : chatListScope === "groups"
                ? orderedGroups.map((g) => (
                    <div
                      key={g.id}
                      role="button"
                      tabIndex={0}
                      className={`tgChatRow ${activeGroupChatId === g.id ? "active" : ""} ${dragPinnedKey === chatKeyFor("g", g.id) ? "dragging" : ""} ${dragOverPinnedKey === chatKeyFor("g", g.id) ? "dragover" : ""}`}
                      draggable={isPinned(chatKeyFor("g", g.id))}
                      onDragStart={() => setDragPinnedKey(chatKeyFor("g", g.id))}
                      onDragEnd={() => {
                        setDragPinnedKey("");
                        setDragOverPinnedKey("");
                      }}
                      onDragOver={(e) => {
                        if (!dragPinnedKey || !isPinned(chatKeyFor("g", g.id))) return;
                        e.preventDefault();
                        setDragOverPinnedKey(chatKeyFor("g", g.id));
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        reorderPinned(dragPinnedKey, chatKeyFor("g", g.id));
                        setDragPinnedKey("");
                        setDragOverPinnedKey("");
                      }}
                      onClick={() => {
                        setMode("groups");
                        setActiveGroupChatId(g.id);
                        setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("g", g.id)]: 0 }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setMode("groups");
                          setActiveGroupChatId(g.id);
                          setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("g", g.id)]: 0 }));
                        }
                      }}
                    >
                      <div className={`tgAvatar ${g.avatarUrl ? "tgAvatar--img" : ""}`}>
                        {g.avatarUrl ? <img src={g.avatarUrl} alt="" className="tgAvatarImg" /> : initials(g.name)}
                      </div>
                      <div className="tgChatMain">
                        <div className="tgChatTop">
                          <div className="tgChatTitle">{isPinned(chatKeyFor("g", g.id)) ? "📌 " : ""}{g.name}</div>
                          <div className="tgChatTopRight">
                            <button
                              type="button"
                              className="tgChatRowMenuBtn"
                              title="Чат: закрепить, архив, удалить"
                              aria-label="Действия с чатом"
                              onClick={(e) => openChatMenuAtEditButton(e, chatKeyFor("g", g.id))}
                            >
                              ⋮
                            </button>
                            <div
                              className="tgChatTime"
                              onContextMenu={(e) => openChatMenuAtTime(e, chatKeyFor("g", g.id))}
                            >
                              {timeHHMM(chatPreviewByKey[chatKeyFor("g", g.id)]?.at)}
                            </div>
                          </div>
                        </div>
                        <div className="tgChatSub">
                          {isMuted(chatKeyFor("g", g.id)) ? "🔕 " : ""}
                          {chatPreviewByKey[chatKeyFor("g", g.id)]?.text?.trim() ||
                            (g.memberIds?.length ? `Участников: ${g.memberIds.length}` : "Нет сообщений")}
                        </div>
                      </div>
                    {unreadFor(chatKeyFor("g", g.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("g", g.id))}</div> : null}
                    </div>
                  ))
                : orderedDMs.map((d) => {
                    const isSelfNotesDm = d.userIds.length === 1 && d.userIds[0] === userId;
                    const otherId = d.userIds.find((id) => id !== userId) ?? d.userIds[0] ?? "";
                    const u = users.find((x) => x.id === otherId);
                    const p = otherId ? presenceByUserId[otherId] : undefined;
                    const st = p?.status ?? u?.status ?? "unknown";
                    const dot = isSelfNotesDm ? "⭐" : st === "online" ? "●" : st === "away" ? "◐" : st === "dnd" ? "◍" : "○";
                    const title = isSelfNotesDm ? "Избранное" : displayUserNameForSidebar(u, otherId || d.id);
                    return (
                      <div
                        key={d.id}
                        role="button"
                        tabIndex={0}
                        className={`tgChatRow ${activeDirectChatId === d.id ? "active" : ""} ${dragPinnedKey === chatKeyFor("d", d.id) ? "dragging" : ""} ${dragOverPinnedKey === chatKeyFor("d", d.id) ? "dragover" : ""}`}
                        draggable={isPinned(chatKeyFor("d", d.id))}
                        onDragStart={() => setDragPinnedKey(chatKeyFor("d", d.id))}
                        onDragEnd={() => {
                          setDragPinnedKey("");
                          setDragOverPinnedKey("");
                        }}
                        onDragOver={(e) => {
                          if (!dragPinnedKey || !isPinned(chatKeyFor("d", d.id))) return;
                          e.preventDefault();
                          setDragOverPinnedKey(chatKeyFor("d", d.id));
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          reorderPinned(dragPinnedKey, chatKeyFor("d", d.id));
                          setDragPinnedKey("");
                          setDragOverPinnedKey("");
                        }}
                        onClick={() => {
                          setMode("dms");
                          setActiveDirectChatId(d.id);
                          setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("d", d.id)]: 0 }));
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setMode("dms");
                            setActiveDirectChatId(d.id);
                            setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("d", d.id)]: 0 }));
                          }
                        }}
                      >
                        {(() => {
                          const avatarHref = isSelfNotesDm
                            ? normalizeDownloadUrl(profileAvatarUrl)
                            : normalizeDownloadUrl(u?.avatarUrl);
                          return avatarHref ? (
                            <div className="tgAvatar tgAvatar--img">
                              <img src={avatarHref} alt="" className="tgAvatarImg" />
                            </div>
                          ) : (
                            <div className="tgAvatar">{initials(title)}</div>
                          );
                        })()}
                        <div className="tgChatMain">
                          <div className="tgChatTop">
                            <div className="tgChatTitle">
                              {isPinned(chatKeyFor("d", d.id)) ? "📌 " : ""}
                              <span className="tgPresence">{dot}</span> {title}
                            </div>
                            <div className="tgChatTopRight">
                              <button
                                type="button"
                                className="tgChatRowMenuBtn"
                                title="Чат: закрепить, архив, удалить"
                                aria-label="Действия с чатом"
                                onClick={(e) => openChatMenuAtEditButton(e, chatKeyFor("d", d.id))}
                              >
                                ⋮
                              </button>
                              <div
                                className="tgChatTime"
                                onContextMenu={(e) => openChatMenuAtTime(e, chatKeyFor("d", d.id))}
                              >
                                {timeHHMM(chatPreviewByKey[chatKeyFor("d", d.id)]?.at)}
                              </div>
                            </div>
                          </div>
                          <div className="tgChatSub">
                            {isMuted(chatKeyFor("d", d.id)) ? "🔕 " : ""}
                            {chatPreviewByKey[chatKeyFor("d", d.id)]?.text?.trim() || "Нет сообщений"}
                          </div>
                        </div>
                        {unreadFor(chatKeyFor("d", d.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("d", d.id))}</div> : null}
                      </div>
                    );
                  })}
          </div>
        </div>

        {moreMenuOpen ? (
          <>
            <div className="moreMenuBackdrop" role="presentation" onClick={() => setMoreMenuOpen(false)} />
            <div className="moreMenuPanel">
              <div className="moreMenuHeader">
                <span>Меню</span>
                <button type="button" className="tgCircleBtn" aria-label="Закрыть" onClick={() => setMoreMenuOpen(false)}>
                  ✕
                </button>
              </div>
              <div className="moreMenuBody">
                {token ? (
                  <div className="moreMenuProfileCard">
                    <div
                      className={`moreMenuProfileAvatar ${profileAvatarUrl ? "moreMenuProfileAvatar--img" : ""}`}
                      role={profileAvatarUrl ? "button" : undefined}
                      tabIndex={profileAvatarUrl ? 0 : undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!profileAvatarUrl) return;
                        setPhotoLightboxUrl(String(profileAvatarUrl));
                      }}
                      onKeyDown={(e) => {
                        if (!profileAvatarUrl) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          setPhotoLightboxUrl(String(profileAvatarUrl));
                        }
                      }}
                    >
                      {profileAvatarUrl ? <img src={profileAvatarUrl} alt="" draggable={false} /> : <span>{initials(myProfileEmail || loginIdentifier)}</span>}
                    </div>
                    <div className="moreMenuProfileText">
                      <div className="moreMenuProfileName">
                        {displayUserNameForSidebar(
                          {
                            email: myProfileEmail || loginIdentifier,
                            lastName: profileLastName || null,
                            firstName: profileFirstName || null,
                            middleName: profileMiddleName || null,
                          },
                          myProfileEmail || loginIdentifier,
                        )}
                      </div>
                      {profilePhone.trim() ? <div className="moreMenuProfilePhone">{profilePhone.trim()}</div> : null}
                    </div>
                  </div>
                ) : null}
                <div className="moreMenuSection">
                  <button
                    type="button"
                    className="moreMenuWideBtn"
                    onClick={() => {
                      setShowUserCabinet(true);
                      setProfileMsg("");
                      void loadMyProfile();
                      setMoreMenuOpen(false);
                    }}
                    disabled={!token}
                  >
                    Личный кабинет
                  </button>
                  {isCompanyAdmin ? (
                    <button
                      type="button"
                      className="moreMenuWideBtn"
                      onClick={() => {
                        setShowCompanyCabinet(true);
                        void loadUsers();
                        setMoreMenuOpen(false);
                      }}
                      disabled={!token || !organizationId}
                    >
                      Кабинет компании
                    </button>
                  ) : null}
                  {/* Админ: пользователи скрыто по требованию */}
                  <button
                    type="button"
                    className="moreMenuWideBtn subtle"
                    onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                  >
                    {theme === "dark" ? "Светлая тема" : "Тёмная тема"}
                  </button>
                  <button
                    type="button"
                    className="moreMenuWideBtn subtle"
                    onClick={() => {
                      void (async () => {
                        if (!token) return;
                        if (!browserNotify) {
                          if (typeof Notification === "undefined") {
                            setChatError(
                              browserNotifyHint ||
                                "В этом браузере уведомления для сайта недоступны. На iPhone — ярлык на экран «Домой»; на Android — Chrome и разрешение для сайта.",
                            );
                            pushLog("Notifications API недоступен (часто мобильный Safari во вкладке).");
                            return;
                          }
                          if (Notification.permission === "denied") {
                            setChatError(
                              "Уведомления заблокированы в браузере. Откройте настройки сайта для sf-communication.ru и разрешите уведомления, затем обновите страницу.",
                            );
                            pushLog("Notifications permission=denied");
                            return;
                          }
                          if (Notification.permission === "default") {
                            const r = await Notification.requestPermission();
                            if (r !== "granted") {
                              setChatError(
                                "Разрешение не выдано (закрыли запрос или нажали «Блокировать»). Разрешите уведомления в настройках сайта и попробуйте снова.",
                              );
                              setBrowserNotify(false);
                              pushLog(`Notifications permission=${r}`);
                              return;
                            }
                          }
                          setBrowserNotify(true);
                          pushLog("Уведомления браузера включены.");
                          return;
                        }
                        setBrowserNotify(false);
                        pushLog("Уведомления браузера выключены.");
                      })();
                    }}
                    disabled={!token}
                  >
                    {browserNotify ? "Отключить уведомления браузера" : "Включить уведомления браузера"}
                  </button>
                  {browserNotifyHint ? (
                    <p className="moreMenuNotifyHint">{browserNotifyHint}</p>
                  ) : null}
                  <button
                    type="button"
                    className="moreMenuWideBtn"
                    onClick={() => {
                      void loadSavedMessages();
                      setMoreMenuOpen(false);
                    }}
                    disabled={!token}
                  >
                    Сохранённые сообщения
                  </button>
                  <button
                    type="button"
                    className="moreMenuWideBtn subtle"
                    onClick={() => {
                      void openSavedVaultChat();
                      setMoreMenuOpen(false);
                      setMobileSidebarOpen(false);
                    }}
                    disabled={!token || !userId}
                  >
                    Избранное — заметки для себя
                  </button>
                  {/* Админские отладочные панели скрыты по требованию */}
                  <button
                    type="button"
                    className="moreMenuWideBtn danger"
                    onClick={() => {
                      void logout();
                      setMoreMenuOpen(false);
                    }}
                  >
                    Выйти
                  </button>
                </div>
                <div className="moreMenuSection">
                  <div className="moreMenuLabel">Пользователи</div>
                  {users.length === 0 ? (
                    <div className="empty">
                      {isCompanyAdmin
                        ? "Загрузите список (ниже: «Отладка и загрузка данных» → Users)"
                        : "Список коллег появится после загрузки организацией."}
                    </div>
                  ) : (
                    <div className="moreMenuUsers">
                      {users.slice(0, 80).map((u) => {
                        const p = presenceByUserId[u.id];
                        const st = p?.status ?? u.status ?? "unknown";
                        return (
                          <button
                            key={u.id}
                            type="button"
                            className="moreMenuUserRow"
                            onClick={() => {
                              void ensureDmWithUser(u.id);
                              setMoreMenuOpen(false);
                              setMobileSidebarOpen(false);
                            }}
                            disabled={!token || !canWriteChats}
                          >
                            <span className="moreMenuUserDot">
                              {st === "online" ? "●" : st === "away" ? "◐" : st === "dnd" ? "◍" : "○"}
                            </span>
                            <span className="moreMenuUserLabel">
                              <span className="moreMenuUserName">{displayUserNameForSidebar(u, u.id)}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                {/* Админские отладочные панели скрыты по требованию */}
              </div>
            </div>
          </>
        ) : null}

        {chatMenu ? (
          <div
            ref={chatMenuRef}
            className="chatMenu chatMenu--wide"
            style={{ top: chatMenu.y, left: chatMenu.x }}
            role="menu"
            onClick={(e) => e.stopPropagation()}
          >
            {chatMenu.sub === "main" ? (
              <>
                <button type="button" className="msgMenuItem" onClick={() => { togglePin(chatMenu.key); setChatMenu(null); }}>
                  {isPinned(chatMenu.key) ? "Открепить чат" : "Закрепить чат"}
                </button>
                <div className="msgMenuSep" />
                <button
                  type="button"
                  className="msgMenuItem msgMenuItem--emph"
                  onClick={() => setChatMenu((m) => (m ? { ...m, sub: "folder" } : m))}
                >
                  📁 Папка…
                </button>
                <button
                  type="button"
                  className="msgMenuItem msgMenuItem--emph"
                  onClick={() => setChatMenu((m) => (m ? { ...m, sub: "notify" } : m))}
                >
                  🔔 Уведомления…
                </button>
                <button type="button" className="msgMenuItem" onClick={() => { toggleArchive(chatMenu.key); setChatMenu(null); }}>
                  {isArchived(chatMenu.key) ? "Вернуть из архива" : "В архив"}
                </button>
                {!isArchived(chatMenu.key) ? (
                  <button type="button" className="msgMenuItem danger" onClick={() => removeChatFromList(chatMenu.key)}>
                    Удалить из списка
                  </button>
                ) : null}
              </>
            ) : chatMenu.sub === "folder" ? (
              <>
                <button
                  type="button"
                  className="msgMenuItem"
                  onClick={() => setChatMenu((m) => (m ? { ...m, sub: "main" } : m))}
                >
                  ← Назад
                </button>
                <div className="msgMenuSep" />
                <div className="msgMenuSub">Переместить в папку (локально на устройстве)</div>
                {userChatFolderLayout.folders.length === 0 ? (
                  <div className="msgMenuSub" style={{ textTransform: "none", fontWeight: 400, lineHeight: 1.35 }}>
                    Папок пока нет. Нажмите 📁 над списком чатов, создайте папку, затем снова откройте «Папка…» здесь.
                  </div>
                ) : null}
                <button type="button" className="msgMenuItem" onClick={() => assignChatToFolderKey(chatMenu.key, null)}>
                  Без папки
                </button>
                {userChatFolderLayout.folders
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className="msgMenuItem"
                      onClick={() => assignChatToFolderKey(chatMenu.key, f.id)}
                    >
                      {f.name}
                    </button>
                  ))}
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="msgMenuItem"
                  onClick={() => setChatMenu((m) => (m ? { ...m, sub: "main" } : m))}
                >
                  ← Назад
                </button>
                <div className="msgMenuSep" />
                <div className="msgMenuSub">Отключить уведомления на срок</div>
                <button type="button" className="msgMenuItem" onClick={() => { setChatMute(chatMenu.key, 0.5); setChatMenu(null); }}>
                  30 мин
                </button>
                <button type="button" className="msgMenuItem" onClick={() => { setChatMute(chatMenu.key, 1); setChatMenu(null); }}>
                  1 ч
                </button>
                <button type="button" className="msgMenuItem" onClick={() => { setChatMute(chatMenu.key, 2); setChatMenu(null); }}>
                  2 ч
                </button>
                <button type="button" className="msgMenuItem" onClick={() => { setChatMute(chatMenu.key, 4); setChatMenu(null); }}>
                  4 ч
                </button>
                <button type="button" className="msgMenuItem" onClick={() => { setChatMute(chatMenu.key, 8); setChatMenu(null); }}>
                  8 ч
                </button>
                <button type="button" className="msgMenuItem" onClick={() => { setChatMute(chatMenu.key, 24); setChatMenu(null); }}>
                  24 ч
                </button>
                <button type="button" className="msgMenuItem" onClick={() => { setChatMute(chatMenu.key, 24 * 7); setChatMenu(null); }}>
                  7 дней
                </button>
                <button type="button" className="msgMenuItem" onClick={() => { setChatMute(chatMenu.key, "forever"); setChatMenu(null); }}>
                  Навсегда
                </button>
                <button type="button" className="msgMenuItem" onClick={() => { setChatMute(chatMenu.key, "off"); setChatMenu(null); }}>
                  Включить уведомления
                </button>
              </>
            )}
          </div>
        ) : null}
      </aside>

      <main
        className={`chat${chatFileDragActive ? " chat--dropTarget" : ""}`}
        onDragEnter={onChatDragEnter}
        onDragOver={onChatDragOver}
        onDragLeave={onChatDragLeave}
        onDrop={(e) => void onChatDrop(e)}
      >
        {chatFileDragActive ? (
          <div className="chatDropOverlay" aria-hidden>
            <div className="chatDropOverlayInner">
              {chatDragPreview?.kind === "image" ? (
                <>
                  <img src={chatDragPreview.url} alt="" className="chatDropPreviewImg" />
                  <div className="chatDropHint">{chatDragPreview.name}</div>
                </>
              ) : chatDragPreview?.kind === "file" ? (
                <>
                  <div className="chatDropFileBadge">{chatDragPreview.ext}</div>
                  <div className="chatDropHint">{chatDragPreview.name}</div>
                  <div className="chatDropSub">{chatDragPreview.mime}</div>
                </>
              ) : (
                <div className="chatDropHint">Отпустите файл, чтобы отправить в чат</div>
              )}
            </div>
          </div>
        ) : null}
        <header className="chatHeader">
          <div className="tgChatHeaderRow">
            <div className="tgChatHeaderLeft">
              <button
                type="button"
                className={`tgBurgerBtn tgBurgerBtn--inChat ${viewportW < 800 ? "tgBurgerBtn--visible" : ""}`}
                aria-label="Открыть список чатов"
                onClick={() => setMobileSidebarOpen(true)}
              >
                ☰
              </button>
              <div
                className={`tgHeaderAvatar ${mode === "channels" && activeChannel?.avatarUrl ? "tgHeaderAvatar--img" : ""} ${mode === "groups" && activeGroupChat?.avatarUrl ? "tgHeaderAvatar--img" : ""} ${mode === "dms" && isSelfNotesActiveDm && profileAvatarUrl ? "tgHeaderAvatar--img" : ""} ${mode === "dms" && dmPeerAvatarUrl ? "tgHeaderAvatar--img" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (headerAvatarPhotoUrl) setPhotoLightboxUrl(headerAvatarPhotoUrl);
                  else setShowRightPanel(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (headerAvatarPhotoUrl) setPhotoLightboxUrl(headerAvatarPhotoUrl);
                    else setShowRightPanel(true);
                  }
                }}
              >
                {mode === "channels" ? (
                  activeChannel?.avatarUrl ? (
                    <img src={activeChannel.avatarUrl} alt="" className="tgHeaderAvatarImg" />
                  ) : (
                    "#"
                  )
                ) : mode === "groups" ? (
                  activeGroupChat?.avatarUrl ? (
                    <img src={activeGroupChat.avatarUrl} alt="" className="tgHeaderAvatarImg" />
                  ) : (
                    initials(activeGroupChat?.name ?? "G")
                  )
                ) : (
                  (() => {
                    if (isSelfNotesActiveDm) {
                      if (profileAvatarUrl) {
                        return <img src={profileAvatarUrl} alt="" className="tgHeaderAvatarImg" />;
                      }
                      return "⭐";
                    }
                    const otherId = activeDirectChat?.userIds.find((id) => id !== userId) ?? activeDirectChat?.userIds[0] ?? "";
                    const u = users.find((x) => x.id === otherId);
                    if (u?.avatarUrl) {
                      return <img src={String(u.avatarUrl)} alt="" className="tgHeaderAvatarImg" />;
                    }
                    return initials(displayUserNameForSidebar(u, otherId || "Л"));
                  })()
                )}
              </div>
              <div
                className="tgChatHeaderText tgChatHeaderText--clickable"
                role="button"
                tabIndex={0}
                onClick={() => setShowRightPanel(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setShowRightPanel(true);
                  }
                }}
              >
                <div className="tgChatHeaderTitleRow">
                  <div className="tgChatHeaderTitle">
                    {mode === "channels"
                      ? activeChannel
                        ? `#${activeChannel.name}`
                        : "Сообщения"
                      : mode === "groups"
                        ? activeGroupChat
                          ? activeGroupChat.name
                          : "Сообщения"
                        : activeDirectChat
                          ? isSelfNotesActiveDm
                            ? "Избранное"
                            : (() => {
                                const otherId =
                                  activeDirectChat.userIds.find((id) => id !== userId) ?? activeDirectChat.userIds[0] ?? "";
                                const u = users.find((x) => x.id === otherId);
                                return displayUserNameForSidebar(u, otherId || activeDirectChat.id);
                              })()
                          : "Сообщения"}
                  </div>
                  {(mode === "groups" && canEditActiveGroupMeta) || (mode === "channels" && canEditActiveChannelMeta) ? (
                    <button
                      type="button"
                      className="tgChatTitleEditBtn"
                      title="Изменить название и аватар"
                      onClick={(e) => {
                        e.stopPropagation();
                        setChatMetaPopoverOpen((v) => !v);
                      }}
                    >
                      ✎
                    </button>
                  ) : null}
                </div>
                <div className="tgChatHeaderSub">
                  {mode === "dms" && activeDirectChat
                    ? isSelfNotesActiveDm
                      ? "Заметки для себя"
                      : (() => {
                          const otherId =
                            activeDirectChat.userIds.find((id) => id !== userId) ?? activeDirectChat.userIds[0] ?? "";
                          const u = users.find((x) => x.id === otherId);
                          const p = otherId ? presenceByUserId[otherId] : undefined;
                          const st = p?.status ?? u?.status ?? "unknown";
                          const presence =
                            st === "online" ? "в сети" : st === "away" ? "не активен" : st === "dnd" ? "не беспокоить" : "не в сети";
                          return presence;
                        })()
                    : mode === "groups" && activeGroupChat
                      ? `Участников: ${activeGroupChat.memberIds?.length ?? 0}`
                      : mode === "channels" && activeChannel
                        ? `Канал · ${activeChannel.type}`
                        : organizationId
                          ? `Орг. ${displayOrganizationId}`
                          : "Не авторизован"}
                </div>
              </div>
            </div>
            <div className="tgChatHeaderRight" ref={callMenuWrapRef}>
              <button
                type="button"
                className="tgCircleBtn"
                title="Фокус: поиск в этом чате (Ctrl/Cmd+K — поиск в списке слева)"
                onClick={() => {
                  threadSearchInputRef.current?.focus();
                }}
              >
                🔍
              </button>
              <div className="tgCallMenuAnchor">
                <button
                  type="button"
                  className="tgCircleBtn tgCircleBtn--call"
                  title={mode === "dms" ? "Звонок в личном чате" : "Групповой созвон"}
                  disabled={
                    !canStartCalls ||
                    !socket ||
                    mode === "channels" ||
                    (mode === "groups" &&
                      (!activeGroupChat || !(activeGroupChat.memberIds ?? []).some((id) => id !== userId))) ||
                    (mode === "dms" &&
                      (!activeDirectChat ||
                        isSelfNotesActiveDm ||
                        !(activeDirectChat.userIds ?? []).some((id) => id !== userId)))
                  }
                  onClick={() => {
                    if (!canStartCalls || !socket) return;
                    if (mode === "groups" && activeGroupChat && (activeGroupChat.memberIds ?? []).some((id) => id !== userId)) {
                      setCallJoinModalKind("group");
                      return;
                    }
                    if (mode === "dms" && activeDirectChat && !isSelfNotesActiveDm) {
                      const other = activeDirectChat.userIds.find((id) => id !== userId);
                      if (other) setCallJoinModalKind("dm");
                    }
                  }}
                >
                  📞
                </button>
              </div>
              <button type="button" className="tgCircleBtn" onClick={() => setShowRightPanel((v) => !v)} title="Сведения о чате">
                ℹ️
              </button>
            </div>
          </div>
          {chatMetaPopoverOpen &&
          ((mode === "groups" && canEditActiveGroupMeta) || (mode === "channels" && canEditActiveChannelMeta)) ? (
            <div className="chatMetaQuickEdit" onMouseDown={(e) => e.stopPropagation()}>
              {chatMetaMsg ? <div className="empty" style={{ fontSize: 12 }}>{chatMetaMsg}</div> : null}
              <label className="infoPanelLabel">Название</label>
              <input
                className="infoPanelInput"
                value={chatMetaNameDraft}
                onChange={(e) => setChatMetaNameDraft(e.target.value)}
                placeholder={mode === "channels" ? "Имя канала" : "Имя группы"}
              />
              <label className="infoPanelLabel">Аватар (URL, data:image или файл)</label>
              <input
                className="infoPanelInput"
                value={chatMetaAvatarData}
                onChange={(e) => setChatMetaAvatarData(e.target.value)}
                placeholder="https://… или data:image/…"
              />
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  if (f) applyChatAvatarFromFile(f);
                  e.currentTarget.value = "";
                }}
              />
              <div className="chatMetaQuickEditActions">
                <button type="button" className="chip" onClick={() => void saveChatMeta()} disabled={!token}>
                  Сохранить
                </button>
                <button type="button" className="chip" onClick={() => setChatMetaPopoverOpen(false)}>
                  Закрыть
                </button>
              </div>
            </div>
          ) : null}
          {!threadRootId && !showPins ? (
            <div className="tgChatSearchRow" style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                ref={threadSearchInputRef}
                className="tgSearch"
                style={{ flex: 1, minWidth: 160 }}
                placeholder="Поиск в этом чате"
                value={threadSearchQ}
                onChange={(e) => setThreadSearchQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runThreadSearch();
                }}
              />
              <button type="button" className="chip" onClick={() => void runThreadSearch()} disabled={!token || !threadSearchQ.trim()}>
                Найти
              </button>
              {threadSearchOpen ? (
                <button type="button" className="chip" onClick={() => setThreadSearchOpen(false)}>
                  Скрыть
                </button>
              ) : null}
            </div>
          ) : null}
          {threadSearchOpen && threadSearchHits.length ? (
            <div
              style={{
                marginTop: 8,
                maxHeight: 160,
                overflow: "auto",
                fontSize: 12,
                borderTop: "1px solid rgba(255,255,255,0.08)",
                paddingTop: 8,
              }}
            >
              <div style={{ opacity: 0.85, marginBottom: 6 }}>Совпадений: {threadSearchHits.length}</div>
              {threadSearchHits.map((hm) => (
                <button
                  key={hm.id}
                  type="button"
                  className="threadSearchHitBtn"
                  onClick={() => scrollToMessageInChat(hm.id)}
                >
                  <span style={{ opacity: 0.75 }}>{new Date(hm.createdAt).toLocaleString()}</span> · {messageAuthorLabel(hm)} —{" "}
                  {(hm.content || "").slice(0, 120)}
                  {(hm.content || "").length > 120 ? "…" : ""}
                </button>
              ))}
            </div>
          ) : null}
          {forwardSelecting ? (
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ opacity: 0.9, fontSize: 12 }}>Выбрано: {forwardSelectedIds.size}</span>
              <button onClick={() => setShowForwardPicker(true)} disabled={!forwardSelectedIds.size}>
                Переслать →
              </button>
              <button onClick={cancelForwardSelect}>Отмена</button>
            </div>
          ) : null}
          {threadRootId ? (
            <div style={{ marginTop: 8 }}>
              <button onClick={() => void backFromThread()}>← Назад к чату</button>
            </div>
          ) : null}
          {showPins ? (
            <div style={{ marginTop: 8 }}>
              <button
                onClick={() => {
                  setShowPins(false);
                }}
              >
                ← Назад из закрепов
              </button>
            </div>
          ) : null}
        </header>

        {showForwardPicker ? (
          <section className="messages" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="empty" style={{ textAlign: "left" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <div style={{ fontWeight: 700 }}>Куда переслать?</div>
                <button onClick={() => setShowForwardPicker(false)}>Закрыть</button>
              </div>
              <div style={{ opacity: 0.8, fontSize: 12, marginTop: 6 }}>Сначала выбери сообщения (↪), потом выбери чат-получатель.</div>

              <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                <div>
                  <div style={{ opacity: 0.85, marginBottom: 6 }}>Каналы</div>
                  <div className="list">
                    {channels.map((c) => (
                      <button key={c.id} onClick={() => void forwardSelectedTo({ channelId: c.id })} disabled={!token}>
                        #{c.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ opacity: 0.85, marginBottom: 6 }}>Группы</div>
                  <div className="list">
                    {groupChats.map((g) => (
                      <button key={g.id} onClick={() => void forwardSelectedTo({ groupChatId: g.id })} disabled={!token}>
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ opacity: 0.85, marginBottom: 6 }}>Личка</div>
                  <div className="list">
                    {directChats.map((d) => {
                      const isSelfNotesDm = d.userIds.length === 1 && d.userIds[0] === userId;
                      const otherId = d.userIds.find((id) => id !== userId) ?? d.userIds[0] ?? "";
                      const u = users.find((x) => x.id === otherId);
                      const p = otherId ? presenceByUserId[otherId] : undefined;
                      const st = p?.status ?? u?.status ?? "unknown";
                      const dot = isSelfNotesDm ? "⭐" : st === "online" ? "●" : st === "away" ? "◐" : st === "dnd" ? "◍" : "○";
                      const title = isSelfNotesDm
                        ? `Избранное ${dot}`
                        : `Личка ${dot} ${displayUserNameForSidebar(u, otherId || d.id)}`;
                      return (
                        <button key={d.id} onClick={() => void forwardSelectedTo({ directChatId: d.id })} disabled={!token}>
                          {title}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {showSaved ? (
          <section className="messages" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="empty" style={{ textAlign: "left" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
                <div style={{ fontWeight: 700 }}>Сохранённые</div>
                <button onClick={() => setShowSaved(false)}>Закрыть</button>
              </div>
              <div style={{ opacity: 0.8, fontSize: 12 }}>Показаны в основной ленте ниже.</div>
            </div>
          </section>
        ) : null}

        {showCompanyCabinet ? (
          <div className="companyModalBackdrop" onClick={() => setShowCompanyCabinet(false)}>
            <section className="companyModal" onClick={(e) => e.stopPropagation()}>
              <div className="companyModalHeader">
                <div style={{ fontWeight: 700 }}>Компания</div>
                <button className="chip" onClick={() => setShowCompanyCabinet(false)}>
                  Закрыть
                </button>
              </div>
              <div className="companyModalSubhead">Сотрудники</div>
              {companyActionMsg ? <div className="empty">{companyActionMsg}</div> : null}

              <div className="companyBody">
                {isCompanyAdmin ? (
                  <>
                    <div className="companyModalSubhead" style={{ marginTop: 8 }}>
                      Добавить сотрудника
                    </div>
                    <div className="companyTableWrap">
                      <table className="companyTable">
                        <thead>
                          <tr>
                            <th>Фамилия</th>
                            <th>Имя</th>
                            <th>Отчество</th>
                            <th>Email</th>
                            <th>Телефон</th>
                            <th>Роль</th>
                            <th>Отдел</th>
                            <th>Пароль</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>
                              <input value={adminCreateLastName} onChange={(e) => setAdminCreateLastName(e.target.value)} placeholder="Фамилия" />
                            </td>
                            <td>
                              <input value={adminCreateFirstName} onChange={(e) => setAdminCreateFirstName(e.target.value)} placeholder="Имя" />
                            </td>
                            <td>
                              <input value={adminCreateMiddleName} onChange={(e) => setAdminCreateMiddleName(e.target.value)} placeholder="Отчество" />
                            </td>
                            <td>
                              <input value={adminCreateEmail} onChange={(e) => setAdminCreateEmail(e.target.value)} placeholder="Email" />
                            </td>
                            <td>
                              <input value={adminCreatePhone} onChange={(e) => setAdminCreatePhone(e.target.value)} placeholder="+7…" />
                            </td>
                            <td>
                              <select
                                value={adminCreateRole}
                                onChange={(e) => setAdminCreateRole(e.target.value as "owner" | "admin" | "manager" | "employee" | "guest")}
                                className="companyTableSelect"
                              >
                                <option value="owner">Владелец</option>
                                <option value="admin">Администратор</option>
                                <option value="manager">Менеджер</option>
                                <option value="employee">Сотрудник</option>
                                <option value="guest">Гость</option>
                              </select>
                            </td>
                            <td>
                              <input value={adminCreateDepartment} onChange={(e) => setAdminCreateDepartment(e.target.value)} placeholder="Отдел" />
                            </td>
                            <td>
                              <input
                                value={adminCreatePassword}
                                onChange={(e) => setAdminCreatePassword(e.target.value)}
                                placeholder="Временный пароль"
                                type="password"
                              />
                            </td>
                            <td>
                              <button onClick={() => void createCompanyUserSingle()} disabled={!token || !organizationId}>
                                Добавить
                              </button>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    <div className="companyModalSubhead" style={{ marginTop: 12 }}>
                      Массовый импорт из Excel/CSV
                    </div>
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void importCompanyUsersFromExcel(file);
                        e.currentTarget.value = "";
                      }}
                    />
                  </>
                ) : null}
                <div className="row">
                  <input
                    value={companyUserQuery}
                    onChange={(e) => setCompanyUserQuery(e.target.value)}
                    placeholder="Поиск сотрудника"
                  />
                  <select
                    value={companyRoleFilter}
                    onChange={(e) => setCompanyRoleFilter(e.target.value as "all" | "owner" | "admin" | "manager" | "employee" | "guest")}
                    className="companyFilterSelect"
                  >
                    <option value="all">Все роли</option>
                    <option value="owner">Владелец</option>
                    <option value="admin">Администратор</option>
                    <option value="manager">Менеджер</option>
                    <option value="employee">Сотрудник</option>
                    <option value="guest">Гость</option>
                  </select>
                  <button onClick={() => void loadUsers()} disabled={!token || !organizationId}>
                    Обновить
                  </button>
                </div>
                <div className="companyTableWrap">
                  <table className="companyTable">
                    <thead>
                      <tr>
                        <th>Фамилия</th>
                        <th>Имя</th>
                        <th>Отчество</th>
                        <th>Email</th>
                        <th>Телефон</th>
                        <th>Роль</th>
                        <th>Отдел</th>
                        <th>Статус</th>
                        <th>Действия</th>
                      </tr>
                    </thead>
                    <tbody>
                      {companyUsersFiltered.map((u) => (
                        <tr key={`cab-modal-${u.id}`}>
                          <td>{(u.lastName || "").trim() || "—"}</td>
                          <td>{(u.firstName || "").trim() || "—"}</td>
                          <td>{(u.middleName || "").trim() || "—"}</td>
                          <td className="companyTableCellMono">{u.email}</td>
                          <td>{u.phone?.trim() || "—"}</td>
                          <td>{orgRoleLabelRu(u.role)}</td>
                          <td>{u.department?.trim() || "—"}</td>
                          <td>{u.status ?? "—"}</td>
                          <td>
                            <div className="companyTableActions">
                              <select
                                value={u.role ?? "employee"}
                                onChange={(e) => void setCompanyUserRole(u.id, e.target.value as "owner" | "admin" | "manager" | "employee" | "guest")}
                                disabled={!token || !organizationId || u.id === userId}
                                className="companyTableSelect"
                                title={u.id === userId ? "Свою роль менять нельзя" : "Сменить роль"}
                              >
                                <option value="owner">Владелец</option>
                                <option value="admin">Администратор</option>
                                <option value="manager">Менеджер</option>
                                <option value="employee">Сотрудник</option>
                                <option value="guest">Гость</option>
                              </select>
                              <button
                                className="chip"
                                onClick={() => void deactivateCompanyUser(u.id)}
                                disabled={!token || u.id === userId}
                                title={u.id === userId ? "Себя деактивировать нельзя" : "Деактивировать"}
                              >
                                Удалить
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* блок «Администрирование» убран: добавление и импорт — выше */}
              </div>
            </section>
          </div>
        ) : null}

        {showUserCabinet ? (
          <div className="companyModalBackdrop userCabinetBackdrop" onClick={() => setShowUserCabinet(false)}>
            <section className="companyModal userCabinetModal" onClick={(e) => e.stopPropagation()}>
              <div className="companyModalHeader userCabinetModalHeader">
                <div className="userCabinetTitle">Личный кабинет</div>
                <button type="button" className="chip userCabinetCloseBtn" onClick={() => setShowUserCabinet(false)}>
                  Закрыть
                </button>
              </div>
              {profileMsg ? <div className="empty userCabinetMsg">{profileMsg}</div> : null}
              <div className="companyBody userCabinetBody">
                <div className="profileHeaderRow userCabinetProfileHeader">
                  <div
                    className="profileAvatarPreview userCabinetAvatar"
                    role={profileAvatarUrl ? "button" : undefined}
                    tabIndex={profileAvatarUrl ? 0 : undefined}
                    onClick={() => {
                      if (!profileAvatarUrl) return;
                      setPhotoLightboxUrl(String(profileAvatarUrl));
                    }}
                    onKeyDown={(e) => {
                      if (!profileAvatarUrl) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setPhotoLightboxUrl(String(profileAvatarUrl));
                      }
                    }}
                  >
                    {profileAvatarUrl ? <img src={profileAvatarUrl} alt="avatar" draggable={false} /> : <span>{initials(myProfileEmail || loginIdentifier)}</span>}
                  </div>
                  <div className="userCabinetIdentity">
                    <div className="userCabinetDisplayName">
                      {displayUserNameForSidebar(
                        {
                          email: myProfileEmail || loginIdentifier,
                          lastName: profileLastName || null,
                          firstName: profileFirstName || null,
                          middleName: profileMiddleName || null,
                        },
                        myProfileEmail || loginIdentifier,
                      )}
                    </div>
                    <div className="empty userCabinetSubline">
                      {myProfileEmail || loginIdentifier}
                    </div>
                    {profilePhone.trim() ? (
                      <div className="empty userCabinetSubline">
                        Тел.: {profilePhone.trim()}
                      </div>
                    ) : null}
                    <div className="empty userCabinetAccessLine">
                      Уровень доступа: <b>{viewerRole || "unknown"}</b>
                    </div>
                    <div className="empty userCabinetAccessHint">
                      {(accessByRole[viewerRole] ?? []).join(" · ")}
                    </div>
                  </div>
                </div>

                <label className="userCabinetLabel">Фамилия</label>
                <input className="userCabinetInput" value={profileLastName} onChange={(e) => setProfileLastName(e.target.value)} placeholder="Фамилия" />
                <label className="userCabinetLabel">Имя</label>
                <input className="userCabinetInput" value={profileFirstName} onChange={(e) => setProfileFirstName(e.target.value)} placeholder="Имя" />
                <label className="userCabinetLabel">Отчество</label>
                <input className="userCabinetInput" value={profileMiddleName} onChange={(e) => setProfileMiddleName(e.target.value)} placeholder="Отчество (необязательно)" />
                <label className="userCabinetLabel">Телефон</label>
                <input
                  className="userCabinetInput"
                  value={profilePhone}
                  onChange={(e) => setProfilePhone(e.target.value)}
                  placeholder="+7…"
                  inputMode="tel"
                  autoComplete="tel"
                />
                <label className="userCabinetLabel">Дата рождения</label>
                <input className="userCabinetInput" type="date" value={profileBirthDate} onChange={(e) => setProfileBirthDate(e.target.value)} />
                <label className="userCabinetLabel">Статус</label>
                <input className="userCabinetInput" value={profileStatusText} onChange={(e) => setProfileStatusText(e.target.value)} placeholder="О чем вы думаете?" />
                <label className="userCabinetLabel">Avatar URL или data:image</label>
                <input className="userCabinetInput" value={profileAvatarUrl} onChange={(e) => setProfileAvatarUrl(e.target.value)} placeholder="https://... или data:image/..." />
                <input
                  className="userCabinetFileInput"
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) applyAvatarFromFile(f);
                    e.currentTarget.value = "";
                  }}
                />
                {(profileTitle.trim() || profileDepartment.trim()) ? (
                  <div className="empty userCabinetOrgReadonly">
                    <div>
                      <strong>Должность:</strong> {profileTitle.trim() || "—"}
                    </div>
                    <div>
                      <strong>Отдел:</strong> {profileDepartment.trim() || "—"}
                    </div>
                    <div className="userCabinetOrgReadonlyHint">
                      Назначаются администратором организации (в кабинете компании).
                    </div>
                  </div>
                ) : (
                  <div className="empty userCabinetOrgReadonlyHint">
                    Должность и отдел назначает администратор компании.
                  </div>
                )}
                <div className="row userCabinetSaveRow">
                  <button type="button" className="userCabinetSaveBtn" onClick={() => void saveMyProfile()} disabled={!token || !myProfileId}>
                    Сохранить профиль
                  </button>
                </div>

                <div className="title userCabinetStickersTitle">Папки чатов</div>
                <div className="empty userCabinetStickersIntro">
                  Создайте папки и назначайте чаты через меню ⋮ у строки чата. Список папок синхронизируется с аккаунтом.
                </div>
                <button
                  type="button"
                  className="moreMenuWideBtn"
                  style={{ width: "100%", marginBottom: 14 }}
                  onClick={() => {
                    setShowUserCabinet(false);
                    setChatFoldersEditorOpen(true);
                  }}
                >
                  Управление папками
                </button>

                <div className="title userCabinetStickersTitle">Стикеры</div>
                <div className="empty userCabinetStickersIntro">
                  15 встроенных наборов ниже; можно добавить свой JSON-пак файлом и включить наборы для отправки в чате.
                </div>
                <div className="list companyList userCabinetStickerList">
                  {stickerCatalog.map((pack) => {
                    const installed = installedStickerPackIds.includes(pack.id);
                    return (
                      <div key={pack.id} className="companyRow userCabinetStickerRow">
                        <div className="userCabinetStickerRowText">
                          <div className="userCabinetStickerTitle">{pack.title}</div>
                          <div className="userCabinetStickerPreview">
                            {pack.stickers.slice(0, 6).join(" ")}
                            {pack.stickers.length > 6 ? " ..." : ""}
                          </div>
                        </div>
                        <div className="userCabinetStickerActions">
                          <button type="button" className="chip" onClick={() => downloadStickerPack(pack)}>
                            Скачать
                          </button>
                          <button type="button" className="chip" onClick={() => toggleInstallStickerPack(pack.id)}>
                            {installed ? "Отключить" : "Установить"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <input
                  className="userCabinetFileInput"
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importStickerPack(f);
                    e.currentTarget.value = "";
                  }}
                />
              </div>
            </section>
          </div>
        ) : null}

        {mode === "channels" ? (
          <section className="messages" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="empty" style={{ textAlign: "left" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={() => void loadPinnedMessages()} disabled={!token || !activeChannelId}>
                  📌 Закрепы
                </button>
              </div>
            </div>
          </section>
        ) : null}

        <section className="messages mainMessages" ref={messagesWrapRef}>
          {(pendingGroupMeshIncoming ||
            (pendingCallDeepLink && mode === "dms") ||
            (pendingGroupCallDeepLink && mode === "groups" && activeGroupChat && groupCallInviteUrlForHeader) ||
            dmCallStripVisible) ? (
            <div className="mainMessagesCallStrip">
              {pendingGroupMeshIncoming ? (
                <div className="groupMeshIncomingBar" role="status">
                  <span className="groupMeshIncomingBarText">Входящий групповой звонок</span>
                  <button
                    type="button"
                    className="chip chip--compact groupMeshIncomingJoin"
                    onClick={() => {
                      const d = pendingGroupMeshIncoming;
                      if (!d) return;
                      setPendingGroupMeshIncoming(null);
                      void joinGroupMeshFromPeerOfferRef.current(d, { mic: groupCallPreJoinMic, cam: groupCallPreJoinCam });
                    }}
                  >
                    Присоединиться к встрече
                  </button>
                  <button type="button" className="chip chip--compact" onClick={() => setPendingGroupMeshIncoming(null)}>
                    Скрыть
                  </button>
                </div>
              ) : null}
              {pendingCallDeepLink && mode === "dms" ? (
                <div className="callDeepLinkBar">
                  <span className="callDeepLinkDmHint">
                    Ссылка на личный созвон: выберите микрофон и камеру и присоединитесь.
                  </span>
                  <button type="button" className="chip chip--compact" onClick={() => setCallJoinModalKind("dm")}>
                    Настроить и позвонить
                  </button>
                  <button type="button" className="chip chip--compact" onClick={() => setPendingCallDeepLink(false)}>
                    Закрыть
                  </button>
                </div>
              ) : null}
              {dmCallStripVisible ? (
                <div className="callDeepLinkBar" role="status">
                  <span className="callDeepLinkDmHint">Собеседник в созвоне или встреча ещё активна</span>
                  <button type="button" className="chip chip--compact" onClick={() => setCallJoinModalKind("dm")}>
                    Присоединиться
                  </button>
                  <button
                    type="button"
                    className="chip chip--compact"
                    onClick={() => {
                      if (!activeDirectChat) return;
                      const m = dmMeshGroupChatId(activeDirectChat.id);
                      setGroupCallLiveAt((prev) => {
                        if (prev[m] == null) return prev;
                        const { [m]: _, ...rest } = prev;
                        return rest;
                      });
                    }}
                  >
                    Скрыть
                  </button>
                </div>
              ) : null}
              {pendingGroupCallDeepLink && mode === "groups" && activeGroupChat && groupCallInviteUrlForHeader ? (
                <div className="callDeepLinkBar">
                  <a className="callDeepLinkUrl" href={groupCallInviteUrlForHeader} title={groupCallInviteUrlForHeader}>
                    Созвон
                  </a>
                  <button
                    type="button"
                    className="chip chip--compact"
                    onClick={() => void navigator.clipboard.writeText(groupCallInviteUrlForHeader)}
                  >
                    Копировать
                  </button>
                  <label className="callDeepLinkToggle">
                    <input
                      type="checkbox"
                      checked={groupCallPreJoinMic}
                      onChange={(e) => setGroupCallPreJoinMic(e.target.checked)}
                    />{" "}
                    Мик
                  </label>
                  <label className="callDeepLinkToggle">
                    <input
                      type="checkbox"
                      checked={groupCallPreJoinCam}
                      onChange={(e) => setGroupCallPreJoinCam(e.target.checked)}
                    />{" "}
                    Камера
                  </label>
                  <button
                    type="button"
                    className="chip chip--compact"
                    onClick={() => {
                      setPendingGroupCallDeepLink(false);
                      void startGroupMesh({ video: groupCallPreJoinCam, mic: groupCallPreJoinMic });
                    }}
                  >
                    Присоединиться
                  </button>
                  <button type="button" className="chip chip--compact" onClick={() => setPendingGroupCallDeepLink(false)}>
                    Закрыть
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div ref={chatPullHintRef} className="chatPullHint" aria-hidden />
          {typingUserIds.length ? <div className="typing">Печатает: {typingUserIds.map(displayUser).join(", ")}</div> : null}
          {messages.map((m, idx) => {
            const prev = idx > 0 ? messages[idx - 1] : null;
            const sameAuthor = !!prev && prev.author?.email === m.author?.email;
            const dt = new Date(m.createdAt);
            const prevDt = prev ? new Date(prev.createdAt) : null;
            const sameMinute = !!prevDt && Math.abs(dt.getTime() - prevDt.getTime()) < 60_000;
            const showMeta = !(sameAuthor && sameMinute);

            const dayKey = dt.toDateString();
            const prevDayKey = prevDt ? prevDt.toDateString() : "";
            const showDay = idx === 0 || dayKey !== prevDayKey;

            return (
            <div
              key={m.id}
              data-message-id={m.id}
              className={`msg ${isMyMessageEmail(m.author?.email) ? "mine" : "other"} ${showMeta ? "" : "compact"} ${forwardSelecting ? "selecting" : ""} ${forwardSelectedIds.has(m.id) ? "selected" : ""}`}
            >
              {showDay ? (
                <div className="daySep">
                  <span>{dt.toLocaleDateString()}</span>
                </div>
              ) : null}
              <div className="actions">
                <button className="chip" onClick={() => void editMessageInChat(m.id)} disabled={!token || !isMyMessageEmail(m.author?.email)}>
                  ✎
                </button>
                <button className="chip" onClick={() => void deleteMessageInChat(m.id)} disabled={!token || !isMyMessageEmail(m.author?.email)}>
                  🗑
                </button>
                {forwardSelecting ? (
                  <button
                    className={`chip ${forwardSelectedIds.has(m.id) ? "on" : ""}`}
                    onClick={() => toggleForwardSelected(m.id)}
                    disabled={!token}
                    title="Выбрать для пересылки"
                  >
                    ↪✓
                  </button>
                ) : (
                  <button className="chip" onClick={() => startForwardSelect(m.id)} disabled={!token} title="Выбрать для пересылки">
                    ↪
                  </button>
                )}
                <button
                  className="chip"
                  onClick={() => setReplyTo({ id: m.id, preview: (m.content || "").slice(0, 80) || m.type || "" })}
                  disabled={!token}
                  title="Ответить"
                >
                  ↩
                </button>
                {!threadRootId ? (
                  <button className="chip" onClick={() => void openThread(m.id)} disabled={!token} title="Открыть тред">
                    🧵
                  </button>
                ) : null}
                {mode === "channels" ? (
                  <>
                    <button className="chip" onClick={() => void pinMessage(m.id)} disabled={!token} title="Закрепить">
                      📌
                    </button>
                    <button className="chip" onClick={() => void unpinMessage(m.id)} disabled={!token} title="Открепить">
                      ✖📌
                    </button>
                  </>
                ) : null}
                <button
                  className={`chip ${savedIds.has(m.id) ? "on" : ""}`}
                  onClick={() => void toggleSave(m.id, savedIds.has(m.id))}
                  disabled={!token}
                  title={savedIds.has(m.id) ? "Убрать из сохранённых" : "Сохранить"}
                >
                  ⭐
                </button>
                <button
                  type="button"
                  className="chip"
                  data-reaction-trigger
                  title="Реакция"
                  disabled={!token}
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    const popH = 56;
                    const popW = 300;
                    let top = r.bottom + 6;
                    if (top + popH > window.innerHeight - 8) top = Math.max(8, r.top - popH - 6);
                    let left = Math.min(r.left, window.innerWidth - popW - 8);
                    left = Math.max(8, left);
                    setReactionPopover((p) => (p?.messageId === m.id ? null : { messageId: m.id, top, left }));
                  }}
                >
                  😊
                </button>
              </div>
              <div
                className={`bubble ${m.type !== "file" && m.type !== "voice" && m.content && isSingleStickerContent(m.content) ? "bubble--stickerLarge" : ""}`}
                onDoubleClick={() => setReplyTo({ id: m.id, preview: (m.content || "").slice(0, 80) || m.type || "" })}
                onClick={(e) => {
                  if (forwardSelecting) {
                    toggleForwardSelected(m.id);
                    return;
                  }
                  const el = e.target as HTMLElement;
                  if (
                    el.closest(
                      "audio, video, a, button, input, textarea, select, label, .voiceMsgBlock, .chatImageWrap, .fileAttachmentRow",
                    )
                  ) {
                    return;
                  }
                  if (
                    isMyMessageEmail(m.author?.email) &&
                    m._sendState !== "failed" &&
                    m._sendState !== "sending" &&
                    !String(m.id).startsWith("tmp-")
                  ) {
                    e.stopPropagation();
                    void openReadReceipts(m.id);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const menuW = 260;
                  const menuH = 260;
                  const pad = 8;
                  const maxX = window.innerWidth - menuW - pad;
                  const maxY = window.innerHeight - menuH - pad;
                  const x = Math.max(pad, Math.min(e.clientX, maxX));
                  const y = Math.max(pad, Math.min(e.clientY, maxY));
                  setMsgMenu({ x, y, messageId: m.id });
                }}
              >
                {(mode === "groups" || mode === "channels") && showMeta && !isMyMessageEmail(m.author?.email) ? (
                  <div className="bubbleAuthor">{messageAuthorLabel(m)}</div>
                ) : null}
                {m.type === "file" || m.type === "voice" ? (
                  m.file ? (
                    m._localFileState ? (
                      <div>
                        <div className="fileLine">
                          {m.type === "voice" ? "Голосовое" : "Файл"}: {attachmentOriginalNameHint(m) ?? m.file.id}
                        </div>
                        <div className="fileState">
                          {m._localFileState === "uploading"
                            ? "Загрузка..."
                            : m._localFileState === "scanning"
                              ? "Проверяется антивирусом..."
                              : `Ошибка: ${m._localError ?? "не удалось"}`}
                        </div>
                      </div>
                    ) : m.file.downloadUrl ? (
                      m.type === "voice" ? (
                        <div className="voiceMsgBlock" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                          <div className="voiceMsgRow">
                            <ChatAttachmentAudio
                              messageKey={m.id}
                              downloadUrl={m.file.downloadUrl}
                              token={token}
                              className="voiceMsgAudio"
                            />
                            <a
                              className="fileDownloadIconBtn"
                              href={normalizeDownloadUrl(m.file.downloadUrl)}
                              download={attachmentOriginalNameHint(m) || "voice.webm"}
                              target="_blank"
                              rel="noreferrer"
                              title="Скачать"
                              aria-label="Скачать"
                              onClick={(e) => {
                                const d = m.file?.downloadUrl;
                                const h = normalizeDownloadUrl(d);
                                if (token && h && isFilesAccessProxyUrl(h)) {
                                  e.preventDefault();
                                  void triggerBrowserDownloadFromUrl(d, token, attachmentOriginalNameHint(m) || "voice.webm");
                                }
                              }}
                            >
                              ⬇
                            </a>
                          </div>
                        </div>
                      ) : looksLikeImageAttachment(attachmentOriginalNameHint(m), m.file.mimeType) ? (
                        <div className="chatImageWrap" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                          <div className="fileLineWithBadge">
                            <span className="fileFormatBadge">{fileFormatLabel(attachmentOriginalNameHint(m), m.file.mimeType)}</span>
                            <span style={{ fontSize: 12, opacity: 0.9 }}>Изображение</span>
                          </div>
                          <a
                            href={normalizeDownloadUrl(m.file.downloadUrl)}
                            target="_blank"
                            rel="noreferrer"
                            className="chatImageLink"
                            onClick={(e) => {
                              const d = m.file?.downloadUrl;
                              const h = normalizeDownloadUrl(d);
                              if (token && h && isFilesAccessProxyUrl(h)) {
                                e.preventDefault();
                                void openMediaInNewTabFromUrl(d, token);
                              }
                            }}
                          >
                            <ChatAttachmentImage
                              downloadUrl={m.file.downloadUrl}
                              token={token}
                              alt={attachmentOriginalNameHint(m) ?? "image"}
                              className="chatImage"
                              fileId={m.file.id}
                              onNeedsUrlRefresh={(fid) => void hydrateDownloadUrl(fid)}
                            />
                          </a>
                        </div>
                      ) : (
                        <div
                          className="fileAttachmentRow"
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                          <span className="fileFormatBadge" title={m.file.mimeType}>
                            {fileFormatLabel(attachmentOriginalNameHint(m), m.file.mimeType)}
                          </span>
                          <span className="fileAttachmentName">{attachmentOriginalNameHint(m) ?? m.file.id}</span>
                          <a
                            className="fileDownloadIconBtn"
                            href={normalizeDownloadUrl(m.file.downloadUrl)}
                            download={attachmentOriginalNameHint(m) || undefined}
                            target="_blank"
                            rel="noreferrer"
                            title="Скачать"
                            aria-label="Скачать"
                            onClick={(e) => {
                              const d = m.file?.downloadUrl;
                              const h = normalizeDownloadUrl(d);
                              if (token && h && isFilesAccessProxyUrl(h)) {
                                e.preventDefault();
                                void triggerBrowserDownloadFromUrl(d, token, attachmentOriginalNameHint(m) || "file");
                              }
                            }}
                          >
                            ⬇
                          </a>
                        </div>
                      )
                    ) : (
                      m.type === "voice" ? (
                        <div>
                          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>
                            Голосовое: {attachmentOriginalNameHint(m) ?? m.file.id}
                          </div>
                          <div className="fileState">{fileWaitLine("voice", m.file.avStatus, m.file.blockedReason)}</div>
                        </div>
                      ) : (
                        <div>
                          <div className="fileLineWithBadge">
                            <span className="fileFormatBadge">{fileFormatLabel(attachmentOriginalNameHint(m), m.file.mimeType)}</span>
                            <span>
                              {looksLikeImageAttachment(attachmentOriginalNameHint(m), m.file.mimeType) ? "Изображение" : "Файл"}:{" "}
                              {attachmentOriginalNameHint(m) ?? m.file.id}
                            </span>
                          </div>
                          <div className="fileState">{fileWaitLine("file", m.file.avStatus, m.file.blockedReason)}</div>
                        </div>
                      )
                    )
                  ) : (
                    "(файл)"
                  )
                ) : (
                  (() => {
                    const inv = parseCallInviteFromContent(m.content);
                    if (!inv) return m.content ? m.content : "(удалено)";
                    const href = String(m.content ?? "").trim();
                    const gid =
                      inv.type === "group" ? inv.groupId : dmMeshGroupChatId(inv.directChatId);
                    const inThisCall = groupMeshUi?.groupChatId === gid;
                    const live =
                      (groupCallLiveAt[gid] != null && Date.now() - groupCallLiveAt[gid] < GROUP_CALL_INVITE_LIVE_MS) ||
                      inThisCall;
                    const inThisChat =
                      inv.type === "group"
                        ? mode === "groups" && activeGroupChat?.id === inv.groupId
                        : mode === "dms" && activeDirectChat?.id === inv.directChatId;
                    const showJoin = inThisChat && live && !inThisCall && canStartCalls;
                    return (
                      <div className="callInviteCard" onClick={(e) => e.stopPropagation()}>
                        <a className="tgCallInviteLink" href={href} onClick={(e) => e.stopPropagation()}>
                          Созвон
                        </a>
                        {showJoin ? (
                          <button
                            type="button"
                            className="chip chip--compact callInviteCardJoinBtn"
                            disabled={!socket}
                            onClick={(e) => {
                              e.stopPropagation();
                              setInviteCardJoinModal({ groupChatId: gid });
                            }}
                          >
                            Присоединиться
                          </button>
                        ) : null}
                        {inThisCall && inThisChat ? <span className="callInviteCardBadge">В созвоне</span> : null}
                      </div>
                    );
                  })()
                )}
                <span className="bubbleTime">
                  {isMyMessageEmail(m.author?.email) ? (
                    m._sendState === "failed" ? (
                      <span className="msgSendFail" title="Не удалось отправить">
                        !
                      </span>
                    ) : m._sendState === "sending" ? (
                      <span className="msgTick msgTick--pending" title="Отправка">
                        …
                      </span>
                    ) : messageReadByOthers(m, selfAuthorEmail || myProfileEmail, userId, peerReadMapForCurrentChat()) ? (
                      <span className="msgTick msgTick--read" title="Прочитано">
                        ✓✓
                      </span>
                    ) : (
                      <span className="msgTick" title="Доставлено">
                        ✓
                      </span>
                    )
                  ) : null}{" "}
                  {m.editedAt ? "(ред.) " : ""}
                  {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              {msgMenu?.messageId === m.id ? (
                <div className="msgMenu" style={{ top: msgMenu.y, left: msgMenu.x }} role="menu">
                  <button className="msgMenuItem" onClick={() => setReplyTo({ id: m.id, preview: (m.content || "").slice(0, 80) || m.type || "" })}>
                    Ответить
                  </button>
                  <button className="msgMenuItem" onClick={() => startForwardSelect(m.id)}>
                    Переслать
                  </button>
                  <button className="msgMenuItem" onClick={() => void toggleSave(m.id, savedIds.has(m.id))}>
                    {savedIds.has(m.id) ? "Убрать из сохранённых" : "Сохранить"}
                  </button>
                  <div className="msgMenuSep" />
                  <button className="msgMenuItem" onClick={() => void editMessageInChat(m.id)} disabled={!isMyMessageEmail(m.author?.email)}>
                    Редактировать
                  </button>
                  <button className="msgMenuItem danger" onClick={() => void deleteMessageInChat(m.id)} disabled={!isMyMessageEmail(m.author?.email)}>
                    Удалить
                  </button>
                </div>
              ) : null}
              <div className="reactions">
                {(m.reactions ?? []).map((r) => (
                  <button
                    key={`${m.id}-${r.emoji}`}
                    onClick={() => void toggleReaction(m.id, r.emoji)}
                    className={`chip ${r.viewerHasReacted ? "on" : ""}`}
                  >
                    {r.emoji} {r.count}
                  </button>
                ))}
              </div>
            </div>
          );})}
          <div ref={messagesEndRef} />
          {messages.length === 0 ? <div className="empty">Сообщений пока нет</div> : null}
          {showScrollToBottom ? (
            <button
              type="button"
              className="scrollDownBtn"
              onClick={() => {
                stickToBottomRef.current = true;
                messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
              }}
              title="К последнему сообщению"
            >
              ↓
            </button>
          ) : null}
        </section>

        {reactionPopover ? (
          <div
            ref={reactionPopoverRef}
            className="msgReactionPopover"
            style={{ top: reactionPopover.top, left: reactionPopover.left }}
            role="dialog"
            aria-label="Реакции"
          >
            {quickEmojis.map((em) => (
              <button
                key={em}
                type="button"
                className="msgReactionEmojiBtn"
                onClick={() => {
                  void toggleReaction(reactionPopover.messageId, em);
                  setReactionPopover(null);
                }}
              >
                {em}
              </button>
            ))}
          </div>
        ) : null}

        <form onSubmit={(e) => void sendMessage(e)} className="composer">
          {isRecordingVoice ? (
            <div className="voiceHoldBar" style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="dot" />
              <span>
                Идет запись: {Math.floor(voiceHoldMs / 60000)
                  .toString()
                  .padStart(2, "0")}
                :
                {Math.floor((voiceHoldMs % 60000) / 1000)
                  .toString()
                  .padStart(2, "0")}{" "}
                (нажмите 🎤 снова, «Готово» или Esc)
              </span>
              <button type="button" className="chip" onClick={() => stopVoiceRecord()}>
                Готово
              </button>
            </div>
          ) : null}
          {chatError ? (
            <div style={{ gridColumn: "1 / -1", color: "#ff9ea6", fontSize: 12 }}>
              Ошибка: {chatError}
            </div>
          ) : null}
          {replyTo ? (
            <div style={{ gridColumn: "1 / -1", fontSize: 12, opacity: 0.8 }}>
              Ответ на: {replyTo.preview}{" "}
              <button type="button" className="chip" onClick={() => setReplyTo(null)} style={{ marginLeft: 8 }}>
                отмена
              </button>
            </div>
          ) : null}
          <button type="button" onClick={() => void pickFile()} disabled={uploadDisabled}>
            📎
          </button>
          <button
            type="button"
            style={{ touchAction: "manipulation" }}
            onClick={onVoiceMicClick}
            disabled={uploadDisabled}
            title={isRecordingVoice ? "Нажмите ещё раз, чтобы отправить" : "Нажмите для записи голосового"}
          >
            🎤
          </button>
          <button
            type="button"
            onClick={() => setShowStickerPicker((v) => !v)}
            disabled={composerDisabled}
            title="Стикеры"
          >
            🙂
          </button>
          <textarea
            className="composerInput"
            placeholder="Сообщение"
            value={newMessage}
            ref={composerRef}
            onChange={(e) => onComposerChanged(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void sendMessage();
              }
            }}
            disabled={composerDisabled}
            rows={1}
          />
          <button type="submit" disabled={composerDisabled || !canSendText} title="Отправить">
            ✈️
          </button>
          {showStickerPicker ? (
            <div className="stickerPicker" style={{ gridColumn: "1 / -1" }}>
              <div className="row" style={{ marginTop: 0 }}>
                {stickerCatalog
                  .filter((p) => installedStickerPackIds.includes(p.id))
                  .map((p) => (
                    <button
                      key={p.id}
                      className={`chip ${activeStickerPackId === p.id ? "on" : ""}`}
                      type="button"
                      onClick={() => setActiveStickerPackId(p.id)}
                    >
                      {p.title}
                    </button>
                  ))}
              </div>
              <div className="stickerGrid">
                {(stickerCatalog.find((p) => p.id === activeStickerPackId)?.stickers ?? []).map((s, idx) => (
                  <button
                    type="button"
                    key={`${activeStickerPackId}-${idx}-${s}`}
                    className="stickerBtn"
                    onClick={() => void sendMessage(undefined, s)}
                    title="Отправить стикер"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </form>
        <div
          style={{ fontSize: 10, opacity: 0.42, padding: "2px 10px 6px", gridColumn: "1 / -1" }}
          title="Время и git обновляются только после «npm run build» в каталоге web на сервере. Ctrl+Shift+R сбрасывает кеш браузера, но не пересобирает файлы."
        >
          Сборка: {__BUILD_TIME__} · git {__GIT_SHA__} · кэш: Ctrl+Shift+R
        </div>

        {webrtcUi ? (
          <div className="webrtcOverlay webrtcOverlay--meeting" role="dialog" aria-label="Звонок">
            <div className="webrtcPanel webrtcPanel--fullscreen webrtcPanel--meeting">
              <div className="webrtcStage">
                {webrtcUi.audioOnly ? (
                  <audio
                    ref={webrtcRemoteAudioRef}
                    autoPlay
                    playsInline
                    className="webrtcRemote webrtcRemote--audioOnly"
                  />
                ) : (
                  <>
                    <video
                      key={
                        webrtcUi.remoteStream
                          ? `${webrtcUi.callPeerId}-${webrtcUi.remoteStream.id}-${webrtcUi.remoteStream
                              .getTracks()
                              .map((t) => `${t.id}:${t.muted ? "m" : "u"}`)
                              .join("|")}`
                          : `${webrtcUi.callPeerId}-nor`
                      }
                      ref={webrtcRemoteVideoRef}
                      autoPlay
                      playsInline
                      className="webrtcRemote"
                    />
                    <audio
                      ref={webrtcRemoteAudioRef}
                      autoPlay
                      playsInline
                      className="webrtcRemote webrtcRemote--videoCallAudio"
                    />
                  </>
                )}
                {!webrtcUi.audioOnly ? (
                  <div className="webrtcLocalPip">
                    <video
                      ref={webrtcLocalVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className="webrtcLocal"
                    />
                  </div>
                ) : null}
              </div>
              <div className="webrtcChrome">
                <div className="webrtcHint webrtcHint--compact">
                  Собеседник видит ваше видео (или слышит только звук в аудиозвонке). Экран — демонстрация, как в Телемосте: выберите окно или весь экран в запросе браузера.
                </div>
                {webrtcPeerHandRaised ? (
                  <div className="webrtcHandBanner webrtcHandBanner--compact" role="status">
                    Собеседник поднял руку ✋
                  </div>
                ) : null}
              <div className="webrtcToolbar">
                <button
                  type="button"
                  className="webrtcToolBtn"
                  onClick={() => {
                    setWebrtcDiagOpen(true);
                    void snapshotWebrtcStats();
                  }}
                  title="Показать диагностику WebRTC"
                >
                  🧪 Диагн.
                </button>
                <button type="button" className={`webrtcToolBtn ${webrtcMicOn ? "webrtcToolBtn--on" : "webrtcToolBtn--off"}`} onClick={toggleWebrtcMic} title="Микрофон">
                  {webrtcMicOn ? "🎤 Мик" : "🎤 Выкл"}
                </button>
                {!webrtcUi.audioOnly ? (
                  <>
                    <button
                      type="button"
                      className={`webrtcToolBtn ${webrtcCamOn ? "webrtcToolBtn--on" : "webrtcToolBtn--off"}`}
                      onClick={toggleWebrtcCam}
                      title="Камера"
                    >
                      {webrtcCamOn ? "📷 Кам" : "📷 Выкл"}
                    </button>
                    <button
                      type="button"
                      className={`webrtcToolBtn ${webrtcScreenSharing ? "webrtcToolBtn--accent" : ""}`}
                      onClick={() => void toggleWebrtcScreenShare()}
                      title="Демонстрация экрана: в диалоге браузера можно выбрать окно, вкладку или весь экран"
                    >
                      {webrtcScreenSharing ? "🖥 Стоп" : "🖥 Экран"}
                    </button>
                  </>
                ) : null}
                <button type="button" className="webrtcToolBtn" onClick={copyCallInviteLink} title="Скопировать ссылку на этот личный чат для созвона">
                  🔗 Ссылка
                </button>
                <button
                  type="button"
                  className={`webrtcToolBtn ${webrtcLocalHandRaised ? "webrtcToolBtn--accent" : ""}`}
                  onClick={toggleLocalRaiseHand}
                  title="Поднять руку"
                >
                  ✋ {webrtcLocalHandRaised ? "Опустить" : "Рука"}
                </button>
                <button type="button" className="webrtcToolBtn webrtcToolBtn--danger" onClick={() => webrtcUi.hangup()}>
                  Завершить
                </button>
              </div>
              </div>
            </div>
          </div>
        ) : null}
        {webrtcDiagOpen ? (
          <div className="modalBackdrop" role="presentation" onClick={() => setWebrtcDiagOpen(false)}>
            <div className="modalPanel" role="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 780, width: "min(780px, 95vw)" }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Диагностика WebRTC</div>
              <div className="empty" style={{ marginBottom: 8 }}>
                Нажмите «Снимок» чтобы добавить getStats. Логи обновляются при смене состояний соединения.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                <button type="button" className="chip" onClick={() => void snapshotWebrtcStats()}>
                  Снимок (getStats)
                </button>
                <button type="button" className="chip" onClick={dumpIceServersConfig}>
                  Показать TURN/ICE
                </button>
                <button type="button" className="chip" onClick={() => void runMediaSelfTest()}>
                  Проверить камеру/мик
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => void navigator.clipboard.writeText(webrtcDiagLines.slice().reverse().join("\n"))}
                  disabled={webrtcDiagLines.length === 0}
                >
                  Копировать
                </button>
                <button type="button" className="chip" onClick={() => setWebrtcDiagLines([])}>
                  Очистить
                </button>
                <button type="button" className="chip" onClick={() => setWebrtcDiagOpen(false)}>
                  Закрыть
                </button>
              </div>
              <pre style={{ margin: 0, maxHeight: "55vh", overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap" }}>
                {(webrtcDiagLines.length ? webrtcDiagLines.slice().reverse() : ["(пока пусто)"]).join("\n")}
              </pre>
            </div>
          </div>
        ) : null}
        {incomingCall ? (
          <div className="webrtcOverlay webrtcOverlay--incoming" role="dialog" aria-label="Входящий звонок">
            <div className="webrtcPanel webrtcIncomingCard">
              <div className="webrtcIncomingTitle">
                Входящий {incomingCall.audioOnly ? "звонок" : "видеозвонок"}
              </div>
              <div className="webrtcIncomingActions">
                <button type="button" className="chip webrtcIncomingBtn webrtcIncomingBtn--accept" onClick={() => void acceptIncomingCall()}>
                  Принять
                </button>
                <button type="button" className="chip webrtcIncomingBtn webrtcIncomingBtn--decline" onClick={declineIncomingCall}>
                  Отклонить
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {readReceiptModalForId ? (
          <div className="modalBackdrop" role="presentation" onClick={() => setReadReceiptModalForId(null)}>
            <div className="modalPanel" role="dialog" onClick={(e) => e.stopPropagation()}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Прочитали сообщение</div>
              {readReceiptUsers.length === 0 ? (
                <div className="empty">Пока никто не открыл чат после этого сообщения</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {readReceiptUsers.map((u) => (
                    <li key={u.id} style={{ marginBottom: 4 }}>
                      {readerDisplayName(u)}
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="chip" style={{ marginTop: 10 }} onClick={() => setReadReceiptModalForId(null)}>
                Закрыть
              </button>
            </div>
          </div>
        ) : null}
        {callJoinModalKind ? (
          <div className="modalBackdrop" role="presentation" onClick={() => setCallJoinModalKind(null)}>
            <div
              className="modalPanel groupCallJoinModal"
              role="dialog"
              aria-labelledby="groupCallJoinTitle"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="groupCallJoinModalVisual" aria-hidden>
                📹
              </div>
              <h2 id="groupCallJoinTitle" className="groupCallJoinModalTitle">
                {callJoinModalKind === "dm" ? "Личный звонок" : "Подключение к встрече"}
              </h2>
              <p className="groupCallJoinModalHint">Включите или выключите камеру и микрофон до входа</p>
              <div className="groupCallJoinToggles">
                <button
                  type="button"
                  className={`groupCallJoinToggle ${groupCallPreJoinCam ? "groupCallJoinToggle--on" : "groupCallJoinToggle--off"}`}
                  onClick={() => setGroupCallPreJoinCam((v) => !v)}
                >
                  {groupCallPreJoinCam ? "📷 Видео включено" : "📷 Видео выключено"}
                </button>
                <button
                  type="button"
                  className={`groupCallJoinToggle ${groupCallPreJoinMic ? "groupCallJoinToggle--on" : "groupCallJoinToggle--off"}`}
                  onClick={() => setGroupCallPreJoinMic((v) => !v)}
                >
                  {groupCallPreJoinMic ? "🎤 Микрофон включён" : "🎤 Микрофон выключен"}
                </button>
              </div>
              {callJoinModalKind === "group" ? (
                <p className="groupCallJoinModalMeta">Одновременно до {GROUP_MESH_MAX_PEERS} участников (не считая вас)</p>
              ) : (
                <p className="groupCallJoinModalMeta" style={{ opacity: 0.65 }}>
                  Собеседник получит входящий звонок
                </p>
              )}
              <div className="groupCallJoinActions">
                <button type="button" className="chip" onClick={() => setCallJoinModalKind(null)}>
                  Отмена
                </button>
                <button
                  type="button"
                  className="chip groupCallJoinPrimary"
                  onClick={() => {
                    const kind = callJoinModalKind;
                    setCallJoinModalKind(null);
                    if (kind === "group") void startGroupMesh({ video: groupCallPreJoinCam, mic: groupCallPreJoinMic });
                    if (kind === "dm") void startDmCall({ video: groupCallPreJoinCam, mic: groupCallPreJoinMic });
                  }}
                >
                  {callJoinModalKind === "dm" ? "Позвонить" : "Присоединиться к встрече"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {inviteCardJoinModal ? (
          <div className="modalBackdrop" role="presentation" onClick={() => setInviteCardJoinModal(null)}>
            <div
              className="modalPanel groupCallJoinModal"
              role="dialog"
              aria-labelledby="inviteCardJoinTitle"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="groupCallJoinModalVisual" aria-hidden>
                📹
              </div>
              <h2 id="inviteCardJoinTitle" className="groupCallJoinModalTitle">
                Подключение к встрече
              </h2>
              <p className="groupCallJoinModalHint">Выберите камеру и микрофон перед входом</p>
              <div className="groupCallJoinToggles">
                <button
                  type="button"
                  className={`groupCallJoinToggle ${groupCallPreJoinCam ? "groupCallJoinToggle--on" : "groupCallJoinToggle--off"}`}
                  onClick={() => setGroupCallPreJoinCam((v) => !v)}
                >
                  {groupCallPreJoinCam ? "📷 Видео включено" : "📷 Видео выключено"}
                </button>
                <button
                  type="button"
                  className={`groupCallJoinToggle ${groupCallPreJoinMic ? "groupCallJoinToggle--on" : "groupCallJoinToggle--off"}`}
                  onClick={() => setGroupCallPreJoinMic((v) => !v)}
                >
                  {groupCallPreJoinMic ? "🎤 Микрофон включён" : "🎤 Микрофон выключен"}
                </button>
              </div>
              <p className="groupCallJoinModalMeta">
                {inviteCardJoinModal.groupChatId.startsWith(DM_MESH_PREFIX)
                  ? "Личный видеозвонок (тот же mesh, что и в группе)"
                  : `Одновременно до ${GROUP_MESH_MAX_PEERS} участников (не считая вас)`}
              </p>
              <div className="groupCallJoinActions">
                <button type="button" className="chip" onClick={() => setInviteCardJoinModal(null)}>
                  Отмена
                </button>
                <button
                  type="button"
                  className="chip groupCallJoinPrimary"
                  onClick={() => {
                    const gid = inviteCardJoinModal.groupChatId;
                    setInviteCardJoinModal(null);
                    const offerSnap = pendingGroupMeshIncomingRef.current;
                    const prefs = { video: groupCallPreJoinCam, mic: groupCallPreJoinMic };
                    if (offerSnap && String(offerSnap.groupChatId ?? "") === gid) {
                      setPendingGroupMeshIncoming(null);
                      void joinGroupMeshFromPeerOffer(offerSnap, {
                        mic: groupCallPreJoinMic,
                        cam: groupCallPreJoinCam,
                      });
                      return;
                    }
                    if (gid.startsWith(DM_MESH_PREFIX)) {
                      const dcid = gid.slice(DM_MESH_PREFIX.length);
                      if (activeDirectChat?.id !== dcid) {
                        setChatError("Откройте этот личный чат и нажмите снова");
                        return;
                      }
                      void startDmCall(prefs);
                      return;
                    }
                    if (activeGroupChat?.id !== gid) {
                      setChatError("Откройте этот групповой чат и нажмите снова");
                      return;
                    }
                    void startGroupMesh(prefs);
                  }}
                >
                  Готово
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {photoLightboxUrl ? (
          <div
            className="photoLightbox"
            role="dialog"
            aria-modal="true"
            aria-label="Просмотр фото"
            onClick={() => setPhotoLightboxUrl(null)}
          >
            <button
              type="button"
              className="photoLightboxClose"
              aria-label="Закрыть"
              onClick={(e) => {
                e.stopPropagation();
                setPhotoLightboxUrl(null);
              }}
            >
              ✕
            </button>
            <img
              src={photoLightboxUrl}
              alt=""
              className="photoLightboxImg"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        ) : null}
      </main>

      {/* Рингтон для входящего звонка (воспроизводится при incomingCall) */}
      <audio
        ref={ringtoneRef}
        preload="auto"
        src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA="
      />

      {showRightPanel ? (
        <div className={viewportW >= 1200 ? "infoPanelHost infoPanelHost--desktop" : "infoPanelHost infoPanelHost--overlay"}>
          {viewportW < 1200 ? (
            <button type="button" className="infoPanelBackdrop" aria-label="Закрыть панель" onClick={() => setShowRightPanel(false)} />
          ) : null}
          <aside className="infoPanel">
            <div className="infoPanelHeader">
              <span>Сведения о чате</span>
              <button type="button" className="tgCircleBtn" aria-label="Закрыть" onClick={() => setShowRightPanel(false)}>
                ✕
              </button>
            </div>
            <div className="infoPanelBody">
              <div
                className={`infoPanelHeroAvatar ${mode === "channels" && activeChannel?.avatarUrl ? "infoPanelHeroAvatar--img" : ""} ${mode === "groups" && activeGroupChat?.avatarUrl ? "infoPanelHeroAvatar--img" : ""} ${mode === "dms" && isSelfNotesActiveDm && profileAvatarUrl ? "infoPanelHeroAvatar--img" : ""} ${mode === "dms" && dmPeerAvatarUrl ? "infoPanelHeroAvatar--img" : ""}`}
                role="presentation"
                onClick={() => {
                  if (mode === "channels" && activeChannel?.avatarUrl) setPhotoLightboxUrl(String(activeChannel.avatarUrl));
                  else if (mode === "groups" && activeGroupChat?.avatarUrl) setPhotoLightboxUrl(String(activeGroupChat.avatarUrl));
                  else if (mode === "dms" && isSelfNotesActiveDm && profileAvatarUrl) setPhotoLightboxUrl(String(profileAvatarUrl));
                  else if (mode === "dms" && dmPeerAvatarUrl) setPhotoLightboxUrl(dmPeerAvatarUrl);
                }}
                style={{
                  cursor:
                    (mode === "channels" && activeChannel?.avatarUrl) ||
                    (mode === "groups" && activeGroupChat?.avatarUrl) ||
                    (mode === "dms" && isSelfNotesActiveDm && profileAvatarUrl) ||
                    (mode === "dms" && dmPeerAvatarUrl)
                      ? "zoom-in"
                      : undefined,
                }}
              >
                {mode === "channels" ? (
                  activeChannel?.avatarUrl ? (
                    <img src={activeChannel.avatarUrl} alt="" className="infoPanelHeroAvatarImg" />
                  ) : (
                    "#"
                  )
                ) : mode === "groups" ? (
                  activeGroupChat?.avatarUrl ? (
                    <img src={activeGroupChat.avatarUrl} alt="" className="infoPanelHeroAvatarImg" />
                  ) : (
                    initials(activeGroupChat?.name ?? "G")
                  )
                ) : isSelfNotesActiveDm ? (
                  profileAvatarUrl ? (
                    <img src={profileAvatarUrl} alt="" className="infoPanelHeroAvatarImg" />
                  ) : (
                    "⭐"
                  )
                ) : (
                  (() => {
                    const otherId = activeDirectChat?.userIds.find((id) => id !== userId) ?? activeDirectChat?.userIds[0] ?? "";
                    const u = users.find((x) => x.id === otherId);
                    if (dmPeerAvatarUrl) {
                      return <img src={dmPeerAvatarUrl} alt="" className="infoPanelHeroAvatarImg" />;
                    }
                    return initials(displayUserNameForSidebar(u, otherId || "Л"));
                  })()
                )}
              </div>
              <div className="infoPanelHeroTitle">
                {mode === "channels"
                  ? activeChannel
                    ? `#${activeChannel.name}`
                    : "Сообщения"
                  : mode === "groups"
                    ? activeGroupChat
                      ? activeGroupChat.name
                      : "Сообщения"
                    : activeDirectChat
                      ? isSelfNotesActiveDm
                        ? "Избранное"
                        : (() => {
                            const otherId =
                              activeDirectChat.userIds.find((id) => id !== userId) ?? activeDirectChat.userIds[0] ?? "";
                            const u = users.find((x) => x.id === otherId);
                            return displayUserNameForSidebar(u, otherId || activeDirectChat.id);
                          })()
                      : "Сообщения"}
              </div>
              <p className="infoPanelHeroSub">
                {organizationId ? `Организация: ${displayOrganizationId}` : "—"}
                {orgBrandDisplay ? ` · ${orgBrandDisplay}` : ""} · {myProfileEmail || loginIdentifier}
                {systemAccessLevel ? (
                  <>
                    {" "}
                    · доступ: {systemAccessLevel === "platform" ? "платформа" : systemAccessLevel === "basic" ? "базовый" : "организация"}
                  </>
                ) : null}
              </p>

              <div className="infoPanelTabs" role="tablist" aria-label="Разделы сведений о чате">
                {(
                  mode === "dms"
                    ? ([
                        ["photos", "Фото"],
                        ["files", "Файлы"],
                        ["voice", "Голосовые"],
                        ["links", "Ссылки"],
                        ["notify", "Уведомления"],
                      ] as const)
                    : ([
                        ["about", "Об чате"],
                        ["photos", "Фото"],
                        ["files", "Файлы"],
                        ["voice", "Голосовые"],
                        ["links", "Ссылки"],
                        ["notify", "Уведомления"],
                      ] as const)
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    className={`infoPanelTab ${infoPanelSection === id ? "infoPanelTab--active" : ""}`}
                    aria-selected={infoPanelSection === id}
                    onClick={() => setInfoPanelSection(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {infoPanelSection === "about" ? (
                <>
                  {mode === "groups" && activeGroupChat ? (
                    <div className="infoPanelSection">
                      <div className="infoPanelSectionTitle">Участники ({activeGroupChat.memberIds.length})</div>
                      <ul className="infoPanelMemberList">
                        {activeGroupChat.memberIds.map((mid) => {
                          const u = users.find((x) => x.id === mid);
                          return (
                            <li key={mid}>
                              {displayUserNameForSidebar(u, mid)}
                              <span className="infoPanelMemberEmail">{u?.email ?? mid}</span>
                            </li>
                          );
                        })}
                      </ul>
                      {canEditActiveGroupMeta ? (
                        <>
                          <div className="infoPanelSectionTitle" style={{ marginTop: 12 }}>
                            Добавить участников
                          </div>
                          {infoPanelMembersMsg ? (
                            <div className="empty" style={{ marginBottom: 8 }}>
                              {infoPanelMembersMsg}
                            </div>
                          ) : null}
                          <p className="infoPanelHint">Выберите сотрудника организации, которого ещё нет в группе.</p>
                          <div className="infoPanelAddMemberRow">
                            <select
                              className="infoPanelSelect"
                              value={infoPanelGroupPickUserId}
                              onChange={(e) => {
                                setInfoPanelGroupPickUserId(e.target.value);
                                setInfoPanelMembersMsg("");
                              }}
                            >
                              <option value="">— Кого добавить —</option>
                              {users
                                .filter((u) => !activeGroupChat.memberIds.includes(u.id))
                                .map((u) => (
                                  <option key={u.id} value={u.id}>
                                    {displayUserNameForSidebar(u, u.id)}
                                  </option>
                                ))}
                            </select>
                            <button
                              type="button"
                              className="chip"
                              disabled={!infoPanelGroupPickUserId || !token}
                              onClick={() => void addMembersToActiveGroup([infoPanelGroupPickUserId])}
                            >
                              Добавить
                            </button>
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}

                  {mode === "channels" && activeChannelId ? (
                    <div className="infoPanelSection">
                      <div className="infoPanelSectionTitle">
                        Участники канала
                        {activeChannel?.type === "public" || activeChannel?.type === "broadcast"
                          ? " (все в workspace)"
                          : null}
                      </div>
                      {activeChannel?.type === "private" ? (
                        <>
                          <ul className="infoPanelMemberList">
                            {infoPanelChannelMembers.map((u) => (
                              <li key={u.id}>
                                {displayUserNameForSidebar(u, u.id)}
                                <span className="infoPanelMemberEmail">{u.email}</span>
                              </li>
                            ))}
                          </ul>
                          <div className="infoPanelSectionTitle" style={{ marginTop: 12 }}>
                            Добавить участника
                          </div>
                          {infoPanelMembersMsg ? (
                            <div className="empty" style={{ marginBottom: 8 }}>
                              {infoPanelMembersMsg}
                            </div>
                          ) : null}
                          <p className="infoPanelHint">
                            Доступно для закрытого канала. Нужна роль администратора в workspace (участник должен быть в
                            workspace).
                          </p>
                          <div className="infoPanelAddMemberRow">
                            <select
                              className="infoPanelSelect"
                              value={infoPanelChannelPickUserId}
                              onChange={(e) => {
                                setInfoPanelChannelPickUserId(e.target.value);
                                setInfoPanelMembersMsg("");
                              }}
                            >
                              <option value="">— Кого добавить —</option>
                              {users
                                .filter((u) => !infoPanelChannelMembers.some((m) => m.id === u.id))
                                .map((u) => (
                                  <option key={u.id} value={u.id}>
                                    {displayUserNameForSidebar(u, u.id)}
                                  </option>
                                ))}
                            </select>
                            <button
                              type="button"
                              className="chip"
                              disabled={!infoPanelChannelPickUserId || !token}
                              onClick={() => void addUserToActiveChannel(infoPanelChannelPickUserId)}
                            >
                              Добавить
                            </button>
                          </div>
                        </>
                      ) : (
                        <p className="infoPanelHint">
                          Публичный и broadcast-канал виден участникам workspace; список подписчиков не хранится отдельно. Для
                          приватного канала здесь же можно добавлять участников (права админа workspace).
                        </p>
                      )}
                    </div>
                  ) : null}

                  {mode === "channels" && activeChannelId ? (
                    <div className="infoPanelSection">
                      <div className="infoPanelSectionTitle">Закрепы</div>
                      <button
                        type="button"
                        className="moreMenuWideBtn subtle"
                        onClick={() => {
                          void loadPinnedMessages();
                          setShowRightPanel(false);
                        }}
                        disabled={!token}
                      >
                        Открыть закреплённые сообщения
                      </button>
                    </div>
                  ) : null}
                </>
              ) : infoPanelSection === "photos" ? (
                <div className="infoPanelSection">
                  <div className="infoPanelSectionTitle">Фотографии ({infoPanelPhotos.length})</div>
                  {infoPanelPhotos.length === 0 ? (
                    <p className="infoPanelHint">В этом чате пока нет вложенных изображений.</p>
                  ) : (
                    <div className="infoPanelPhotoGrid">
                      {infoPanelPhotos.map((m) => (
                        <a
                          key={m.id}
                          href={normalizeDownloadUrl(m.file?.downloadUrl)}
                          target="_blank"
                          rel="noreferrer"
                          className="infoPanelPhotoCell"
                          onClick={(e) => {
                            const h = normalizeDownloadUrl(m.file?.downloadUrl);
                            if (token && h && isFilesAccessProxyUrl(h)) {
                              e.preventDefault();
                              void openMediaInNewTabFromUrl(m.file?.downloadUrl, token);
                            }
                          }}
                        >
                          <ChatAttachmentImage downloadUrl={m.file?.downloadUrl} token={token} alt="" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ) : infoPanelSection === "files" ? (
                <div className="infoPanelSection">
                  <div className="infoPanelSectionTitle">Файлы ({infoPanelFiles.length})</div>
                  {infoPanelFiles.length === 0 ? (
                    <p className="infoPanelHint">Нет файлов, кроме изображений (см. вкладку «Фото»).</p>
                  ) : (
                    <ul className="infoPanelMediaList">
                      {infoPanelFiles.map((m) => (
                        <li key={m.id}>
                          <a
                            href={normalizeDownloadUrl(m.file?.downloadUrl)}
                            target="_blank"
                            rel="noreferrer"
                            className="infoPanelMediaRow infoPanelMediaRow--link"
                            onClick={(e) => {
                              const h = normalizeDownloadUrl(m.file?.downloadUrl);
                              if (token && h && isFilesAccessProxyUrl(h)) {
                                e.preventDefault();
                                void triggerBrowserDownloadFromUrl(
                                  m.file?.downloadUrl,
                                  token,
                                  m.file?.originalName || "file",
                                );
                              }
                            }}
                          >
                            <span className="infoPanelMediaRowMain">📎 {m.file?.originalName ?? "Файл"}</span>
                            <span className="infoPanelMediaRowMeta">
                              {m.file?.size != null ? `${Math.max(1, Math.round(m.file.size / 1024))} КБ` : ""}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : infoPanelSection === "voice" ? (
                <div className="infoPanelSection">
                  <div className="infoPanelSectionTitle">Голосовые ({infoPanelVoice.length})</div>
                  {infoPanelVoice.length === 0 ? (
                    <p className="infoPanelHint">В этом чате нет голосовых сообщений.</p>
                  ) : (
                    <ul className="infoPanelVoiceList">
                      {infoPanelVoice.map((m) => (
                        <li key={m.id} className="infoPanelVoiceRow">
                          <ChatAttachmentAudio
                            messageKey={`panel-${m.id}`}
                            downloadUrl={m.file?.downloadUrl}
                            token={token}
                          />
                          <div className="infoPanelMediaRowMeta">{timeHHMM(m.createdAt)}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : infoPanelSection === "links" ? (
                <div className="infoPanelSection">
                  <div className="infoPanelSectionTitle">Ссылки ({infoPanelLinks.length})</div>
                  {infoPanelLinks.length === 0 ? (
                    <p className="infoPanelHint">В тексте сообщений пока нет ссылок.</p>
                  ) : (
                    <ul className="infoPanelMediaList">
                      {infoPanelLinks.map((row) => (
                        <li key={row.id} className="infoPanelMediaRow">
                          <a href={row.url} target="_blank" rel="noreferrer" className="infoPanelLinkUrl">
                            {row.url}
                          </a>
                          <div className="infoPanelLinkPreview">{row.preview}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="infoPanelSection">
                  <div className="infoPanelSectionTitle">Уведомления</div>
                  {!activeChatKeyForPanel ? (
                    <p className="infoPanelHint">Выберите чат слева, чтобы настроить оповещения.</p>
                  ) : (
                    <>
                      <p className="infoPanelHint" style={{ marginBottom: 10 }}>
                        {muteStatusLabel(activeChatKeyForPanel)}
                      </p>
                      <button
                        type="button"
                        className="moreMenuWideBtn"
                        onClick={() => setChatMute(activeChatKeyForPanel, "off")}
                      >
                        Включить оповещения
                      </button>
                      <button
                        type="button"
                        className="moreMenuWideBtn subtle"
                        onClick={() => setChatMute(activeChatKeyForPanel, 1)}
                      >
                        Без звука 1 ч
                      </button>
                      <button
                        type="button"
                        className="moreMenuWideBtn subtle"
                        onClick={() => setChatMute(activeChatKeyForPanel, 2)}
                      >
                        Без звука 2 ч
                      </button>
                      <button
                        type="button"
                        className="moreMenuWideBtn subtle"
                        onClick={() => setChatMute(activeChatKeyForPanel, 4)}
                      >
                        Без звука 4 ч
                      </button>
                      <button
                        type="button"
                        className="moreMenuWideBtn subtle"
                        onClick={() => setChatMute(activeChatKeyForPanel, 8)}
                      >
                        Без звука 8 ч
                      </button>
                      <button
                        type="button"
                        className="moreMenuWideBtn subtle"
                        onClick={() => setChatMute(activeChatKeyForPanel, 24)}
                      >
                        Без звука 24 ч
                      </button>
                      <button
                        type="button"
                        className="moreMenuWideBtn subtle"
                        onClick={() => setChatMute(activeChatKeyForPanel, "forever")}
                      >
                        Без звука навсегда
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </aside>
        </div>
      ) : null}

      {newThingWizardKind ? (
        <div
          className="companyModalBackdrop newChatWizardBackdrop"
          onClick={() => {
            if (!wizardBusy) closeNewThingWizard();
          }}
        >
          <section className="companyModal newChatWizardModal" onClick={(e) => e.stopPropagation()}>
            <div className="companyModalHeader">
              <div>
                <div style={{ fontWeight: 700 }}>
                  {newThingWizardKind === "dm" ? "Новый личный чат" : "Новая группа"}
                </div>
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                  {newThingWizardKind === "dm"
                    ? "Только два человека: вы и собеседник. Не путайте с «Группой» в меню +."
                    : "Выберите от 1 до 100 участников (вы сами будете добавлены автоматически)"}
                </div>
              </div>
              <button type="button" className="chip" disabled={wizardBusy} onClick={closeNewThingWizard}>
                Закрыть
              </button>
            </div>

            {newThingWizardKind === "group" ? (
              <div className="row" style={{ marginBottom: 10 }}>
                <input
                  value={wizardGroupName}
                  onChange={(e) => setWizardGroupName(e.target.value)}
                  placeholder="Название группы"
                  style={{ flex: 1, minWidth: 0 }}
                />
              </div>
            ) : null}

            <div className="row" style={{ marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
              <input
                value={wizardUserQuery}
                onChange={(e) => setWizardUserQuery(e.target.value)}
                placeholder="Поиск по имени или отделу"
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>

            {wizardError ? (
              <div className="empty" style={{ color: "#f08080", marginBottom: 8 }}>
                {wizardError}
              </div>
            ) : null}

            <div className="companyList newChatWizardUserList">
              {newThingWizardUsers.length === 0 ? (
                <div className="empty" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <span>Нет пользователей в списке.</span>
                  <button type="button" onClick={() => void loadUsers()} disabled={!token || !organizationId || wizardBusy}>
                    Загрузить
                  </button>
                </div>
              ) : (
                newThingWizardUsers.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className={`newChatWizardRow ${wizardSelectedUserIds.includes(u.id) ? "selected" : ""}`}
                    onClick={() => toggleWizardUser(u.id)}
                  >
                    <span className="newChatWizardCheck" aria-hidden>
                      {newThingWizardKind === "dm"
                        ? wizardSelectedUserIds[0] === u.id
                          ? "◉"
                          : "○"
                        : wizardSelectedUserIds.includes(u.id)
                          ? "☑"
                          : "☐"}
                    </span>
                    <span className="newChatWizardEmail">{displayUserNameForSidebar(u, u.id)}</span>
                    {u.department ? <span className="newChatWizardMeta">{u.department}</span> : null}
                  </button>
                ))
              )}
            </div>

            <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                {newThingWizardKind === "group"
                  ? `Выбрано: ${wizardSelectedUserIds.length} (макс. 100)`
                  : "\u00a0"}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="chip" disabled={wizardBusy} onClick={closeNewThingWizard}>
                  Отмена
                </button>
                <button type="button" disabled={wizardBusy} onClick={() => void submitNewThingWizard()}>
                  {newThingWizardKind === "dm" ? "Открыть чат" : "Создать группу"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {showLogs ? (
        <div className="logsDrawer" role="dialog" aria-label="logs">
          <div className="logsHeader">
            <div style={{ fontWeight: 800 }}>Лог</div>
            <button className="chip" onClick={() => setShowLogs(false)}>
              ✕
            </button>
          </div>
          <pre className="logsBody">{log.join("\n") || "Пусто"}</pre>
        </div>
      ) : null}
    </div>
  );
}
