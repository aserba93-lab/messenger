import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, MouseEvent } from "react";
import { io, Socket } from "socket.io-client";
import * as XLSX from "xlsx";
import { acceptIncomingOffer, startOutgoingCall, type ActiveCall } from "./webrtcDm";
import "./App.css";

const TG_SESSION_KEY = "tg:session";
const TG_LAST_OPEN_CHAT_KEY = "tg:lastOpenChat";

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
  author: { email: string; firstName?: string | null; middleName?: string | null; lastName?: string | null };
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
  author: { email: string; firstName?: string | null; middleName?: string | null; lastName?: string | null };
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
const quickEmojis = ["👍", "❤️", "😂", "🔥", "🎉", "😮"];
const defaultStickerCatalog = [
  { id: "basic-emoji", title: "Basic Emoji", stickers: ["😀", "😁", "😂", "😍", "🤝", "👍", "🔥", "🎉"] },
  { id: "work-pack", title: "Work Pack", stickers: ["✅", "📌", "📎", "🧠", "💼", "🚀", "🛠", "📊"] },
  { id: "mood-pack", title: "Mood Pack", stickers: ["🙂", "😎", "🤔", "🥳", "😴", "😡", "🥶", "🤯"] },
];

async function gql<T>(query: string, variables: Record<string, unknown>, token?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
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
    throw new Error(errMsg);
  }
  if (data.errors?.length) {
    const first = data.errors[0];
    const detail =
      first?.extensions?.originalError?.message ||
      first?.extensions?.exception?.message ||
      first?.extensions?.details ||
      "";
    const msg = first?.message ?? "GraphQL error";
    throw new Error(detail && detail !== msg ? `${msg}: ${detail}` : msg);
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
      const v = localStorage.getItem("tg:chatListScope");
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
  const [showSaved, setShowSaved] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [showPins, setShowPins] = useState(false);
  const [forwardSelecting, setForwardSelecting] = useState(false);
  const [forwardSelectedIds, setForwardSelectedIds] = useState<Set<string>>(new Set());
  const [showForwardPicker, setShowForwardPicker] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    return localStorage.getItem("tg:theme") === "light" ? "light" : "dark";
  });
  const [browserNotify, setBrowserNotify] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("tg:browserNotify") === "1";
  });
  const browserNotifyRef = useRef(browserNotify);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [newChatMenuOpen, setNewChatMenuOpen] = useState(false);
  const [newThingWizardKind, setNewThingWizardKind] = useState<null | "dm" | "group" | "channel">(null);
  const [wizardUserQuery, setWizardUserQuery] = useState("");
  const [wizardSelectedUserIds, setWizardSelectedUserIds] = useState<string[]>([]);
  const [wizardGroupName, setWizardGroupName] = useState("Новая группа");
  const [wizardChannelName, setWizardChannelName] = useState("new-channel");
  const [wizardChannelType, setWizardChannelType] = useState<"public" | "private" | "broadcast">("public");
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

  useEffect(() => {
    try {
      localStorage.setItem("tg:chatListScope", chatListScope);
    } catch {
      /* ignore */
    }
  }, [chatListScope]);

  // Deep-link: #dm=<directChatId>&call=1
  useEffect(() => {
    if (!token) return;
    const onHash = () => {
      const raw = typeof window !== "undefined" ? String(window.location.hash || "") : "";
      if (!raw || raw === lastDeepLinkHashRef.current) return;
      if (!raw.startsWith("#")) return;
      const params = new URLSearchParams(raw.slice(1));
      const dm = params.get("dm");
      const call = params.get("call");
      if (!dm) return;
      lastDeepLinkHashRef.current = raw;
      void (async () => {
        try {
          await openChatFromList(`d:${dm}`);
          if (call === "1") queueMicrotask(() => void startVideoMeeting());
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
  const [chatMenu, setChatMenu] = useState<null | { x: number; y: number; key: string; sub: "main" | "notify" }>(null);
  const [callMenuOpen, setCallMenuOpen] = useState(false);
  /** В группе: сначала список участников, затем выбор аудио/видео */
  const [groupCallMenuUserId, setGroupCallMenuUserId] = useState<string | null>(null);
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
  useEffect(() => {
    if (!webrtcUi || webrtcUi.audioOnly) return;
    const tick = () => setWebrtcScreenSharing(webrtcUi.activeCall.isScreenSharing());
    const id = window.setInterval(tick, 400);
    tick();
    return () => window.clearInterval(id);
  }, [webrtcUi]);
  const userIdRef = useRef("");
  const directChatsRef = useRef<DirectChat[]>([]);
  const webrtcBusyRef = useRef(false);
  const webrtcPeerRef = useRef("");
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
    const onClick = () => setChatMenu(null);
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
    if (!callMenuOpen) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const el = callMenuWrapRef.current;
      if (el && !el.contains(e.target as Node)) {
        setCallMenuOpen(false);
        setGroupCallMenuUserId(null);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [callMenuOpen]);

  useEffect(() => {
    setCallMenuOpen(false);
    setGroupCallMenuUserId(null);
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
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = distance < 120;
      stickToBottomRef.current = nearBottom;
      setShowScrollToBottom(!nearBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    stickToBottomRef.current = true;
    onScroll();
    queueMicrotask(() => {
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeChannelId, activeGroupChatId, activeDirectChatId, threadRootId, showPins, showSaved]);

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
    try {
      const rawInstalled = localStorage.getItem("tg:installedStickerPackIds");
      const rawCustom = localStorage.getItem("tg:customStickerPacks");
      if (rawInstalled) {
        const arr = JSON.parse(rawInstalled);
        if (Array.isArray(arr)) setInstalledStickerPackIds(arr.filter((x) => typeof x === "string"));
      } else {
        setInstalledStickerPackIds([defaultStickerCatalog[0].id]);
      }
      if (rawCustom) {
        const custom = JSON.parse(rawCustom);
        if (Array.isArray(custom)) {
          const safe = custom.filter(
            (x) => x && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.stickers),
          );
          if (safe.length) setStickerCatalog((prev) => [...prev, ...safe]);
        }
      }
    } catch {
      setInstalledStickerPackIds([defaultStickerCatalog[0].id]);
    }
  }, []);

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
    if (showRightPanel) setInfoPanelSection("about");
  }, [showRightPanel]);

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
      socket?.disconnect();
    } catch {
      // ignore
    }
    setSocket(null);
    setToken("");
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
    if (socket) socket.disconnect();
    const s = io(SOCKET_URL, {
      auth: { token },
      path: "/socket.io/",
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 25,
      reconnectionDelay: 800,
    });
    s.on("connect", () => pushLog("Socket подключен."));
    s.on("connect_error", (err: Error) => {
      pushLog(`Socket ошибка: ${err?.message || "connect_error"} (проверьте прокси /socket.io/ на nginx)`);
    });
    s.on("disconnect", (reason: string) => {
      if (reason === "io server disconnect") pushLog("Socket отключён сервером.");
    });
    s.on("presence:snapshot", (evt: any) => {
      const items = Array.isArray(evt?.items) ? evt.items : [];
      if (!items.length) return;
      setPresenceByUserId((prev) => {
        const next = { ...prev };
        for (const it of items) {
          const uid = String(it?.userId ?? "");
          if (!uid) continue;
          const status = String(it?.status ?? "");
          if (!status) continue;
          next[uid] = {
            status,
            lastSeen: it?.lastSeen != null ? String(it.lastSeen) : next[uid]?.lastSeen,
          };
        }
        return next;
      });
    });
    s.on("presence:update", (evt: any) => {
      const who = String(evt?.userId ?? "");
      const status = String(evt?.status ?? "");
      if (!who || !status) return;
      pushLog(`🟢 presence: ${displayUser(who)} -> ${status}`);
      setPresenceByUserId((prev) => ({ ...prev, [who]: { status, lastSeen: String(evt?.lastSeen ?? "") || undefined } }));
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
      const fromMe = String(msg.author?.email ?? "") === myAccountEmailRef.current;
      const v = key ? chatMuteMapRef.current[key] : undefined;
      const muted =
        v === "forever" ||
        (v && v !== "forever" && !Number.isNaN(Date.parse(v)) && Date.now() < Date.parse(v));

      const shouldNotify =
        key &&
        !muted &&
        !fromMe &&
        browserNotifyRef.current &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        (!isActive || tabHidden);

      if (shouldNotify) {
        try {
          const body =
            msg.type === "voice"
              ? "Голосовое сообщение"
              : msg.type === "file"
                ? "Файл"
                : (msg.content || "Новое сообщение").slice(0, 160);
          const fromLabel = displayUserNameForSidebar(msg.author as any, String(msg.author?.email ?? "Участник"));
          const n = new Notification(fromLabel || "Новое сообщение", { body, tag: key ? `${key}:${msg.id}` : "dm" });
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
      const from = String(data?.fromUserId ?? "");
      const p = data?.payload;
      if (!from || !p || p.type !== "offer" || !p.sdp) return;
      const uid = userIdRef.current;
      if (!uid || from === uid) return;
      /** Сервер пропускает только участников одной организации; локальный список DM может быть ещё не загружен. */
      if (webrtcBusyRef.current) return;
      const audioOnly = !String(p.sdp).includes("m=video");
      setIncomingCall({ fromUserId: from, offerSdp: p.sdp, audioOnly });
      if (
        browserNotifyRef.current &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          new Notification("Sales factory", {
            body: audioOnly ? "Входящий аудиозвонок" : "Входящий видеозвонок",
            tag: `call:${from}:${Date.now()}`,
            requireInteraction: typeof document !== "undefined" && document.hidden,
          });
        } catch {
          /* ignore */
        }
      }
    });
    s.on("call:hand", (data: any) => {
      const from = String(data?.fromUserId ?? "");
      if (!from || from !== webrtcPeerRef.current) return;
      setWebrtcPeerHandRaised(!!data?.raised);
    });
    setSocket(s);
  }

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

  async function loadChannels() {
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
      return data.channels[0]?.id ?? "";
    });
    pushLog(`Каналов: ${data.channels.length}`);
  }

  async function loadGroupChats() {
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
      return data.groupChats[0]?.id ?? "";
    });
    pushLog(`Групп: ${data.groupChats.length}`);
  }

  async function loadDirectChats() {
    if (!token) return;
    const data = await gql<{ dms: DirectChat[] }>(`query { dms { id userIds } }`, {}, token);
    setDirectChats(data.dms);
    setActiveDirectChatId((prev) => {
      const ids = new Set(data.dms.map((d) => d.id));
      if (prev && ids.has(prev)) return prev;
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
      await loadMessages(id);
      return;
    }
    if (kind === "g") {
      setChatListScope((prev) => (prev === "all" ? prev : "groups"));
      setMode("groups");
      setActiveGroupChatId(id);
      setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("g", id)]: 0 }));
      await loadGroupMessages(id);
      return;
    }
    if (kind === "d") {
      setChatListScope((prev) => (prev === "all" ? prev : "dms"));
      setMode("dms");
      setActiveDirectChatId(id);
      setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("d", id)]: 0 }));
      await loadDirectMessages(id);
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
    try {
      const ac = await acceptIncomingOffer(socket, {
        fromUserId,
        offerSdp,
        audioOnly,
        onRemoteStream: (stream) => {
          setWebrtcUi((prev) => (prev ? { ...prev, remoteStream: stream } : null));
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
      webrtcPeerRef.current = fromUserId;
      setWebrtcMicOn(true);
      setWebrtcCamOn(!audioOnly);
      setWebrtcPeerHandRaised(false);
      setWebrtcLocalHandRaised(false);
      setWebrtcUi({
        localStream: ac.localStream,
        remoteStream: null,
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
    }
  }

  function declineIncomingCall() {
    if (!incomingCall || !socket) return;
    socket.emit("call:end", { targetUserId: incomingCall.fromUserId });
    setIncomingCall(null);
  }

  async function startAudioCallToPeer(other: string) {
    if (!canStartCalls) {
      setChatError("Недостаточно прав для звонков");
      return;
    }
    if (!other || !socket) {
      setChatError("Нет собеседника или сокет не подключён");
      return;
    }
    if (other === userId) {
      setChatError("Звонок самому себе недоступен");
      return;
    }
    if (webrtcBusyRef.current) return;
    webrtcBusyRef.current = true;
    try {
      const ac = await startOutgoingCall(socket, {
        targetUserId: other,
        audioOnly: true,
        onRemoteStream: (stream) => {
          setWebrtcUi((prev) => (prev ? { ...prev, remoteStream: stream } : null));
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
      webrtcPeerRef.current = other;
      setWebrtcMicOn(true);
      setWebrtcCamOn(false);
      setWebrtcPeerHandRaised(false);
      setWebrtcLocalHandRaised(false);
      setWebrtcUi({
        localStream: ac.localStream,
        remoteStream: null,
        hangup: () => {
          webrtcPeerRef.current = "";
          setWebrtcPeerHandRaised(false);
          setWebrtcLocalHandRaised(false);
          setWebrtcScreenSharing(false);
          ac.hangup();
        },
        audioOnly: true,
        activeCall: ac,
        callPeerId: other,
      });
      void sendServiceMessageToCurrentChat(`📞 Аудиозвонок`);
      pushLog("Созвон: аудио");
    } catch (e: any) {
      webrtcBusyRef.current = false;
      setChatError(String(e?.message ?? e));
    }
  }

  async function startAudioCall() {
    if (mode !== "dms" || !activeDirectChat) {
      setChatError("Откройте личный чат или выберите участника группы в меню звонка");
      return;
    }
    if (activeDirectChat.userIds.length === 1 && activeDirectChat.userIds[0] === userId) {
      setChatError("Звонок самому себе недоступен");
      return;
    }
    const other = activeDirectChat.userIds.find((id) => id !== userId) ?? "";
    await startAudioCallToPeer(other);
  }

  async function startVideoCallToPeer(other: string) {
    if (!canStartCalls) {
      setChatError("Недостаточно прав для видеовстреч");
      return;
    }
    if (!other || !socket) {
      setChatError("Нет собеседника или сокет не подключён");
      return;
    }
    if (other === userId) {
      setChatError("Видеозвонок самому себе недоступен");
      return;
    }
    if (webrtcBusyRef.current) return;
    webrtcBusyRef.current = true;
    try {
      const ac = await startOutgoingCall(socket, {
        targetUserId: other,
        audioOnly: false,
        onRemoteStream: (stream) => {
          setWebrtcUi((prev) => (prev ? { ...prev, remoteStream: stream } : null));
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
      webrtcPeerRef.current = other;
      setWebrtcMicOn(true);
      setWebrtcCamOn(true);
      setWebrtcPeerHandRaised(false);
      setWebrtcLocalHandRaised(false);
      setWebrtcUi({
        localStream: ac.localStream,
        remoteStream: null,
        hangup: () => {
          webrtcPeerRef.current = "";
          setWebrtcPeerHandRaised(false);
          setWebrtcLocalHandRaised(false);
          setWebrtcScreenSharing(false);
          ac.hangup();
        },
        audioOnly: false,
        activeCall: ac,
        callPeerId: other,
      });
      void sendServiceMessageToCurrentChat(`🎥 Видеозвонок`);
      pushLog("Видеозвонок");
    } catch (e: any) {
      webrtcBusyRef.current = false;
      setChatError(String(e?.message ?? e));
    }
  }

  async function startVideoMeeting() {
    if (mode !== "dms" || !activeDirectChat) {
      setChatError("Откройте личный чат или выберите участника группы в меню звонка");
      return;
    }
    if (activeDirectChat.userIds.length === 1 && activeDirectChat.userIds[0] === userId) {
      setChatError("Видеозвонок самому себе недоступен");
      return;
    }
    const other = activeDirectChat.userIds.find((id) => id !== userId) ?? "";
    await startVideoCallToPeer(other);
  }

  function copyCallInviteLink() {
    if (mode !== "dms" || !activeDirectChatId) {
      setChatError("Ссылка на созвон: откройте личный чат с собеседником");
      return;
    }
    const base = `${window.location.origin}${window.location.pathname}`;
    const link = `${base}#dm=${encodeURIComponent(activeDirectChatId)}&call=1`;
    const text = `${link}\n\nОткройте ссылку, войдите в аккаунт и этот личный чат — затем можно начать звонок из меню чата.`;
    void navigator.clipboard.writeText(text);
    pushLog("Ссылка на чат для созвона скопирована в буфер");
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
    setUsers(data.users);
    setPresenceByUserId((prev) => {
      const next = { ...prev };
      for (const u of data.users) {
        if (u.status) {
          next[u.id] = {
            status: u.status,
            lastSeen: u.lastSeen != null ? String(u.lastSeen) : next[u.id]?.lastSeen,
          };
        }
      }
      return next;
    });
    pushLog(`Пользователей: ${data.users.length}`);
  }

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        if (organizationId) {
          await loadUsers();
          if (cancelled) return;
        }
        await loadGroupChats();
        if (cancelled) return;
        await loadDirectChats();
        if (cancelled) return;
        if (workspaceId) await loadChannels();
        if (cancelled) return;
        connectSocket();
        try {
          const raw = localStorage.getItem(TG_LAST_OPEN_CHAT_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as { key?: string } | string;
            const key = typeof parsed === "string" ? parsed : parsed?.key;
            if (key && typeof key === "string" && /^[cgd]:/.test(key)) {
              await openChatFromList(key);
            }
          }
        } catch {
          /* ignore */
        }
      } catch (e) {
        console.error(e);
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
    await loadDirectMessages(data.ensureDirectChat.id);
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

  async function openNewThingWizard(kind: "dm" | "group" | "channel") {
    setNewChatMenuOpen(false);
    setNewThingWizardKind(kind);
    setWizardSelectedUserIds([]);
    setWizardError("");
    setWizardUserQuery("");
    if (kind === "group") setWizardGroupName("Новая группа");
    if (kind === "channel") {
      setWizardChannelName("new-channel");
      setWizardChannelType("public");
    }
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
      return;
    }
    setWizardSelectedUserIds((prev) => {
      const s = new Set(prev);
      if (s.has(pickId)) s.delete(pickId);
      else s.add(pickId);
      return Array.from(s);
    });
  }

  function wizardSelectAllCompanyUsers() {
    setWizardSelectedUserIds(users.map((u) => u.id).filter((id) => id !== userId));
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
        await loadGroupMessages(data.createGroupChat.id);
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
    if (!workspaceId) {
      setWizardError("Не выбран workspace");
      return;
    }
    if (!canCreateChannelsAndGroups) {
      setWizardError("Недостаточно прав для создания канала");
      return;
    }
    const chName = wizardChannelName.trim();
    if (!chName) {
      setWizardError("Введите название канала");
      return;
    }
    setWizardBusy(true);
    try {
      const data = await gql<{ createChannel: { id: string } }>(
        `mutation($input: CreateChannelInput!) {
          createChannel(input: $input) { id name type workspaceId }
        }`,
        { input: { workspaceId, name: chName, type: wizardChannelType } },
        token,
      );
      const channelId = data.createChannel.id;
      for (const uid of wizardSelectedUserIds) {
        if (uid === userId) continue;
        await gql<{ channelAddMember: boolean }>(
          `mutation($input: ChannelAddMemberInput!) { channelAddMember(input: $input) }`,
          { input: { channelId, userId: uid } },
          token,
        );
      }
      await loadChannels();
      setMode("channels");
      setActiveChannelId(channelId);
      await loadMessages(channelId);
      closeNewThingWizard();
      setMobileSidebarOpen(false);
      pushLog(`Канал создан: #${chName}`);
    } catch (e: unknown) {
      setWizardError(e instanceof Error ? e.message : String(e));
    } finally {
      setWizardBusy(false);
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
          author { email firstName middleName lastName }
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
    if (mode === "channels" && activeChannelId) await loadMessages(activeChannelId);
    else if (mode === "groups" && activeGroupChatId) await loadGroupMessages(activeGroupChatId);
    else if (mode === "dms" && activeDirectChatId) await loadDirectMessages(activeDirectChatId);
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
                title="Создать чат, группу или канал"
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
                  <button
                    type="button"
                    className="tgPopoverItem"
                    onClick={() => void openNewThingWizard("channel")}
                    disabled={!token || !workspaceId || !organizationId || !canCreateChannelsAndGroups}
                  >
                    # Канал в workspace
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

        <div className="sidebarChatsBlock">
          <div className="tgFolderTabsWithFilter tgMenuAnchor" ref={chatListFilterAnchorRef}>
            <div className="row tgFolderTabs tgFolderTabs--grow">
              <button className={chatFolder === "all" ? "active" : ""} onClick={() => setChatFolder("all")}>
                Все
              </button>
              <button className={chatFolder === "unread" ? "active" : ""} onClick={() => setChatFolder("unread")}>
                Непрочитанные
              </button>
              <button className={chatFolder === "archived" ? "active" : ""} onClick={() => setChatFolder("archived")}>
                Архив
              </button>
            </div>
            <button
              type="button"
              className="tgCircleBtn tgChatScopeFilterBtn"
              title="Показать: все чаты, личные, группы или каналы"
              aria-expanded={chatListFilterOpen}
              aria-haspopup="menu"
              onClick={() => setChatListFilterOpen((v) => !v)}
            >
              {chatListScope === "all"
                ? "Все чаты"
                : chatListScope === "dms"
                  ? "Личные"
                  : chatListScope === "groups"
                    ? "Группы"
                    : "Каналы"}{" "}
              ▾
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
              </div>
            ) : null}
          </div>
          <div className="tgChatList">
            {chatListScope === "all" ? (
              <>
                {unifiedChatRows.map((row) => {
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
                      <button
                        key={`all-d-${d.id}`}
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
                          void loadDirectMessages(d.id);
                        }}
                      >
                        <div className="tgAvatar">{initials(title)}</div>
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
                            {chatPreviewByKey[chatKeyFor("d", d.id)]?.text || "Личка"}
                          </div>
                        </div>
                        {unreadFor(chatKeyFor("d", d.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("d", d.id))}</div> : null}
                      </button>
                    );
                  }
                  if (row.kind === "g") {
                    const g = row.g;
                    return (
                      <button
                        key={`all-g-${g.id}`}
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
                          void loadGroupMessages(g.id);
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
                            {chatPreviewByKey[chatKeyFor("g", g.id)]?.text || `Группа · участников: ${g.memberIds?.length ?? 0}`}
                          </div>
                        </div>
                        {unreadFor(chatKeyFor("g", g.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("g", g.id))}</div> : null}
                      </button>
                    );
                  }
                  const c = row.c;
                  return (
                    <button
                      key={`all-c-${c.id}`}
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
                        void loadMessages(c.id);
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
                          {chatPreviewByKey[chatKeyFor("c", c.id)]?.text || `Канал · ${c.type}`}
                        </div>
                      </div>
                      {unreadFor(chatKeyFor("c", c.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("c", c.id))}</div> : null}
                    </button>
                  );
                })}
              </>
            ) : chatListScope === "channels"
              ? orderedChannels.map((c) => (
                  <button
                    key={c.id}
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
                      void loadMessages(c.id);
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
                        {chatPreviewByKey[chatKeyFor("c", c.id)]?.text || `Канал · ${c.type}`}
                      </div>
                    </div>
                    {unreadFor(chatKeyFor("c", c.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("c", c.id))}</div> : null}
                  </button>
                ))
              : chatListScope === "groups"
                ? orderedGroups.map((g) => (
                    <button
                      key={g.id}
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
                        void loadGroupMessages(g.id);
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
                          {chatPreviewByKey[chatKeyFor("g", g.id)]?.text || `Группа · участников: ${g.memberIds?.length ?? 0}`}
                        </div>
                      </div>
                    {unreadFor(chatKeyFor("g", g.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("g", g.id))}</div> : null}
                    </button>
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
                      <button
                        key={d.id}
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
                          void loadDirectMessages(d.id);
                        }}
                      >
                        <div className="tgAvatar">{initials(title)}</div>
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
                            {chatPreviewByKey[chatKeyFor("d", d.id)]?.text || "Личка"}
                          </div>
                        </div>
                        {unreadFor(chatKeyFor("d", d.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("d", d.id))}</div> : null}
                      </button>
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
                    <div className={`moreMenuProfileAvatar ${profileAvatarUrl ? "moreMenuProfileAvatar--img" : ""}`}>
                      {profileAvatarUrl ? <img src={profileAvatarUrl} alt="" /> : <span>{initials(myProfileEmail || loginIdentifier)}</span>}
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
                        const next = !browserNotify;
                        if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
                          await Notification.requestPermission();
                        }
                        setBrowserNotify(next);
                      })();
                    }}
                    disabled={!token || typeof Notification === "undefined"}
                  >
                    {browserNotify ? "Отключить уведомления браузера" : "Включить уведомления браузера"}
                  </button>
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
          <div className="chatMenu chatMenu--wide" style={{ top: chatMenu.y, left: chatMenu.x }} role="menu">
            {chatMenu.sub === "main" ? (
              <>
                <button type="button" className="msgMenuItem" onClick={() => { togglePin(chatMenu.key); setChatMenu(null); }}>
                  {isPinned(chatMenu.key) ? "Открепить чат" : "Закрепить чат"}
                </button>
                <div className="msgMenuSep" />
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
                className={`tgHeaderAvatar ${mode === "channels" && activeChannel?.avatarUrl ? "tgHeaderAvatar--img" : ""} ${mode === "groups" && activeGroupChat?.avatarUrl ? "tgHeaderAvatar--img" : ""} ${mode === "dms" && isSelfNotesActiveDm && profileAvatarUrl ? "tgHeaderAvatar--img" : ""}`}
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
                        : "Выберите канал"
                      : mode === "groups"
                        ? activeGroupChat
                          ? activeGroupChat.name
                          : "Выберите группу"
                        : activeDirectChat
                          ? isSelfNotesActiveDm
                            ? "Избранное"
                            : (() => {
                                const otherId =
                                  activeDirectChat.userIds.find((id) => id !== userId) ?? activeDirectChat.userIds[0] ?? "";
                                const u = users.find((x) => x.id === otherId);
                                return displayUserNameForSidebar(u, otherId || activeDirectChat.id);
                              })()
                          : "Выберите личку"}
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
                  title="Звонок (личный чат или участник группы)"
                  disabled={
                    !canStartCalls ||
                    !socket ||
                    (mode === "dms" &&
                      (!activeDirectChat || isSelfNotesActiveDm)) ||
                    (mode === "groups" &&
                      (!activeGroupChat ||
                        !(activeGroupChat.memberIds ?? []).some((id) => id !== userId))) ||
                    mode === "channels"
                  }
                  onClick={() => {
                    setGroupCallMenuUserId(null);
                    setCallMenuOpen((v) => !v);
                  }}
                >
                  📞
                </button>
                {callMenuOpen &&
                canStartCalls &&
                socket &&
                ((mode === "dms" && activeDirectChat && !isSelfNotesActiveDm) ||
                  (mode === "groups" &&
                    activeGroupChat &&
                    (activeGroupChat.memberIds ?? []).some((id) => id !== userId))) ? (
                  <div className="tgPopoverMenu" role="menu">
                    {mode === "groups" && activeGroupChat && !groupCallMenuUserId ? (
                      <>
                        <div className="tgPopoverHint">Кому позвонить (1:1)</div>
                        {(activeGroupChat.memberIds ?? []).filter((id) => id !== userId).map((mid) => {
                          const u = users.find((x) => x.id === mid);
                          return (
                            <button
                              key={mid}
                              type="button"
                              className="tgPopoverItem"
                              onClick={() => setGroupCallMenuUserId(mid)}
                            >
                              {displayUserNameForSidebar(u, mid)}
                            </button>
                          );
                        })}
                      </>
                    ) : mode === "groups" && groupCallMenuUserId ? (
                      <>
                        <button
                          type="button"
                          className="tgPopoverItem tgPopoverItem--muted"
                          onClick={() => setGroupCallMenuUserId(null)}
                        >
                          ← Участники
                        </button>
                        <button
                          type="button"
                          className="tgPopoverItem"
                          onClick={() => {
                            const uid = groupCallMenuUserId;
                            setCallMenuOpen(false);
                            setGroupCallMenuUserId(null);
                            void startAudioCallToPeer(uid);
                          }}
                        >
                          Аудиозвонок
                        </button>
                        <button
                          type="button"
                          className="tgPopoverItem"
                          onClick={() => {
                            const uid = groupCallMenuUserId;
                            setCallMenuOpen(false);
                            setGroupCallMenuUserId(null);
                            void startVideoCallToPeer(uid);
                          }}
                        >
                          Видеозвонок
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="tgPopoverItem"
                          onClick={() => {
                            setCallMenuOpen(false);
                            void startAudioCall();
                          }}
                        >
                          Аудиозвонок
                        </button>
                        <button
                          type="button"
                          className="tgPopoverItem"
                          onClick={() => {
                            setCallMenuOpen(false);
                            void startVideoMeeting();
                          }}
                        >
                          Видеозвонок
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
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
                onClick={async () => {
                  setShowPins(false);
                  if (mode === "channels" && activeChannelId) await loadMessages(activeChannelId);
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
                  <div className="profileAvatarPreview userCabinetAvatar">
                    {profileAvatarUrl ? <img src={profileAvatarUrl} alt="avatar" /> : <span>{initials(myProfileEmail || loginIdentifier)}</span>}
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

                <div className="title userCabinetStickersTitle">Стикеры</div>
                <div className="empty userCabinetStickersIntro">Скачайте JSON-пак или установите/отключите набор для отправки в чате.</div>
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
              className={`msg ${m.author?.email === myAccountEmailForMessages ? "mine" : "other"} ${showMeta ? "" : "compact"} ${forwardSelecting ? "selecting" : ""} ${forwardSelectedIds.has(m.id) ? "selected" : ""}`}
            >
              {showDay ? (
                <div className="daySep">
                  <span>{dt.toLocaleDateString()}</span>
                </div>
              ) : null}
              <div className="actions">
                <button className="chip" onClick={() => void editMessageInChat(m.id)} disabled={!token || m.author?.email !== myAccountEmailForMessages}>
                  ✎
                </button>
                <button className="chip" onClick={() => void deleteMessageInChat(m.id)} disabled={!token || m.author?.email !== myAccountEmailForMessages}>
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
                    m.author?.email === myAccountEmailForMessages &&
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
                {(mode === "groups" || mode === "channels") && showMeta && m.author?.email !== myAccountEmailForMessages ? (
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
                  m.content ? m.content : "(удалено)"
                )}
                <span className="bubbleTime">
                  {m.author?.email === myAccountEmailForMessages ? (
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
                  <button className="msgMenuItem" onClick={() => void editMessageInChat(m.id)} disabled={m.author?.email !== myAccountEmailForMessages}>
                    Редактировать
                  </button>
                  <button className="msgMenuItem danger" onClick={() => void deleteMessageInChat(m.id)} disabled={m.author?.email !== myAccountEmailForMessages}>
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
          <div className="webrtcOverlay" role="dialog" aria-label="Звонок">
            <div className="webrtcPanel webrtcPanel--fullscreen">
              <div className="webrtcStage">
                <video
                  ref={(el) => {
                    if (el) el.srcObject = webrtcUi.remoteStream;
                  }}
                  autoPlay
                  playsInline
                  className={`webrtcRemote ${webrtcUi.audioOnly ? "webrtcRemote--audioOnly" : ""}`}
                />
                {!webrtcUi.audioOnly ? (
                  <div className="webrtcLocalPip">
                    <video
                      ref={(el) => {
                        if (el) el.srcObject = webrtcUi.localStream;
                      }}
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
        {incomingCall ? (
          <div className="webrtcOverlay webrtcOverlay--incoming" role="dialog" aria-label="Входящий звонок">
            <div className="webrtcPanel webrtcIncomingCard">
              <div style={{ marginBottom: 8 }}>
                Входящий {incomingCall.audioOnly ? "звонок" : "видеозвонок"}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="chip" onClick={() => void acceptIncomingCall()}>
                  Принять
                </button>
                <button type="button" className="chip" onClick={declineIncomingCall}>
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
      </main>

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
                className={`infoPanelHeroAvatar ${mode === "channels" && activeChannel?.avatarUrl ? "infoPanelHeroAvatar--img" : ""} ${mode === "groups" && activeGroupChat?.avatarUrl ? "infoPanelHeroAvatar--img" : ""} ${mode === "dms" && isSelfNotesActiveDm && profileAvatarUrl ? "infoPanelHeroAvatar--img" : ""}`}
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
                    return initials(displayUserNameForSidebar(u, otherId || "Л"));
                  })()
                )}
              </div>
              <div className="infoPanelHeroTitle">
                {mode === "channels"
                  ? activeChannel
                    ? `#${activeChannel.name}`
                    : "Канал не выбран"
                  : mode === "groups"
                    ? activeGroupChat
                      ? activeGroupChat.name
                      : "Группа не выбрана"
                    : activeDirectChat
                      ? isSelfNotesActiveDm
                        ? "Избранное"
                        : (() => {
                            const otherId =
                              activeDirectChat.userIds.find((id) => id !== userId) ?? activeDirectChat.userIds[0] ?? "";
                            const u = users.find((x) => x.id === otherId);
                            return displayUserNameForSidebar(u, otherId || activeDirectChat.id);
                          })()
                      : "Личка не выбрана"}
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
                  [
                    ["about", "Об чате"],
                    ["photos", "Фото"],
                    ["files", "Файлы"],
                    ["voice", "Голосовые"],
                    ["links", "Ссылки"],
                    ["notify", "Уведомления"],
                  ] as const
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
                  {newThingWizardKind === "dm"
                    ? "Новый личный чат"
                    : newThingWizardKind === "group"
                      ? "Новая группа"
                      : "Новый канал"}
                </div>
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                  {newThingWizardKind === "dm"
                    ? "Только два человека: вы и собеседник. Не путайте с «Группой» в меню +."
                    : newThingWizardKind === "group"
                      ? "Выберите от 1 до 100 участников (вы сами будете добавлены автоматически)"
                      : "Выберите участников — можно добавить всех сотрудников компании"}
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

            {newThingWizardKind === "channel" ? (
              <div className="row" style={{ marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                <input
                  value={wizardChannelName}
                  onChange={(e) => setWizardChannelName(e.target.value)}
                  placeholder="Название канала"
                  style={{ flex: 1, minWidth: 160 }}
                />
                <select
                  value={wizardChannelType}
                  onChange={(e) => setWizardChannelType(e.target.value as "public" | "private" | "broadcast")}
                  style={{
                    boxSizing: "border-box",
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "rgba(0,0,0,0.25)",
                    color: "inherit",
                  }}
                >
                  <option value="public">public</option>
                  <option value="private">private</option>
                  <option value="broadcast">broadcast</option>
                </select>
              </div>
            ) : null}

            <div className="row" style={{ marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
              <input
                value={wizardUserQuery}
                onChange={(e) => setWizardUserQuery(e.target.value)}
                placeholder="Поиск по email или отделу"
                style={{ flex: 1, minWidth: 0 }}
              />
              {newThingWizardKind === "channel" ? (
                <button type="button" onClick={wizardSelectAllCompanyUsers} disabled={!users.length || wizardBusy}>
                  Все сотрудники
                </button>
              ) : null}
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
                    <span className="newChatWizardMeta">{u.email}</span>
                    {u.department ? <span className="newChatWizardMeta">{u.department}</span> : null}
                  </button>
                ))
              )}
            </div>

            <div className="row" style={{ marginTop: 12, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                {newThingWizardKind === "group" || newThingWizardKind === "channel"
                  ? `Выбрано: ${wizardSelectedUserIds.length}${newThingWizardKind === "group" ? " (макс. 100)" : ""}`
                  : "\u00a0"}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="chip" disabled={wizardBusy} onClick={closeNewThingWizard}>
                  Отмена
                </button>
                <button type="button" disabled={wizardBusy} onClick={() => void submitNewThingWizard()}>
                  {newThingWizardKind === "dm"
                    ? "Открыть чат"
                    : newThingWizardKind === "group"
                      ? "Создать группу"
                      : "Создать канал"}
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
