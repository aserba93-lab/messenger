import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent } from "react";
import { io, Socket } from "socket.io-client";
import * as XLSX from "xlsx";
import "./App.css";

type LoginResult = {
  accessToken: string;
  viewer: { userId: string; organizationId: string; role: string };
};

type Channel = { id: string; workspaceId: string; name: string; type: "public" | "private" | "broadcast" };
type GroupChat = { id: string; name: string; memberIds: string[] };
type DirectChat = { id: string; userIds: string[] };

type Reaction = { emoji: string; count: number; viewerHasReacted: boolean };
type FileInfo = { id: string; originalName?: string | null; mimeType: string; size: number; downloadUrl?: string };

type Message = {
  id: string;
  content: string;
  createdAt: string;
  author: { email: string };
  type?: string;
  file?: FileInfo | null;
  reactions?: Reaction[];
  parentMessageId?: string | null;
  editedAt?: string | null;
  isDeleted?: boolean;
  _localFileState?: "uploading" | "scanning" | "failed";
  _localError?: string;
};

type DirectChatMessage = {
  id: string;
  directChatId: string;
  content: string;
  createdAt: string;
  author: { email: string };
  type?: string;
  parentMessageId?: string | null;
  reactions?: Reaction[];
  file?: FileInfo | null;
};

type GlobalSearchResult = {
  users: { id: string; email: string; firstName?: string | null; lastName?: string | null }[];
  channels: { id: string; name: string; workspaceId: string; type: string }[];
  messages: { id: string; content: string; createdAt: string; type: string; author: { email: string }; channelId?: string | null; groupChatId?: string | null; directChatId?: string | null }[];
  files: { id: string; url: string }[];
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
const SOCKET_URL = API_BASE || (typeof window !== "undefined" ? window.location.origin : "");
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

export default function App() {
  const [authMode, setAuthMode] = useState<"admin" | "user">("user");
  const [organizationId, setOrganizationId] = useState("");
  const [organizationCode, setOrganizationCode] = useState("");
  const [email, setEmail] = useState("admin@seed.local");
  const [password, setPassword] = useState("SeedPass123!");
  const [workspaceId, setWorkspaceId] = useState("");

  const [token, setToken] = useState("");
  const [userId, setUserId] = useState("");
  const [viewerRole, setViewerRole] = useState<"owner" | "admin" | "manager" | "employee" | "guest" | "">("");

  const [mode, setMode] = useState<"channels" | "groups" | "dms">("channels");

  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState("");
  const [groupChats, setGroupChats] = useState<GroupChat[]>([]);
  const [activeGroupChatId, setActiveGroupChatId] = useState("");
  const [directChats, setDirectChats] = useState<DirectChat[]>([]);
  const [activeDirectChatId, setActiveDirectChatId] = useState("");

  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [replyTo, setReplyTo] = useState<{ id: string; preview: string } | null>(null);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [globalQuery, setGlobalQuery] = useState("");
  const [globalResult, setGlobalResult] = useState<GlobalSearchResult | null>(null);
  const [showGlobalResult, setShowGlobalResult] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [showPins, setShowPins] = useState(false);
  const [forwardSelecting, setForwardSelecting] = useState(false);
  const [forwardSelectedIds, setForwardSelectedIds] = useState<Set<string>>(new Set());
  const [showForwardPicker, setShowForwardPicker] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showDev, setShowDev] = useState(false);
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
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [viewportW, setViewportW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1280));
  const [authError, setAuthError] = useState("");
  const [chatSearch, setChatSearch] = useState("");
  const [showCompanyCabinet, setShowCompanyCabinet] = useState(false);
  const [showAdminUsersPage, setShowAdminUsersPage] = useState(false);
  const [adminOrgName, setAdminOrgName] = useState("");
  const [adminPanelMsg, setAdminPanelMsg] = useState("");
  const [adminNewEmail, setAdminNewEmail] = useState("");
  const [adminNewPassword, setAdminNewPassword] = useState("");
  const [adminNewFullName, setAdminNewFullName] = useState("");
  const [adminNewRole, setAdminNewRole] = useState<"owner" | "admin" | "manager" | "employee" | "guest">("employee");
  const [showUserCabinet, setShowUserCabinet] = useState(false);
  const [companyTab, setCompanyTab] = useState<"employees" | "invites" | "settings" | "admin">("employees");
  const [companyUserQuery, setCompanyUserQuery] = useState("");
  const [companyRoleFilter, setCompanyRoleFilter] = useState<"all" | "owner" | "admin" | "manager" | "employee" | "guest">("all");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"owner" | "admin" | "manager" | "employee" | "guest">("employee");
  const [inviteDepartment, setInviteDepartment] = useState("");
  const [inviteHistory, setInviteHistory] = useState<
    { id: string; email: string; role: "owner" | "admin" | "manager" | "employee" | "guest"; inviteToken?: string | null }[]
  >([]);
  const [organizationInvites, setOrganizationInvites] = useState<
    {
      id: string;
      email: string;
      role: "owner" | "admin" | "manager" | "employee" | "guest";
      department?: string | null;
      createdAt?: string | null;
      expiresAt?: string | null;
      acceptedAt?: string | null;
      revokedAt?: string | null;
    }[]
  >([]);
  const [inviteDbQuery, setInviteDbQuery] = useState("");
  const [inviteDbRoleFilter, setInviteDbRoleFilter] = useState<"all" | "owner" | "admin" | "manager" | "employee" | "guest">("all");
  const [inviteDbStatusFilter, setInviteDbStatusFilter] = useState<"all" | "active" | "accepted" | "revoked" | "expired">("all");
  const [inviteDbPage, setInviteDbPage] = useState(0);
  const [inviteDbPageSize, setInviteDbPageSize] = useState(20);
  const [companyActionMsg, setCompanyActionMsg] = useState("");
  const [adminCreateEmail, setAdminCreateEmail] = useState("");
  const [adminCreateFullName, setAdminCreateFullName] = useState("");
  const [adminCreatePassword, setAdminCreatePassword] = useState("");
  const [adminCreateRole, setAdminCreateRole] = useState<"owner" | "admin" | "manager" | "employee" | "guest">("employee");
  const [orgNameInput, setOrgNameInput] = useState("");
  const [orgLogoInput, setOrgLogoInput] = useState("");
  const [orgRetentionDaysInput, setOrgRetentionDaysInput] = useState("");
  const [orgMaxFileSizeMbInput, setOrgMaxFileSizeMbInput] = useState("");
  const [chatPreviewByKey, setChatPreviewByKey] = useState<Record<string, { text: string; at: string }>>({});
  const [chatError, setChatError] = useState("");
  const [myProfileId, setMyProfileId] = useState("");
  const [myProfileEmail, setMyProfileEmail] = useState("");
  const [profileFirstName, setProfileFirstName] = useState("");
  const [profileLastName, setProfileLastName] = useState("");
  const [profileAvatarUrl, setProfileAvatarUrl] = useState("");
  const [profileStatusText, setProfileStatusText] = useState("");
  const [profileTitle, setProfileTitle] = useState("");
  const [profileDepartment, setProfileDepartment] = useState("");
  const [profileMsg, setProfileMsg] = useState("");
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [stickerCatalog, setStickerCatalog] = useState(defaultStickerCatalog);
  const [installedStickerPackIds, setInstalledStickerPackIds] = useState<string[]>([]);
  const [activeStickerPackId, setActiveStickerPackId] = useState(defaultStickerCatalog[0].id);
  const [unreadByKey, setUnreadByKey] = useState<Record<string, number>>({});
  const [pinnedChatByKey, setPinnedChatByKey] = useState<Record<string, boolean>>({});
  const [pinnedOrderByKey, setPinnedOrderByKey] = useState<Record<string, number>>({});
  const [dragPinnedKey, setDragPinnedKey] = useState<string>("");
  const [dragOverPinnedKey, setDragOverPinnedKey] = useState<string>("");
  const [mutedChatByKey, setMutedChatByKey] = useState<Record<string, boolean>>({});
  const [archivedChatByKey, setArchivedChatByKey] = useState<Record<string, boolean>>({});
  const [chatFolder, setChatFolder] = useState<"all" | "unread" | "archived">("all");
  const [chatMenu, setChatMenu] = useState<null | { x: number; y: number; key: string }>(null);
  const [msgMenu, setMsgMenu] = useState<null | { x: number; y: number; messageId: string }>(null);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [voiceHoldMs, setVoiceHoldMs] = useState(0);
  const [users, setUsers] = useState<
    {
      id: string;
      email: string;
        role?: "owner" | "admin" | "manager" | "employee" | "guest" | null;
      department?: string | null;
      status?: string | null;
      lastSeen?: string | null;
    }[]
  >([]);
  const companyUsersFiltered = useMemo(() => {
    const q = companyUserQuery.trim().toLowerCase();
    return users.filter((u) => {
      const roleOk = companyRoleFilter === "all" ? true : (u.role ?? "employee") === companyRoleFilter;
      const textOk = !q ? true : `${u.email} ${u.department ?? ""}`.toLowerCase().includes(q);
      return roleOk && textOk;
    });
  }, [users, companyUserQuery, companyRoleFilter]);

  const newThingWizardUsers = useMemo(() => {
    const q = wizardUserQuery.trim().toLowerCase();
    return users
      .filter((u) => u.id !== userId)
      .filter((u) => !q || `${u.email} ${u.department ?? ""}`.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => a.email.localeCompare(b.email));
  }, [users, userId, wizardUserQuery]);

  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, { status: string; lastSeen?: string }>>({});
  const isCompanyAdmin = viewerRole === "owner" || viewerRole === "admin";
  const canEditOrgFields = viewerRole === "owner" || viewerRole === "admin" || viewerRole === "manager";
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
  const canReadChats = ["owner", "admin", "manager", "employee", "guest"].includes(viewerRole);
  const canWriteChats = ["owner", "admin", "manager", "employee"].includes(viewerRole);
  const canCreateChannelsAndGroups = ["owner", "admin", "manager", "employee"].includes(viewerRole);
  const canStartCalls = ["owner", "admin", "manager", "employee"].includes(viewerRole);

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

  const activeChannel = useMemo(() => channels.find((c) => c.id === activeChannelId), [channels, activeChannelId]);
  const activeGroupChat = useMemo(() => groupChats.find((g) => g.id === activeGroupChatId), [groupChats, activeGroupChatId]);
  const activeDirectChat = useMemo(() => directChats.find((d) => d.id === activeDirectChatId), [directChats, activeDirectChatId]);

  function initials(s: string) {
    const v = (s || "").trim();
    if (!v) return "?";
    const parts = v.split(/[\s@._-]+/g).filter(Boolean);
    const a = parts[0]?.[0] ?? v[0];
    const b = parts[1]?.[0] ?? "";
    return (a + b).toUpperCase().slice(0, 2);
  }

  const chatSearchQ = chatSearch.trim().toLowerCase();
  const filteredChannels = useMemo(
    () => (chatSearchQ ? channels.filter((c) => (`#${c.name}`).toLowerCase().includes(chatSearchQ)) : channels),
    [channels, chatSearchQ],
  );
  const filteredGroups = useMemo(
    () => (chatSearchQ ? groupChats.filter((g) => g.name.toLowerCase().includes(chatSearchQ)) : groupChats),
    [groupChats, chatSearchQ],
  );
  const filteredDMs = useMemo(() => {
    if (!chatSearchQ) return directChats;
    return directChats.filter((d) => {
      const otherId = d.userIds.find((id) => id !== userId) ?? d.userIds[0] ?? "";
      const u = users.find((x) => x.id === otherId);
      const title = u?.email ?? otherId ?? d.id;
      return title.toLowerCase().includes(chatSearchQ);
    });
  }, [directChats, users, userId, chatSearchQ]);

  function chatKeyFor(kind: "c" | "g" | "d", id: string) {
    return `${kind}:${id}`;
  }

  function unreadFor(key: string) {
    return unreadByKey[key] ?? 0;
  }
  function isPinned(key: string) {
    return !!pinnedChatByKey[key];
  }
  function isMuted(key: string) {
    return !!mutedChatByKey[key];
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
  function toggleMute(key: string) {
    setMutedChatByKey((prev) => ({ ...prev, [key]: !prev[key] }));
  }
  function isArchived(key: string) {
    return !!archivedChatByKey[key];
  }
  function toggleArchive(key: string) {
    setArchivedChatByKey((prev) => ({ ...prev, [key]: !prev[key] }));
  }
  function movePinned(key: string, dir: -1 | 1) {
    const pinnedKeys = Object.keys(pinnedChatByKey).filter((k) => pinnedChatByKey[k]);
    const list = pinnedKeys
      .map((k) => ({ k, o: pinnedOrderByKey[k] ?? 999999 }))
      .sort((a, b) => a.o - b.o)
      .map((x) => x.k);
    const i = list.indexOf(key);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const next: Record<string, number> = {};
    list.forEach((k, idx) => {
      next[k] = idx + 1;
    });
    setPinnedOrderByKey((prev) => ({ ...prev, ...next }));
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

  const orderedChannels = useMemo(
    () =>
      [...filteredChannels].sort((a, b) => {
        const ka = chatKeyFor("c", a.id);
        const kb = chatKeyFor("c", b.id);
        const pinDiff = Number(!!pinnedChatByKey[kb]) - Number(!!pinnedChatByKey[ka]);
        if (pinDiff !== 0) return pinDiff;
        const ao = pinnedOrderByKey[ka] ?? 999999;
        const bo = pinnedOrderByKey[kb] ?? 999999;
        return ao - bo;
      }).filter((c) => includeByFolder(chatKeyFor("c", c.id))),
    [filteredChannels, pinnedChatByKey, pinnedOrderByKey, archivedChatByKey, unreadByKey, chatFolder],
  );
  const orderedGroups = useMemo(
    () =>
      [...filteredGroups].sort((a, b) => {
        const ka = chatKeyFor("g", a.id);
        const kb = chatKeyFor("g", b.id);
        const pinDiff = Number(!!pinnedChatByKey[kb]) - Number(!!pinnedChatByKey[ka]);
        if (pinDiff !== 0) return pinDiff;
        const ao = pinnedOrderByKey[ka] ?? 999999;
        const bo = pinnedOrderByKey[kb] ?? 999999;
        return ao - bo;
      }).filter((g) => includeByFolder(chatKeyFor("g", g.id))),
    [filteredGroups, pinnedChatByKey, pinnedOrderByKey, archivedChatByKey, unreadByKey, chatFolder],
  );
  const orderedDMs = useMemo(
    () =>
      [...filteredDMs].sort((a, b) => {
        const ka = chatKeyFor("d", a.id);
        const kb = chatKeyFor("d", b.id);
        const pinDiff = Number(!!pinnedChatByKey[kb]) - Number(!!pinnedChatByKey[ka]);
        if (pinDiff !== 0) return pinDiff;
        const ao = pinnedOrderByKey[ka] ?? 999999;
        const bo = pinnedOrderByKey[kb] ?? 999999;
        return ao - bo;
      }).filter((d) => includeByFolder(chatKeyFor("d", d.id))),
    [filteredDMs, pinnedChatByKey, pinnedOrderByKey, archivedChatByKey, unreadByKey, chatFolder],
  );

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
    return u?.email ?? userId;
  }

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
  }, [messages.length, mode, activeChannelId, activeGroupChatId, activeDirectChatId, threadRootId, showPins, showSaved, showGlobalResult]);

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
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const typingRef = useRef<{ started: boolean; stopTimerId: number | null }>({ started: false, stopTimerId: null });
  const localFileMessageIdByFileIdRef = useRef(new Map<string, string>());
  const fileStatusWaitersRef = useRef(
    new Map<string, { resolve: () => void; reject: (e: Error) => void; timeoutId: number }>(),
  );
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<BlobPart[]>([]);
  const voiceStartAtRef = useRef<number>(0);
  const voiceTouchActiveRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesWrapRef = useRef<HTMLDivElement | null>(null);
  const chatSearchRef = useRef<HTMLInputElement | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const stickToBottomRef = useRef(true);

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
      if (k === "end" && !showGlobalResult && !showSaved && !showPins) {
        stickToBottomRef.current = true;
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showGlobalResult, showSaved, showPins]);

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

  async function fillSeedInfo() {
    setAuthError("");
    try {
      const res = await fetch(`${API_BASE}/playground-ru/seed-info`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Seed not found");
      const orgId = String(data.organizationId || "");
      setOrganizationId(orgId);
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
      setWorkspaceId(data.workspaceId || "");
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "Seed request failed");
      setAuthError(`Seed ID не получен: ${msg}`);
    }
  }

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

  async function runGlobalSearch() {
    if (!token) return;
    const q = globalQuery.trim();
    if (!q) return;
    const data = await gql<{ globalSearch: GlobalSearchResult }>(
      `query($query: String!) {
        globalSearch(query: $query) {
          users { id email firstName lastName }
          channels { id name workspaceId type }
          messages { id channelId groupChatId directChatId content createdAt type author { email } }
          files { id url }
        }
      }`,
      { query: q },
      token,
    );
    setGlobalResult(data.globalSearch);
    setShowGlobalResult(true);
    pushLog(
      `Поиск "${q}": users=${data.globalSearch.users.length} channels=${data.globalSearch.channels.length} messages=${data.globalSearch.messages.length} files=${data.globalSearch.files.length}`,
    );
  }

  useEffect(() => {
    if (!token) return;
    void refreshSavedIds();
  }, [token]);

  useEffect(() => {
    try {
      const p = localStorage.getItem("tg:pinnedChats");
      const po = localStorage.getItem("tg:pinnedOrder");
      const m = localStorage.getItem("tg:mutedChats");
      const a = localStorage.getItem("tg:archivedChats");
      if (p) setPinnedChatByKey(JSON.parse(p));
      if (po) setPinnedOrderByKey(JSON.parse(po));
      if (m) setMutedChatByKey(JSON.parse(m));
      if (a) setArchivedChatByKey(JSON.parse(a));
    } catch {
      // ignore
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("tg:pinnedChats", JSON.stringify(pinnedChatByKey));
      localStorage.setItem("tg:pinnedOrder", JSON.stringify(pinnedOrderByKey));
      localStorage.setItem("tg:mutedChats", JSON.stringify(mutedChatByKey));
      localStorage.setItem("tg:archivedChats", JSON.stringify(archivedChatByKey));
    } catch {
      // ignore
    }
  }, [pinnedChatByKey, pinnedOrderByKey, mutedChatByKey, archivedChatByKey]);

  useEffect(() => {
    if (authMode !== "user") return;
    const t = window.setTimeout(() => {
      void resolveSeedOrgForEmail(email);
    }, 250);
    return () => window.clearTimeout(t);
  }, [authMode, email]);

  async function loadSavedMessages() {
    if (!token) return;
    const data = await gql<{ savedMessages: Message[] }>(
      `query($limit: Int!) {
        savedMessages(limit: $limit) {
          id content createdAt editedAt isDeleted type parentMessageId author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl }
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
          id content createdAt editedAt isDeleted type parentMessageId author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl }
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

  async function goToSearchMessage(m: GlobalSearchResult["messages"][number]) {
    if (m.channelId) {
      setMode("channels");
      setActiveChannelId(m.channelId);
      await loadMessages(m.channelId);
      return;
    }
    if (m.groupChatId) {
      setMode("groups");
      setActiveGroupChatId(m.groupChatId);
      await loadGroupMessages(m.groupChatId);
      return;
    }
    if (m.directChatId) {
      setMode("dms");
      setActiveDirectChatId(m.directChatId);
      await loadDirectMessages(m.directChatId);
    }
  }

  async function login(e?: FormEvent) {
    e?.preventDefault();
    try {
      setAuthError("");
      let orgId = organizationId.trim();
      if (authMode === "admin") {
        const code = organizationCode.trim().toUpperCase();
        if (!/^ID\d{6}$/.test(code)) {
          throw new Error("Organization ID должен быть в формате: ID000015");
        }
        try {
          const rawCodeMap = localStorage.getItem("tg:orgCodeBindings");
          const codeMap = rawCodeMap ? (JSON.parse(rawCodeMap) as Record<string, string>) : {};
          orgId = String(codeMap[code] || "");
        } catch {
          orgId = "";
        }
        if (!orgId) {
          throw new Error("Organization ID не найден по коду. Нажмите 'Заполнить seed ID' для привязки.");
        }
      }
      // User mode hides Organization ID: try to reuse existing value or fetch seed org in dev.
      if (!orgId && authMode === "user") {
        try {
          const seedRes = await fetch(`${API_BASE}/playground-ru/seed-info`);
          const seedData = await seedRes.json();
          if (seedRes.ok && seedData?.organizationId) {
            orgId = String(seedData.organizationId);
            setOrganizationId(orgId);
            if (seedData?.workspaceId) setWorkspaceId(String(seedData.workspaceId));
          }
        } catch {
          // ignore and fail below with explicit message
        }
      }
      if (!orgId) throw new Error("Organization ID не указан. Для пользователя привязка к seed не найдена, проверьте email.");
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, organizationId: orgId }),
      });
      const data = (await res.json()) as LoginResult | { error: string };
      if (!res.ok || "error" in data) throw new Error((data as any).error || "Login failed");
      setToken(data.accessToken);
      setUserId(data.viewer.userId);
      setViewerRole((data.viewer.role as any) ?? "");
      pushLog("Успешный вход.");
      // Auto-load users for presence mapping
      try {
        await loadUsers(data.accessToken, orgId);
      } catch {
        // ignore
      }
    } catch (e: any) {
      let msg = String(e?.message ?? e ?? "Login failed");
      if (msg === "Failed to fetch") {
        msg =
          "Не удалось связаться с сервером (сеть / CORS / прокси). Проверьте, что backend запущен, в .env CLIENT_URL совпадает с адресом сайта (можно несколько через запятую), а Nginx проксирует /auth/ и /graphql.";
      }
      setAuthError(`Ошибка входа: ${msg}`);
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
    setMessages([]);
    setChannels([]);
    setGroupChats([]);
    setDirectChats([]);
    setActiveChannelId("");
    setActiveGroupChatId("");
    setActiveDirectChatId("");
    setTypingUserIds([]);
    setShowGlobalResult(false);
    setGlobalResult(null);
    setShowSaved(false);
    setShowPins(false);
    cancelForwardSelect();
    setShowLogs(false);
    setShowDev(false);
    pushLog("Выход выполнен.");
  }

  function connectSocket() {
    if (!token) return;
    if (socket) socket.disconnect();
    const s = io(SOCKET_URL, { auth: { token } });
    s.on("server:hello", () => pushLog("Socket подключен."));
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
        author: { email: String(m.author?.email ?? "user") },
        type: m.type,
        parentMessageId: m.parentMessageId ?? null,
        file: m.file ?? null,
        reactions: Array.isArray(m.reactions) ? m.reactions : [],
      };

      // Update chat list preview for this chat
      if (key) {
        const p = previewForMessages([msg]);
        setChatPreviewByKey((prev) => ({ ...prev, [key]: p }));
      }

      const isActive =
        (mode === "channels" && channelId && channelId === activeChannelId) ||
        (mode === "groups" && groupChatId && groupChatId === activeGroupChatId) ||
        (mode === "dms" && directChatId && directChatId === activeDirectChatId);

      if (!isActive) {
        if (key) {
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
      setMessages((prev) => [...prev, msg]);
    });
    s.on("message:update", (m: any) => {
      const id = String(m?.id ?? "");
      if (!id) return;
      setMessages((prev) =>
        prev.map((x) =>
          x.id === id
            ? {
                ...x,
                content: String(m.content ?? ""),
                type: m.type ?? x.type,
                parentMessageId: m.parentMessageId ?? x.parentMessageId ?? null,
                file: m.file ?? x.file ?? null,
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
      if (!typingId || typingId === userId) return;
      if (mode === "channels" && String(evt?.channelId ?? "") !== activeChannelId) return;
      if (mode === "groups" && String(evt?.groupChatId ?? "") !== activeGroupChatId) return;
      if (mode === "dms" && String(evt?.directChatId ?? "") !== activeDirectChatId) return;
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

      const waiter = fileId ? fileStatusWaitersRef.current.get(fileId) : undefined;
      if (!waiter) return;
      if (status === "clean") {
        clearTimeout(waiter.timeoutId);
        fileStatusWaitersRef.current.delete(fileId);
        waiter.resolve();
      } else if (status === "infected" || status === "blocked" || status === "error") {
        const reason = evt?.blockedReason ? ` (${String(evt.blockedReason)})` : "";
        clearTimeout(waiter.timeoutId);
        fileStatusWaitersRef.current.delete(fileId);
        waiter.reject(new Error(`Файл не прошел проверку: ${status}${reason}`));
      }
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
      `query($workspaceId: ID!) { channels(workspaceId: $workspaceId) { id workspaceId name type } }`,
      { workspaceId },
      token,
    );
    setChannels(data.channels);
    if (data.channels[0]) setActiveChannelId(data.channels[0].id);
    pushLog(`Каналов: ${data.channels.length}`);
  }

  async function loadGroupChats() {
    if (!token) return;
    const data = await gql<{ groupChats: GroupChat[] }>(`query { groupChats { id name memberIds } }`, {}, token);
    setGroupChats(data.groupChats);
    if (data.groupChats[0]) setActiveGroupChatId(data.groupChats[0].id);
    pushLog(`Групп: ${data.groupChats.length}`);
  }

  async function loadDirectChats() {
    if (!token) return;
    const data = await gql<{ dms: DirectChat[] }>(`query { dms { id userIds } }`, {}, token);
    setDirectChats(data.dms);
    if (data.dms[0]) setActiveDirectChatId(data.dms[0].id);
    pushLog(`DM: ${data.dms.length}`);
  }

  async function openChatFromList(raw: string) {
    const value = String(raw || "");
    if (!value) return;
    const [kind, id] = value.split(":");
    if (!id) return;
    if (kind === "c") {
      setMode("channels");
      setActiveChannelId(id);
      setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("c", id)]: 0 }));
      await loadMessages(id);
      return;
    }
    if (kind === "g") {
      setMode("groups");
      setActiveGroupChatId(id);
      setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("g", id)]: 0 }));
      await loadGroupMessages(id);
      return;
    }
    if (kind === "d") {
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
      const otherUserId = activeDirectChat.userIds.find((id) => id !== userId) ?? "";
      if (!otherUserId) return;
      const data = await gql<{ sendDirectMessage: DirectChatMessage }>(
        `mutation($userId: ID!, $content: String!) {
          sendDirectMessage(input: { userId: $userId, content: $content }) { id content createdAt author { email } type directChatId }
        }`,
        { userId: otherUserId, content },
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

  async function startAudioCall() {
    if (!canStartCalls) {
      setChatError("Недостаточно прав для звонков");
      return;
    }
    const room = `sf-call-${Date.now()}`;
    const link = `https://meet.jit.si/${room}`;
    await sendServiceMessageToCurrentChat(`📞 Созвон: ${link}`);
    window.open(link, "_blank", "noopener,noreferrer");
    pushLog(`Созвон создан: ${room}`);
  }

  async function startVideoMeeting() {
    if (!canStartCalls) {
      setChatError("Недостаточно прав для видео встреч");
      return;
    }
    const room = `sf-video-${Date.now()}`;
    const link = `https://meet.jit.si/${room}#config.startWithVideoMuted=false`;
    await sendServiceMessageToCurrentChat(`🎥 Видеовстреча: ${link}`);
    window.open(link, "_blank", "noopener,noreferrer");
    pushLog(`Видеовстреча создана: ${room}`);
  }

  async function loadUsers(tokenOverride?: string, orgIdOverride?: string) {
    const t = tokenOverride ?? token;
    const orgId = orgIdOverride ?? organizationId;
    if (!t || !orgId) return;
    const data = await gql<{
      users: {
        id: string;
        email: string;
        role?: "owner" | "admin" | "manager" | "employee" | "guest" | null;
        department?: string | null;
        status?: string | null;
        lastSeen?: string | null;
      }[];
    }>(
      `query($organizationId: ID!) { users(organizationId: $organizationId) { id email role department status lastSeen } }`,
      { organizationId: orgId },
      t,
    );
    setUsers(data.users);
    pushLog(`Пользователей: ${data.users.length}`);
  }

  async function loadMyProfile() {
    if (!token) return;
    const data = await gql<{
      me: {
        id: string;
        email: string;
        firstName?: string | null;
        lastName?: string | null;
        avatarUrl?: string | null;
        statusText?: string | null;
        title?: string | null;
        department?: string | null;
        role?: string | null;
      };
    }>(
      `query {
        me {
          id
          email
          firstName
          lastName
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
    setProfileAvatarUrl(data.me.avatarUrl || "");
    setProfileStatusText(data.me.statusText || "");
    setProfileTitle(data.me.title || "");
    setProfileDepartment(data.me.department || "");
    setViewerRole((data.me.role as any) ?? viewerRole);
  }

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
    if (profileAvatarUrl.trim()) input.avatarUrl = profileAvatarUrl.trim();
    if (profileStatusText.trim()) input.statusText = profileStatusText.trim();
    if (canEditOrgFields && profileTitle.trim()) input.title = profileTitle.trim();
    if (canEditOrgFields && profileDepartment.trim()) input.department = profileDepartment.trim();
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
    if (!newThingWizardKind || pickId === userId) return;
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

  async function inviteCompanyUser() {
    if (!token || !organizationId || !inviteEmail.trim()) return;
    setCompanyActionMsg("");
    const data = await gql<{ inviteUser: { id: string; email: string; role: string; inviteToken?: string | null } }>(
      `mutation($input: InviteUserInput!) {
        inviteUser(input: $input) { id email role inviteToken }
      }`,
      {
        input: {
          organizationId,
          email: inviteEmail.trim().toLowerCase(),
          role: inviteRole,
          department: inviteDepartment.trim() || null,
        },
      },
      token,
    );
    setCompanyActionMsg(
      `Приглашение отправлено: ${data.inviteUser.email} (${data.inviteUser.role})` +
        (data.inviteUser.inviteToken ? `, token: ${data.inviteUser.inviteToken}` : ""),
    );
    setInviteHistory((prev) => [{ ...data.inviteUser, role: data.inviteUser.role as "owner" | "admin" | "manager" | "employee" | "guest" }, ...prev].slice(0, 20));
    setInviteEmail("");
    setInviteDepartment("");
    await loadUsers();
    await loadOrganizationInvites();
  }

  async function createCompanyUser(input: {
    email: string;
    fullName: string;
    password: string;
    role: "owner" | "admin" | "manager" | "employee" | "guest";
  }) {
    if (!token || !organizationId) throw new Error("Нет organizationId или токена");
    // Используем тот же backend-путь, что и вкладка Инвайтов: inviteUser.
    const emailLower = input.email.trim().toLowerCase();
    const mutation = `mutation($input: InviteUserInput!) { inviteUser(input: $input) { id email inviteToken } }`;

    // В разных версиях backend роль могла быть несовместима.
    // Самый надежный вариант — сначала без role (пусть сервер возьмёт дефолт), потом с role из UI.
    let data: { inviteUser: { id: string; email: string; inviteToken?: string | null } } | null = null;
    try {
      data = await gql<{ inviteUser: { id: string; email: string; inviteToken?: string | null } }>(
        mutation,
        { input: { organizationId, email: emailLower } },
        token,
      );
    } catch (e1: any) {
      data = await gql<{ inviteUser: { id: string; email: string; inviteToken?: string | null } }>(
        mutation,
        { input: { organizationId, email: emailLower, role: input.role } },
        token,
      );
    }
    return { createOrganizationUser: { id: data.inviteUser.id, email: data.inviteUser.email } };
  }

  async function createCompanyUserSingle() {
    if (!isCompanyAdmin) {
      setCompanyActionMsg("Только owner/admin могут добавлять сотрудников");
      return;
    }
    const emailV = adminCreateEmail.trim().toLowerCase();
    const fullNameV = adminCreateFullName.trim();
    if (!emailV || !adminCreatePassword.trim()) {
      setCompanyActionMsg("Заполните email и пароль");
      return;
    }
    try {
      setCompanyActionMsg("Создание пользователя…");
      await createCompanyUser({
        email: emailV,
        fullName: fullNameV,
        password: adminCreatePassword.trim(),
        role: adminCreateRole,
      });
      setCompanyActionMsg(`Сотрудник добавлен: ${emailV}. Если пароль не применился, сотруднику уйдет инвайт для завершения регистрации.`);
      setAdminCreateEmail("");
      setAdminCreateFullName("");
      setAdminCreatePassword("");
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
      const fullNameV = String(row.fullName ?? row.fio ?? row["ФИО"] ?? row["фио"] ?? "").trim();
      const passwordV = String(row.password ?? row.Password ?? row["пароль"] ?? "").trim();
      const roleRaw = String(row.role ?? row.Role ?? "employee").trim().toLowerCase();
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
        await createCompanyUser({ email: emailV, fullName: fullNameV, password: passwordV, role: roleV });
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setCompanyActionMsg(`Импорт завершен. Успешно: ${ok}, с ошибками: ${fail}`);
    await loadUsers();
  }

  async function revokeCompanyInvite(inviteId: string) {
    if (!token || !organizationId || !inviteId) return;
    await gql<{ revokeInvite: boolean }>(
      `mutation($input: RevokeInviteInput!) { revokeInvite(input: $input) }`,
      { input: { organizationId, inviteId } },
      token,
    );
    setInviteHistory((prev) => prev.filter((x) => x.id !== inviteId));
    setCompanyActionMsg("Инвайт отозван");
    await loadOrganizationInvites();
  }

  async function loadOrganizationInvites(pageOverride?: number, pageSizeOverride?: number) {
    if (!token || !organizationId) return;
    const page = pageOverride ?? inviteDbPage;
    const pageSize = pageSizeOverride ?? inviteDbPageSize;
    const data = await gql<{
      organizationInvites: {
        id: string;
        email: string;
        role: "owner" | "admin" | "manager" | "employee" | "guest";
        department?: string | null;
        createdAt?: string | null;
        expiresAt?: string | null;
        acceptedAt?: string | null;
        revokedAt?: string | null;
      }[];
    }>(
      `query($organizationId: ID!, $role: OrgRole, $status: InviteStatus, $query: String, $limit: Int, $offset: Int) {
        organizationInvites(organizationId: $organizationId, role: $role, status: $status, query: $query, limit: $limit, offset: $offset) {
          id
          email
          role
          department
          createdAt
          expiresAt
          acceptedAt
          revokedAt
        }
      }`,
      {
        organizationId,
        role: inviteDbRoleFilter === "all" ? null : inviteDbRoleFilter,
        status: inviteDbStatusFilter === "all" ? null : inviteDbStatusFilter,
        query: inviteDbQuery.trim() || null,
        limit: pageSize,
        offset: page * pageSize,
      },
      token,
    );
    setOrganizationInvites(data.organizationInvites);
  }

  function exportOrganizationInvitesCsv() {
    const rows = organizationInvites;
    const header = ["id", "email", "role", "department", "createdAt", "expiresAt", "acceptedAt", "revokedAt", "status"];
    const now = Date.now();
    const statusOf = (inv: (typeof rows)[number]) => {
      if (inv.acceptedAt) return "accepted";
      if (inv.revokedAt) return "revoked";
      if (inv.expiresAt && new Date(inv.expiresAt).getTime() < now) return "expired";
      return "active";
    };
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [header.join(",")].concat(
      rows.map((inv) =>
        [
          esc(inv.id),
          esc(inv.email),
          esc(inv.role),
          esc(inv.department ?? ""),
          esc(inv.createdAt ?? ""),
          esc(inv.expiresAt ?? ""),
          esc(inv.acceptedAt ?? ""),
          esc(inv.revokedAt ?? ""),
          esc(statusOf(inv)),
        ].join(","),
      ),
    );
    const blob = new Blob([`\uFEFF${lines.join("\n")}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `organization-invites-page-${inviteDbPage + 1}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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

  async function saveCompanySettings() {
    if (!token || !organizationId) return;
    const retentionDays = orgRetentionDaysInput.trim() ? Number(orgRetentionDaysInput.trim()) : null;
    const maxFileSizeMb = orgMaxFileSizeMbInput.trim() ? Number(orgMaxFileSizeMbInput.trim()) : null;
    if (retentionDays !== null && (!Number.isFinite(retentionDays) || retentionDays < 1)) {
      setCompanyActionMsg("retentionDays должен быть положительным числом");
      return;
    }
    if (maxFileSizeMb !== null && (!Number.isFinite(maxFileSizeMb) || maxFileSizeMb < 1)) {
      setCompanyActionMsg("maxFileSizeMb должен быть положительным числом");
      return;
    }
    const data = await gql<{
      updateOrganizationSettings: {
        id: string;
        name: string;
        logoUrl?: string | null;
        settings?: { retentionDays?: number; maxFileSizeMb?: number } | null;
      };
    }>(
      `mutation($input: UpdateOrganizationSettingsInput!) {
        updateOrganizationSettings(input: $input) {
          id
          name
          logoUrl
          settings
        }
      }`,
      {
        input: {
          organizationId,
          name: orgNameInput.trim() || null,
          logoUrl: orgLogoInput.trim() || null,
          settings: {
            retentionDays: retentionDays ?? undefined,
            maxFileSizeMb: maxFileSizeMb ?? undefined,
          },
        },
      },
      token,
    );
    const org = data.updateOrganizationSettings;
    setOrgNameInput(org.name || "");
    setOrgLogoInput(org.logoUrl || "");
    setOrgRetentionDaysInput(
      org.settings?.retentionDays !== undefined && org.settings?.retentionDays !== null ? String(org.settings.retentionDays) : "",
    );
    setOrgMaxFileSizeMbInput(
      org.settings?.maxFileSizeMb !== undefined && org.settings?.maxFileSizeMb !== null ? String(org.settings.maxFileSizeMb) : "",
    );
    setCompanyActionMsg("Настройки компании сохранены");
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
    if (showAdminUsersPage) setAdminPanelMsg("Пользователь деактивирован.");
    await loadUsers();
  }

  async function loadAdminOrganizationName() {
    if (!token || !organizationId) return;
    const data = await gql<{ organization: { id: string; name: string } }>(
      `query($organizationId: ID!) { organization(organizationId: $organizationId) { id name } }`,
      { organizationId },
      token,
    );
    setAdminOrgName(data.organization.name);
  }

  function openAdminUsersPanel() {
    if (!isCompanyAdmin) return;
    setShowAdminUsersPage(true);
    setAdminPanelMsg("");
    void (async () => {
      try {
        await loadAdminOrganizationName();
        await loadUsers();
      } catch (e: unknown) {
        setAdminPanelMsg(e instanceof Error ? e.message : String(e));
      }
    })();
  }

  async function adminPanelCreateUser(e: FormEvent) {
    e.preventDefault();
    if (!isCompanyAdmin || !token || !organizationId) return;
    const em = adminNewEmail.trim().toLowerCase();
    const pw = adminNewPassword.trim();
    if (!em || pw.length < 8) {
      setAdminPanelMsg("Укажите email и пароль не короче 8 символов.");
      return;
    }
    setAdminPanelMsg("Создание…");
    try {
      await gql<{
        createOrganizationUser: { id: string; email: string; role: string };
      }>(
        `mutation($input: CreateOrganizationUserInput!) {
          createOrganizationUser(input: $input) { id email role department title }
        }`,
        {
          input: {
            organizationId,
            email: em,
            password: pw,
            fullName: adminNewFullName.trim() || undefined,
            role: adminNewRole,
            department: undefined,
          },
        },
        token,
      );
      setAdminNewEmail("");
      setAdminNewPassword("");
      setAdminNewFullName("");
      setAdminPanelMsg(`Пользователь создан: ${em}`);
      await loadUsers();
    } catch (err: unknown) {
      setAdminPanelMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function adminPanelSetPassword(targetUserId: string) {
    if (!isCompanyAdmin || !token || !organizationId) return;
    const pw = window.prompt("Новый пароль пользователя (минимум 8 символов)?");
    if (!pw || pw.length < 8) {
      if (pw) setAdminPanelMsg("Пароль слишком короткий.");
      return;
    }
    try {
      await gql<{ setUserPassword: boolean }>(
        `mutation($input: SetUserPasswordInput!) { setUserPassword(input: $input) }`,
        { input: { organizationId, userId: targetUserId, password: pw } },
        token,
      );
      setAdminPanelMsg("Пароль обновлён.");
    } catch (err: unknown) {
      setAdminPanelMsg(err instanceof Error ? err.message : String(err));
    }
  }

  function openChatMenu(e: MouseEvent, key: string) {
    e.preventDefault();
    const menuW = 240;
    const menuH = 210;
    const pad = 8;
    const x = Math.max(pad, Math.min(e.clientX, window.innerWidth - menuW - pad));
    const y = Math.max(pad, Math.min(e.clientY, window.innerHeight - menuH - pad));
    setChatMenu({ x, y, key });
  }

  async function loadMessages(channelId: string) {
    if (!token || !channelId) return;
    const data = await gql<{ messages: { items: Message[] } }>(
      `query($channelId: ID!, $limit: Int!) {
        messages(channelId: $channelId, limit: $limit) {
          items { id content createdAt editedAt isDeleted type parentMessageId author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl } }
        }
      }`,
      { channelId, limit: 50 },
      token,
    );
    setMessages(data.messages.items);
    const p = previewForMessages(data.messages.items);
    setChatPreviewByKey((prev) => ({ ...prev, [chatKeyFor("c", channelId)]: p }));
    socket?.emit("channel:join", { channelId });
  }

  async function loadGroupMessages(groupChatId: string) {
    if (!token || !groupChatId) return;
    const data = await gql<{ groupChatMessages: Message[] }>(
      `query($groupChatId: ID!, $limit: Int!) {
        groupChatMessages(groupChatId: $groupChatId, limit: $limit) {
          id content createdAt editedAt isDeleted type parentMessageId author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl }
        }
      }`,
      { groupChatId, limit: 200 },
      token,
    );
    setMessages(data.groupChatMessages);
    const p = previewForMessages(data.groupChatMessages);
    setChatPreviewByKey((prev) => ({ ...prev, [chatKeyFor("g", groupChatId)]: p }));
    socket?.emit("group:join", { groupChatId });
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
          editedAt
          type
          parentMessageId
          author { email }
          reactions { emoji count viewerHasReacted }
          file { id originalName mimeType size downloadUrl }
        }
      }`,
      { directChatId, limit: 200 },
      token,
    );
    const mapped = data.directChatMessages.map((m) => ({
        id: m.id,
        content: m.content,
        createdAt: m.createdAt,
      editedAt: (m as any).editedAt ?? null,
        author: { email: m.author.email },
        type: m.type,
        reactions: m.reactions ?? [],
        file: m.file ?? null,
        parentMessageId: m.parentMessageId ?? null,
      }));
    setMessages(mapped);
    const p = previewForMessages(mapped);
    setChatPreviewByKey((prev) => ({ ...prev, [chatKeyFor("d", directChatId)]: p }));
    socket?.emit("dm:join", { directChatId });
  }

  async function openThread(parentMessageId: string) {
    if (!token) return;
    const data = await gql<{ thread: Message[] }>(
      `query($parentMessageId: ID!, $limit: Int!) {
        thread(parentMessageId: $parentMessageId, limit: $limit) {
          id content createdAt editedAt isDeleted type parentMessageId author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl }
        }
      }`,
      { parentMessageId, limit: 200 },
      token,
    );
    setThreadRootId(parentMessageId);
    setMessages(data.thread);
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

  async function sendMessage(e?: FormEvent) {
    e?.preventDefault();
    const content = newMessage.trimEnd();
    if (!token || !content.trim()) return;
    setChatError("");

    if (typingRef.current.stopTimerId) window.clearTimeout(typingRef.current.stopTimerId);
    typingRef.current.stopTimerId = null;
    if (typingRef.current.started) {
      typingRef.current.started = false;
      emitTypingStop();
    }

    try {
      const parentMessageId = replyTo?.id;
      if (mode === "channels") {
        if (!activeChannelId) return;
        const data = await gql<{ sendMessage: Message }>(
          `mutation($channelId: ID!, $content: String!, $parentMessageId: ID) {
            sendMessage(input: { channelId: $channelId, content: $content, parentMessageId: $parentMessageId }) {
              id content createdAt editedAt isDeleted type parentMessageId author { email } reactions { emoji count viewerHasReacted }
            }
          }`,
          { channelId: activeChannelId, content, ...(parentMessageId ? { parentMessageId } : {}) },
          token,
        );
        setMessages((prev) => [...prev, data.sendMessage]);
      } else if (mode === "groups") {
        if (!activeGroupChatId) return;
        const data = await gql<{ sendGroupChatMessage: Message }>(
          `mutation($groupChatId: ID!, $content: String!, $parentMessageId: ID) {
            sendGroupChatMessage(input: { groupChatId: $groupChatId, content: $content, parentMessageId: $parentMessageId }) {
              id content createdAt editedAt isDeleted type parentMessageId author { email } reactions { emoji count viewerHasReacted }
            }
          }`,
          { groupChatId: activeGroupChatId, content, ...(parentMessageId ? { parentMessageId } : {}) },
          token,
        );
        setMessages((prev) => [...prev, data.sendGroupChatMessage]);
      } else {
        if (!activeDirectChat) return;
        const otherUserId = activeDirectChat.userIds.find((id) => id !== userId) ?? "";
        if (!otherUserId) return;
        const data = await gql<{ sendDirectMessage: DirectChatMessage }>(
          `mutation($userId: ID!, $content: String!, $parentMessageId: ID) {
            sendDirectMessage(input: { userId: $userId, content: $content, parentMessageId: $parentMessageId }) {
              id directChatId content createdAt editedAt type parentMessageId author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl }
            }
          }`,
          { userId: otherUserId, content, ...(parentMessageId ? { parentMessageId } : {}) },
          token,
        );
        setMessages((prev) => [
          ...prev,
          {
            id: data.sendDirectMessage.id,
            content: data.sendDirectMessage.content,
            createdAt: data.sendDirectMessage.createdAt,
            editedAt: (data.sendDirectMessage as any).editedAt ?? null,
            author: data.sendDirectMessage.author,
            type: data.sendDirectMessage.type,
            reactions: data.sendDirectMessage.reactions ?? [],
            file: data.sendDirectMessage.file ?? null,
            parentMessageId: data.sendDirectMessage.parentMessageId ?? null,
          },
        ]);
      }
      setNewMessage("");
      setReplyTo(null);
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "Не удалось отправить сообщение");
      setChatError(msg);
      pushLog(`sendMessage error: ${msg}`);
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
          editMessage(input: $input) { id content createdAt type author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl } }
        }`,
        { input: { messageId, content: next } },
        token,
      );
      setMessages((prev) => prev.map((x) => (x.id === messageId ? (data.editMessage as any) : x)));
    } else if (mode === "groups") {
      const data = await gql<{ editGroupChatMessage: any }>(
        `mutation($groupChatId: ID!, $messageId: ID!, $content: String!) {
          editGroupChatMessage(groupChatId: $groupChatId, messageId: $messageId, content: $content) {
            id content createdAt type author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl }
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
            id directChatId content createdAt type author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl }
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
      blob.type ||
      (nameLower.endsWith(".torrent")
        ? "application/x-bittorrent"
        : nameLower.endsWith(".webm")
          ? "audio/webm"
          : "application/octet-stream");

    async function sleep(ms: number) {
      await new Promise((r) => setTimeout(r, ms));
    }
    async function waitForFileClean(fileId: string, timeoutMs = 60_000) {
      if (socket) {
        await new Promise<void>((resolve, reject) => {
          const existing = fileStatusWaitersRef.current.get(fileId);
          if (existing) {
            clearTimeout(existing.timeoutId);
            fileStatusWaitersRef.current.delete(fileId);
          }
          const timeoutId = window.setTimeout(() => {
            fileStatusWaitersRef.current.delete(fileId);
            reject(new Error("Таймаут ожидания антивирусной проверки (socket)"));
          }, timeoutMs);
          fileStatusWaitersRef.current.set(fileId, { resolve, reject, timeoutId });
        });
        return;
      }

      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const data = await gql<{ file: { id: string; avStatus: string; blockedReason?: string | null } }>(
          `query($id: ID!) { file(id: $id) { id avStatus blockedReason } }`,
          { id: fileId },
          token,
        );
        const status = String(data.file.avStatus || "");
        if (status === "clean") return;
        if (status === "infected" || status === "blocked" || status === "error") {
          throw new Error(`Файл не прошел проверку: ${status}${data.file.blockedReason ? ` (${data.file.blockedReason})` : ""}`);
        }
        await sleep(1000);
      }
      throw new Error("Таймаут ожидания антивирусной проверки (pending слишком долго)");
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
        author: { email },
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
      await waitForFileClean(fileId);

      if (mode === "channels") {
        const data = await gql<{ sendFileMessage: Message }>(
          `mutation($input: SendFileMessageInput!) {
            sendFileMessage(input: $input) { id content createdAt type author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl } }
          }`,
          { input: { channelId: activeChannelId, fileId, kind } },
          token,
        );
        setMessages((prev) => prev.map((m) => (m.id === localId ? (data.sendFileMessage as any) : m)));
      } else if (mode === "groups") {
        const data = await gql<{ sendGroupChatFileMessage: Message }>(
          `mutation($input: SendGroupChatFileMessageInput!) {
            sendGroupChatFileMessage(input: $input) { id content createdAt type author { email } reactions { emoji count viewerHasReacted } file { id originalName mimeType size downloadUrl } }
          }`,
          { input: { groupChatId: activeGroupChatId, fileId, kind } },
          token,
        );
        setMessages((prev) => prev.map((m) => (m.id === localId ? (data.sendGroupChatFileMessage as any) : m)));
      } else {
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
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "Upload failed");
      setMessages((prev) => prev.map((m) => (m.id === localId ? { ...m, _localFileState: "failed", _localError: msg } : m)));
      throw e;
    }
  }

  async function hydrateDownloadUrl(messageId: string, fileId: string) {
    if (!token) return;
    const data = await gql<{ file: { id: string; downloadUrl: string; originalName?: string | null; mimeType: string; size: number } }>(
      `query($id: ID!) {
        file(id: $id) { id originalName mimeType size downloadUrl }
      }`,
      { id: fileId },
      token,
    );
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              file: {
                id: data.file.id,
                originalName: data.file.originalName ?? m.file?.originalName ?? null,
                mimeType: data.file.mimeType,
                size: data.file.size,
                downloadUrl: data.file.downloadUrl,
              },
            }
          : m,
      ),
    );
  }

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
    if (isRecordingVoice || mediaRecorderRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("getUserMedia not supported");
    if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder not supported in browser");
    setChatError("");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaStreamRef.current = stream;
    const preferredTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
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
        const blob = new Blob(mediaChunksRef.current, { type: rec.mimeType || "audio/webm" });
        mediaChunksRef.current = [];
        const durationMs = Date.now() - voiceStartAtRef.current;
        if (durationMs < 250) {
          setChatError("Слишком короткая запись. Удерживайте кнопку дольше.");
          return;
        }
        if (blob.size > 0) {
          await uploadAndSend("voice", blob, `voice-${Date.now()}.webm`);
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
    rec.start();
    setIsRecordingVoice(true);
    setVoiceHoldMs(0);
    pushLog("Запись голосового... удерживайте кнопку");
  }

  function stopVoiceRecord() {
    const rec = mediaRecorderRef.current;
    if (!rec || rec.state === "inactive") return;
    try {
      rec.stop();
    } catch {
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      mediaRecorderRef.current = null;
      setIsRecordingVoice(false);
    }
  }

  function onVoiceMouseDown(e: React.MouseEvent<HTMLButtonElement>) {
    if (voiceTouchActiveRef.current) return;
    e.preventDefault();
    void startVoiceRecord();
  }
  function onVoiceTouchStart(e: React.TouchEvent<HTMLButtonElement>) {
    voiceTouchActiveRef.current = true;
    e.preventDefault();
    void startVoiceRecord();
  }
  function onVoiceTouchEnd(e: React.TouchEvent<HTMLButtonElement>) {
    e.preventDefault();
    stopVoiceRecord();
    window.setTimeout(() => {
      voiceTouchActiveRef.current = false;
    }, 200);
  }

  const composerDisabled = (mode === "channels" ? !activeChannelId : mode === "groups" ? !activeGroupChatId : !activeDirectChatId) || !canWriteChats;
  const uploadDisabled = composerDisabled;
  const canSendText = !!newMessage.trim() && canWriteChats;

  const isAuthed = !!token;

  if (!isAuthed) {
    return (
      <div className="authPage">
        <div className="authCard">
          <div className="authTitle">sf-communication</div>
          <div className="authSub">Вход (dev seed)</div>

          <div className="authRow" style={{ marginTop: 4 }}>
            <button className={authMode === "user" ? "active" : ""} onClick={() => setAuthMode("user")}>
              Пользователь
            </button>
            <button className={authMode === "admin" ? "active" : ""} onClick={() => setAuthMode("admin")}>
              Админ
            </button>
          </div>

          {authMode === "admin" ? (
            <div className="authRow">
              <button onClick={() => void fillSeedInfo()}>Заполнить seed ID</button>
            </div>
          ) : null}

          {authMode === "admin" ? (
            <>
              <label>Organization ID</label>
              <input
                value={organizationCode}
                onChange={(e) => setOrganizationCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                placeholder="ID000015"
              />
            </>
          ) : null}

          <label>Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />

          <label>Пароль</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" />

          <div className="authRow">
            <button onClick={(e) => void login(e as any)} disabled={(authMode === "admin" ? !organizationCode : false) || !email || !password}>
              Войти
            </button>
          </div>
          {authError ? <div style={{ color: "#ff9ea6", fontSize: 12, marginTop: 6 }}>{authError}</div> : null}

          <div style={{ opacity: 0.75, fontSize: 12, marginTop: 10 }}>
            После входа можно подключить Socket и загрузить данные (каналы/группы/DM).
          </div>
        </div>
      </div>
    );
  }

  if (token && showAdminUsersPage && isCompanyAdmin) {
    return (
      <div className="adminUsersPage">
        <header className="adminUsersHeader">
          <button type="button" className="chip" onClick={() => setShowAdminUsersPage(false)}>
            ← К мессенджеру
          </button>
          <div>
            <h1 className="adminUsersTitle">Пользователи организации</h1>
            <p className="adminUsersSub">
              Компания: <strong>{adminOrgName || "…"}</strong> · ID: <code>{organizationId}</code>
            </p>
            <p className="adminUsersHint">
              Пароли в системе хранятся только в виде хеша; открытый текст показать нельзя. Используйте «Задать пароль» для сброса.
            </p>
          </div>
        </header>
        {adminPanelMsg ? <div className="adminUsersBanner">{adminPanelMsg}</div> : null}
        <section className="adminUsersCard">
          <h2 className="adminUsersCardTitle">Добавить пользователя</h2>
          <form className="adminUsersForm" onSubmit={(e) => void adminPanelCreateUser(e)}>
            <input
              type="email"
              placeholder="Email (логин)"
              value={adminNewEmail}
              onChange={(e) => setAdminNewEmail(e.target.value)}
              autoComplete="off"
            />
            <input
              type="password"
              placeholder="Пароль (мин. 8 символов)"
              value={adminNewPassword}
              onChange={(e) => setAdminNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            <input
              type="text"
              placeholder="Имя (необязательно)"
              value={adminNewFullName}
              onChange={(e) => setAdminNewFullName(e.target.value)}
            />
            <select value={adminNewRole} onChange={(e) => setAdminNewRole(e.target.value as typeof adminNewRole)}>
              <option value="employee">employee</option>
              <option value="manager">manager</option>
              <option value="guest">guest</option>
              <option value="admin">admin</option>
              {viewerRole === "owner" ? <option value="owner">owner</option> : null}
            </select>
            <button type="submit">Создать</button>
          </form>
        </section>
        <section className="adminUsersTableWrap">
          <table className="adminUsersTable">
            <thead>
              <tr>
                <th>Email (логин)</th>
                <th>Роль</th>
                <th>Отдел</th>
                <th>Компания</th>
                <th>Пароль</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.id === userId;
                const targetIsElevated = u.role === "owner" || u.role === "admin";
                const adminCannotManage = viewerRole === "admin" && targetIsElevated;
                return (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td>{u.role ?? "—"}</td>
                    <td>{u.department ?? "—"}</td>
                    <td>{adminOrgName || "—"}</td>
                    <td>
                      <span className="adminUsersPwdMask">••••••••</span>
                      <button
                        type="button"
                        className="chip adminUsersPwdBtn"
                        disabled={adminCannotManage}
                        title={adminCannotManage ? "Недостаточно прав (только owner)" : "Задать новый пароль"}
                        onClick={() => void adminPanelSetPassword(u.id)}
                      >
                        Задать пароль
                      </button>
                    </td>
                    <td className="adminUsersActions">
                      <button
                        type="button"
                        className="chip danger"
                        disabled={isSelf || adminCannotManage}
                        title={isSelf ? "Нельзя деактивировать себя" : adminCannotManage ? "Только owner может удалить эту роль" : "Деактивировать"}
                        onClick={() => void deactivateCompanyUser(u.id)}
                      >
                        Удалить
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {users.length === 0 ? <div className="empty adminUsersEmpty">Нет активных пользователей. Нажмите «К мессенджеру», откройте меню ⋮ — при необходимости загрузите список из кабинета компании.</div> : null}
        </section>
      </div>
    );
  }

  return (
    <div className={`layout ${showRightPanel ? "layout--info" : ""} ${viewportW < 800 && mobileSidebarOpen ? "layout--sidebarOpen" : ""}`}>
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
          <div className="tgLogoMark" aria-hidden>
            <span className="tgLogoPlane">✈</span>
          </div>
          <div className="tgTopBarTitle">Messenger</div>
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
                    Новый личный чат
                  </button>
                  <button
                    type="button"
                    className="tgPopoverItem"
                    onClick={() => void openNewThingWizard("group")}
                    disabled={!token || !organizationId || !canCreateChannelsAndGroups}
                  >
                    Новая группа
                  </button>
                  <button
                    type="button"
                    className="tgPopoverItem"
                    onClick={() => void openNewThingWizard("channel")}
                    disabled={!token || !workspaceId || !organizationId || !canCreateChannelsAndGroups}
                  >
                    Новый канал
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
            placeholder="Поиск"
            value={chatSearch}
            onChange={(e) => setChatSearch(e.target.value)}
            ref={chatSearchRef}
            title="Ctrl/Cmd + K"
          />
        </div>

        <div className="sidebarChatsBlock">
          <div className="row tgModeTabs">
            <button className={mode === "channels" ? "active" : ""} onClick={() => setMode("channels")} disabled={!canReadChats}>
              Каналы
            </button>
            <button className={mode === "groups" ? "active" : ""} onClick={() => setMode("groups")} disabled={!canReadChats}>
              Группы
            </button>
            <button className={mode === "dms" ? "active" : ""} onClick={() => setMode("dms")} disabled={!canReadChats}>
              DM
            </button>
          </div>
          <div className="row tgFolderTabs">
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
          <div className="tgChatList">
            {mode === "channels"
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
                    onContextMenu={(e) => openChatMenu(e, chatKeyFor("c", c.id))}
                    onClick={() => {
                      setActiveChannelId(c.id);
                      setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("c", c.id)]: 0 }));
                      void loadMessages(c.id);
                    }}
                  >
                    <div className="tgAvatar">#</div>
                    <div className="tgChatMain">
                      <div className="tgChatTop">
                        <div className="tgChatTitle">{isPinned(chatKeyFor("c", c.id)) ? "📌 " : ""}#{c.name}</div>
                        <div className="tgChatTime">{timeHHMM(chatPreviewByKey[chatKeyFor("c", c.id)]?.at)}</div>
                      </div>
                      <div className="tgChatSub">
                        {isMuted(chatKeyFor("c", c.id)) ? "🔕 " : ""}
                        {chatPreviewByKey[chatKeyFor("c", c.id)]?.text || `Канал · ${c.type}`}
                      </div>
                    </div>
                    <div className="tgRowActions">
                      {isPinned(chatKeyFor("c", c.id)) ? (
                        <>
                          <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); movePinned(chatKeyFor("c", c.id), -1); }} title="Выше">
                            ↑
                          </span>
                          <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); movePinned(chatKeyFor("c", c.id), 1); }} title="Ниже">
                            ↓
                          </span>
                        </>
                      ) : null}
                      <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); togglePin(chatKeyFor("c", c.id)); }} title="Закрепить чат">
                        📌
                      </span>
                      <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); toggleMute(chatKeyFor("c", c.id)); }} title="Mute чат">
                        🔕
                      </span>
                      <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); toggleArchive(chatKeyFor("c", c.id)); }} title="Архивировать чат">
                        🗂
                      </span>
                    </div>
                    {unreadFor(chatKeyFor("c", c.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("c", c.id))}</div> : null}
                  </button>
                ))
              : mode === "groups"
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
                      onContextMenu={(e) => openChatMenu(e, chatKeyFor("g", g.id))}
                      onClick={() => {
                        setActiveGroupChatId(g.id);
                      setUnreadByKey((prev) => ({ ...prev, [chatKeyFor("g", g.id)]: 0 }));
                        void loadGroupMessages(g.id);
                      }}
                    >
                      <div className="tgAvatar">{initials(g.name)}</div>
                      <div className="tgChatMain">
                        <div className="tgChatTop">
                          <div className="tgChatTitle">{isPinned(chatKeyFor("g", g.id)) ? "📌 " : ""}{g.name}</div>
                          <div className="tgChatTime">{timeHHMM(chatPreviewByKey[chatKeyFor("g", g.id)]?.at)}</div>
                        </div>
                        <div className="tgChatSub">
                          {isMuted(chatKeyFor("g", g.id)) ? "🔕 " : ""}
                          {chatPreviewByKey[chatKeyFor("g", g.id)]?.text || `Группа · участников: ${g.memberIds?.length ?? 0}`}
                        </div>
                      </div>
                    <div className="tgRowActions">
                      {isPinned(chatKeyFor("g", g.id)) ? (
                        <>
                          <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); movePinned(chatKeyFor("g", g.id), -1); }} title="Выше">
                            ↑
                          </span>
                          <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); movePinned(chatKeyFor("g", g.id), 1); }} title="Ниже">
                            ↓
                          </span>
                        </>
                      ) : null}
                      <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); togglePin(chatKeyFor("g", g.id)); }} title="Закрепить чат">
                        📌
                      </span>
                      <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); toggleMute(chatKeyFor("g", g.id)); }} title="Mute чат">
                        🔕
                      </span>
                      <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); toggleArchive(chatKeyFor("g", g.id)); }} title="Архивировать чат">
                        🗂
                      </span>
                    </div>
                    {unreadFor(chatKeyFor("g", g.id)) ? <div className="tgUnread">{unreadFor(chatKeyFor("g", g.id))}</div> : null}
                    </button>
                  ))
                : orderedDMs.map((d) => {
                    const otherId = d.userIds.find((id) => id !== userId) ?? d.userIds[0] ?? "";
                    const u = users.find((x) => x.id === otherId);
                    const p = otherId ? presenceByUserId[otherId] : undefined;
                    const st = p?.status ?? u?.status ?? "unknown";
                    const dot = st === "online" ? "●" : st === "away" ? "◐" : st === "dnd" ? "◍" : "○";
                    const title = u?.email ?? (otherId || d.id);
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
                        onContextMenu={(e) => openChatMenu(e, chatKeyFor("d", d.id))}
                        onClick={() => {
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
                            <div className="tgChatTime">{timeHHMM(chatPreviewByKey[chatKeyFor("d", d.id)]?.at)}</div>
                          </div>
                          <div className="tgChatSub">
                            {isMuted(chatKeyFor("d", d.id)) ? "🔕 " : ""}
                            {chatPreviewByKey[chatKeyFor("d", d.id)]?.text || "Личка"}
                          </div>
                        </div>
                        <div className="tgRowActions">
                          {isPinned(chatKeyFor("d", d.id)) ? (
                            <>
                              <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); movePinned(chatKeyFor("d", d.id), -1); }} title="Выше">
                                ↑
                              </span>
                              <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); movePinned(chatKeyFor("d", d.id), 1); }} title="Ниже">
                                ↓
                              </span>
                            </>
                          ) : null}
                          <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); togglePin(chatKeyFor("d", d.id)); }} title="Закрепить чат">
                            📌
                          </span>
                          <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); toggleMute(chatKeyFor("d", d.id)); }} title="Mute чат">
                            🔕
                          </span>
                          <span className="tgRowAction" onClick={(e) => { e.stopPropagation(); toggleArchive(chatKeyFor("d", d.id)); }} title="Архивировать чат">
                            🗂
                          </span>
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
                <div className="moreMenuSection">
                  <div className="moreMenuLabel">Глобальный поиск</div>
                  <input
                    placeholder="сообщение, канал, пользователь, файл…"
                    value={globalQuery}
                    onChange={(e) => setGlobalQuery(e.target.value)}
                  />
                  <div className="row" style={{ marginTop: 8 }}>
                    <button type="button" onClick={() => void runGlobalSearch()} disabled={!token || !globalQuery.trim()}>
                      Найти
                    </button>
                  </div>
                </div>
                <div className="moreMenuSection">
                  <div className="moreMenuLabel">Быстрый переход</div>
                  <select
                    className="moreMenuSelect"
                    defaultValue=""
                    onChange={(e) => {
                      const v = e.target.value;
                      e.currentTarget.value = "";
                      void openChatFromList(v);
                      setMoreMenuOpen(false);
                      setMobileSidebarOpen(false);
                    }}
                  >
                    <option value="">Выберите чат…</option>
                    <optgroup label="Каналы">
                      {orderedChannels.map((c) => (
                        <option key={`pick-c-${c.id}`} value={`c:${c.id}`}>
                          #{c.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Группы">
                      {orderedGroups.map((g) => (
                        <option key={`pick-g-${g.id}`} value={`g:${g.id}`}>
                          {g.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="DM">
                      {orderedDMs.map((d) => {
                        const otherId = d.userIds.find((id) => id !== userId) ?? d.userIds[0] ?? "";
                        const u = users.find((x) => x.id === otherId);
                        const title = u?.email ?? otherId ?? d.id;
                        return (
                          <option key={`pick-d-${d.id}`} value={`d:${d.id}`}>
                            {title}
                          </option>
                        );
                      })}
                    </optgroup>
                  </select>
                </div>
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
                  <button
                    type="button"
                    className="moreMenuWideBtn"
                    onClick={() => {
                      setShowCompanyCabinet(true);
                      setCompanyTab("employees");
                      void loadUsers();
                      setMoreMenuOpen(false);
                    }}
                    disabled={!token || !organizationId}
                  >
                    Кабинет компании
                  </button>
                  {isCompanyAdmin ? (
                    <button
                      type="button"
                      className="moreMenuWideBtn"
                      onClick={() => {
                        openAdminUsersPanel();
                        setMoreMenuOpen(false);
                      }}
                      disabled={!token || !organizationId}
                    >
                      Админ: пользователи
                    </button>
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
                    className="moreMenuWideBtn"
                    onClick={() => {
                      void refreshSavedIds();
                      setMoreMenuOpen(false);
                    }}
                    disabled={!token}
                  >
                    Обновить сохранённые ID
                  </button>
                  <button
                    type="button"
                    className="moreMenuWideBtn subtle"
                    onClick={() => {
                      setShowLogs(true);
                      setMoreMenuOpen(false);
                    }}
                  >
                    Журнал событий
                  </button>
                </div>
                <div className="moreMenuSection">
                  <div className="moreMenuLabel">Пользователи</div>
                  {users.length === 0 ? (
                    <div className="empty">Загрузите список (раздел «Отладка» ниже → Users)</div>
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
                            {u.email}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="moreMenuSection">
                  <button type="button" className="moreMenuWideBtn subtle" onClick={() => setShowDev((v) => !v)}>
                    {showDev ? "Скрыть отладку" : "Отладка и загрузка данных"}
                  </button>
                  {showDev ? (
                    <div className="moreMenuDev">
                      <label>Workspace ID</label>
                      <input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} placeholder="workspace id" />
                      <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
                        <button type="button" onClick={connectSocket} disabled={!token}>
                          Socket
                        </button>
                        <button type="button" onClick={() => void loadChannels()} disabled={!token || !workspaceId}>
                          Каналы
                        </button>
                        <button type="button" onClick={() => void loadGroupChats()} disabled={!token}>
                          Группы
                        </button>
                        <button type="button" onClick={() => void loadDirectChats()} disabled={!token}>
                          DM
                        </button>
                        <button type="button" onClick={() => void loadUsers()} disabled={!token || !organizationId}>
                          Users
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </>
        ) : null}

        {chatMenu ? (
          <div className="chatMenu" style={{ top: chatMenu.y, left: chatMenu.x }} role="menu">
            <button className="msgMenuItem" onClick={() => { togglePin(chatMenu.key); setChatMenu(null); }}>
              {isPinned(chatMenu.key) ? "Открепить чат" : "Закрепить чат"}
            </button>
            <button className="msgMenuItem" onClick={() => { toggleMute(chatMenu.key); setChatMenu(null); }}>
              {isMuted(chatMenu.key) ? "Включить уведомления" : "Выключить уведомления"}
            </button>
            <button className="msgMenuItem" onClick={() => { toggleArchive(chatMenu.key); setChatMenu(null); }}>
              {isArchived(chatMenu.key) ? "Вернуть из архива" : "Архивировать чат"}
            </button>
            <div className="msgMenuSep" />
            <button className="msgMenuItem" onClick={() => { setUnreadByKey((p) => ({ ...p, [chatMenu.key]: 0 })); setChatMenu(null); }}>
              Отметить как прочитанное
            </button>
          </div>
        ) : null}
      </aside>

      <main className="chat">
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
                className="tgHeaderAvatar"
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
                {mode === "channels"
                  ? "#"
                  : mode === "groups"
                    ? initials(activeGroupChat?.name ?? "G")
                    : (() => {
                        const otherId = activeDirectChat?.userIds.find((id) => id !== userId) ?? activeDirectChat?.userIds[0] ?? "";
                        const u = users.find((x) => x.id === otherId);
                        return initials(u?.email ?? otherId ?? "DM");
                      })()}
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
                        ? (() => {
                            const otherId =
                              activeDirectChat.userIds.find((id) => id !== userId) ?? activeDirectChat.userIds[0] ?? "";
                            const u = users.find((x) => x.id === otherId);
                            return u?.email ?? otherId ?? activeDirectChat.id;
                          })()
                        : "Выберите DM"}
                </div>
                <div className="tgChatHeaderSub">
                  {mode === "dms" && activeDirectChat
                    ? (() => {
                        const otherId =
                          activeDirectChat.userIds.find((id) => id !== userId) ?? activeDirectChat.userIds[0] ?? "";
                        const u = users.find((x) => x.id === otherId);
                        const p = otherId ? presenceByUserId[otherId] : undefined;
                        const st = p?.status ?? u?.status ?? "unknown";
                        return st === "online" ? "в сети" : st === "away" ? "не активен" : st === "dnd" ? "не беспокоить" : "не в сети";
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
            <div className="tgChatHeaderRight">
              <button
                type="button"
                className="tgCircleBtn"
                title="Поиск в чате (Ctrl/Cmd+K — поиск в списке)"
                onClick={() => {
                  composerRef.current?.focus();
                }}
              >
                🔍
              </button>
              <button
                type="button"
                className="tgCircleBtn"
                onClick={() => void startAudioCall()}
                title="Голосовой звонок"
                disabled={!canStartCalls}
              >
                📞
              </button>
              <button
                type="button"
                className="tgCircleBtn"
                onClick={() => void startVideoMeeting()}
                title="Видеозвонок"
                disabled={!canStartCalls}
              >
                🎥
              </button>
              <button type="button" className="tgCircleBtn" onClick={() => setShowRightPanel((v) => !v)} title="Сведения о чате">
                ℹ️
              </button>
              <button type="button" className="tgCircleBtn" title="Журнал / отладка" onClick={() => setShowLogs((v) => !v)}>
                🛈
              </button>
              <button type="button" className="tgCircleBtn tgCircleBtn--danger" onClick={() => void logout()} title="Выйти">
                ⎋
              </button>
            </div>
          </div>
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

        {showGlobalResult && globalResult ? (
          <section className="messages" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="empty" style={{ textAlign: "left" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
                <div style={{ fontWeight: 700 }}>Результаты поиска: “{globalQuery.trim()}”</div>
                <button onClick={() => setShowGlobalResult(false)}>Закрыть</button>
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Сообщения</div>
                {globalResult.messages.length === 0 ? (
                  <div>Нет</div>
                ) : (
                  globalResult.messages.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => void goToSearchMessage(m)}
                      style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 6 }}
                    >
                      <div style={{ fontSize: 12, opacity: 0.8 }}>
                        {new Date(m.createdAt).toLocaleString()} · {m.author.email} · {m.channelId ? "channel" : m.groupChatId ? "group" : "dm"}
                      </div>
                      <div style={{ fontSize: 13 }}>{(m.content || "").slice(0, 200) || "(без текста)"}</div>
                    </button>
                  ))
                )}
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Каналы</div>
                {globalResult.channels.length === 0 ? (
                  <div>Нет</div>
                ) : (
                  globalResult.channels.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setMode("channels");
                        setActiveChannelId(c.id);
                        void loadMessages(c.id);
                        setShowGlobalResult(false);
                      }}
                      style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 6 }}
                    >
                      #{c.name}
                    </button>
                  ))
                )}
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Пользователи</div>
                {globalResult.users.length === 0 ? (
                  <div>Нет</div>
                ) : (
                  globalResult.users.map((u) => (
                    <div key={u.id} style={{ marginBottom: 6, fontSize: 13 }}>
                      {u.email} {u.firstName || u.lastName ? `(${[u.firstName, u.lastName].filter(Boolean).join(" ")})` : ""}
                    </div>
                  ))
                )}
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Файлы</div>
                {globalResult.files.length === 0 ? (
                  <div>Нет</div>
                ) : (
                  globalResult.files.map((f) => (
                    <div key={f.id} style={{ marginBottom: 6, fontSize: 13 }}>
                      {f.url ? (
                        <a href={f.url} target="_blank" rel="noreferrer">
                          file {f.id}
                        </a>
                      ) : (
                        <span style={{ opacity: 0.8 }}>file {f.id} (нет доступа/не clean)</span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        ) : null}

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
                  <div style={{ opacity: 0.85, marginBottom: 6 }}>DM</div>
                  <div className="list">
                    {directChats.map((d) => {
                      const otherId = d.userIds.find((id) => id !== userId) ?? d.userIds[0] ?? "";
                      const u = users.find((x) => x.id === otherId);
                      const p = otherId ? presenceByUserId[otherId] : undefined;
                      const st = p?.status ?? u?.status ?? "unknown";
                      const dot = st === "online" ? "●" : st === "away" ? "◐" : st === "dnd" ? "◍" : "○";
                      const title = `DM ${dot} ${u?.email ?? (otherId || d.id)}`;
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
              <div className="companyTabs">
                <button className={companyTab === "employees" ? "active" : ""} onClick={() => setCompanyTab("employees")}>
                  Сотрудники
                </button>
                <button
                  className={companyTab === "invites" ? "active" : ""}
                  onClick={() => {
                    setCompanyTab("invites");
                    setInviteDbPage(0);
                    void loadOrganizationInvites();
                  }}
                >
                  Инвайты
                </button>
                <button className={companyTab === "settings" ? "active" : ""} onClick={() => setCompanyTab("settings")}>
                  Настройки
                </button>
                {isCompanyAdmin ? (
                  <button className={companyTab === "admin" ? "active" : ""} onClick={() => setCompanyTab("admin")}>
                    Админ
                  </button>
                ) : null}
              </div>
              {companyActionMsg ? <div className="empty">{companyActionMsg}</div> : null}

              {companyTab === "employees" ? (
                <div className="companyBody">
                  {isCompanyAdmin ? (
                    <div
                      className="row"
                      style={{
                        marginBottom: 12,
                        padding: "12px 14px",
                        borderRadius: 12,
                        background: "rgba(100, 160, 255, 0.1)",
                        border: "1px solid rgba(100, 160, 255, 0.22)",
                        flexWrap: "wrap",
                        gap: 10,
                        alignItems: "center",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 200, fontSize: 13, lineHeight: 1.4 }}>
                        <strong>Админ: пользователи</strong> — отдельная страница: таблица, создание учётной записи, сброс пароля, деактивация.
                      </div>
                      <button
                        type="button"
                        className="chip"
                        onClick={() => {
                          setShowCompanyCabinet(false);
                          openAdminUsersPanel();
                        }}
                      >
                        Открыть страницу
                      </button>
                    </div>
                  ) : (
                    <p style={{ fontSize: 12, opacity: 0.75, margin: "0 0 12px" }}>
                      Раздел «Админ: пользователи» доступен только ролям <strong>owner</strong> и <strong>admin</strong>. Ваша роль:{" "}
                      <strong>{viewerRole || "—"}</strong>.
                    </p>
                  )}
                  <div className="row">
                    <input
                      value={companyUserQuery}
                      onChange={(e) => setCompanyUserQuery(e.target.value)}
                      placeholder="Поиск сотрудника"
                    />
                    <select
                      value={companyRoleFilter}
                      onChange={(e) => setCompanyRoleFilter(e.target.value as "all" | "owner" | "admin" | "manager" | "employee" | "guest")}
                      style={{
                        boxSizing: "border-box",
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(0,0,0,0.25)",
                        color: "inherit",
                      }}
                    >
                      <option value="all">all roles</option>
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="manager">manager</option>
                      <option value="employee">employee</option>
                      <option value="guest">guest</option>
                    </select>
                    <button onClick={() => void loadUsers()} disabled={!token || !organizationId}>
                      Обновить
                    </button>
                  </div>
                  <div className="list companyList">
                    {companyUsersFiltered.map((u) => (
                      <div key={`cab-modal-${u.id}`} className="companyRow">
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.email}</div>
                          <div style={{ fontSize: 11, opacity: 0.7 }}>
                            role: {u.role ?? "employee"} · dept: {u.department || "—"} · status: {u.status ?? "unknown"}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <select
                            value={u.role ?? "employee"}
                            onChange={(e) => void setCompanyUserRole(u.id, e.target.value as "owner" | "admin" | "manager" | "employee" | "guest")}
                            disabled={!token || !organizationId || u.id === userId}
                            style={{
                              boxSizing: "border-box",
                              padding: "6px 8px",
                              borderRadius: 10,
                              border: "1px solid rgba(255,255,255,0.12)",
                              background: "rgba(0,0,0,0.25)",
                              color: "inherit",
                            }}
                            title={u.id === userId ? "Свою роль менять нельзя" : "Сменить роль"}
                          >
                            <option value="owner">owner</option>
                            <option value="admin">admin</option>
                            <option value="manager">manager</option>
                            <option value="employee">employee</option>
                            <option value="guest">guest</option>
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
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {companyTab === "invites" ? (
                <div className="companyBody">
                  <label>Email сотрудника</label>
                  <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="user@company.com" />
                  <div className="row">
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as "owner" | "admin" | "manager" | "employee" | "guest")}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(0,0,0,0.25)",
                        color: "inherit",
                      }}
                    >
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="manager">manager</option>
                      <option value="employee">employee</option>
                      <option value="guest">guest</option>
                    </select>
                    <input value={inviteDepartment} onChange={(e) => setInviteDepartment(e.target.value)} placeholder="Отдел (опционально)" />
                    <button onClick={() => void inviteCompanyUser()} disabled={!token || !organizationId || !inviteEmail.trim()}>
                      Добавить
                    </button>
                  </div>
                  <div className="title" style={{ marginTop: 8 }}>Последние инвайты (эта сессия)</div>
                  <div className="list companyList">
                    {inviteHistory.length === 0 ? (
                      <div className="empty">Пока пусто</div>
                    ) : (
                      inviteHistory.map((inv) => (
                        <div key={`inv-modal-${inv.id}`} className="companyRow">
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{inv.email}</div>
                            <div style={{ fontSize: 11, opacity: 0.7 }}>role: {inv.role}</div>
                          </div>
                          <button className="chip" onClick={() => void revokeCompanyInvite(inv.id)} disabled={!token || !organizationId}>
                            Отозвать
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="row">
                    <div className="title" style={{ margin: 0 }}>Инвайты из базы</div>
                    <button onClick={() => void loadOrganizationInvites()} disabled={!token || !organizationId}>
                      Обновить
                    </button>
                  </div>
                  <div className="row">
                    <input
                      value={inviteDbQuery}
                      onChange={(e) => setInviteDbQuery(e.target.value)}
                      placeholder="Поиск по email"
                    />
                    <select
                      value={inviteDbRoleFilter}
                      onChange={(e) => setInviteDbRoleFilter(e.target.value as "all" | "owner" | "admin" | "manager" | "employee" | "guest")}
                      style={{
                        boxSizing: "border-box",
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(0,0,0,0.25)",
                        color: "inherit",
                      }}
                    >
                      <option value="all">all roles</option>
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="manager">manager</option>
                      <option value="employee">employee</option>
                      <option value="guest">guest</option>
                    </select>
                    <select
                      value={inviteDbStatusFilter}
                      onChange={(e) => setInviteDbStatusFilter(e.target.value as "all" | "active" | "accepted" | "revoked" | "expired")}
                      style={{
                        boxSizing: "border-box",
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(0,0,0,0.25)",
                        color: "inherit",
                      }}
                    >
                      <option value="all">all status</option>
                      <option value="active">active</option>
                      <option value="accepted">accepted</option>
                      <option value="revoked">revoked</option>
                      <option value="expired">expired</option>
                    </select>
                    <button
                      onClick={() => {
                        setInviteDbPage(0);
                        void loadOrganizationInvites(0, inviteDbPageSize);
                      }}
                      disabled={!token || !organizationId}
                    >
                      Применить
                    </button>
                  </div>
                  <div className="row">
                    <select
                      value={String(inviteDbPageSize)}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        setInviteDbPageSize(next);
                        setInviteDbPage(0);
                        void loadOrganizationInvites(0, next);
                      }}
                      style={{
                        boxSizing: "border-box",
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(0,0,0,0.25)",
                        color: "inherit",
                      }}
                    >
                      <option value="10">10 / page</option>
                      <option value="20">20 / page</option>
                      <option value="50">50 / page</option>
                    </select>
                    <button
                      onClick={() => {
                        const next = Math.max(0, inviteDbPage - 1);
                        setInviteDbPage(next);
                        void loadOrganizationInvites(next, inviteDbPageSize);
                      }}
                      disabled={!token || !organizationId || inviteDbPage === 0}
                    >
                      ← Prev
                    </button>
                    <button
                      onClick={() => {
                        const next = inviteDbPage + 1;
                        setInviteDbPage(next);
                        void loadOrganizationInvites(next, inviteDbPageSize);
                      }}
                      disabled={!token || !organizationId || organizationInvites.length < inviteDbPageSize}
                    >
                      Next →
                    </button>
                    <button onClick={exportOrganizationInvitesCsv} disabled={!organizationInvites.length}>
                      Export CSV
                    </button>
                    <div className="empty">Page: {inviteDbPage + 1}</div>
                  </div>
                  <div className="list companyList">
                    {organizationInvites.length === 0 ? (
                      <div className="empty">Пока пусто</div>
                    ) : (
                      organizationInvites.map((inv) => {
                        const now = Date.now();
                        const isAccepted = !!inv.acceptedAt;
                        const isRevoked = !!inv.revokedAt;
                        const isExpired = !isAccepted && !isRevoked && !!inv.expiresAt && new Date(inv.expiresAt).getTime() < now;
                        const status = isAccepted ? "accepted" : isRevoked ? "revoked" : isExpired ? "expired" : "active";
                        return (
                          <div key={`inv-db-${inv.id}`} className="companyRow">
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {inv.email}
                              </div>
                              <div style={{ fontSize: 11, opacity: 0.7 }}>
                                role: {inv.role} · dept: {inv.department || "—"} · status: {status}
                              </div>
                            </div>
                            <button
                              className="chip"
                              onClick={() => void revokeCompanyInvite(inv.id)}
                              disabled={!token || !organizationId || status !== "active"}
                              title={status !== "active" ? "Отозвать можно только active инвайт" : "Отозвать инвайт"}
                            >
                              Отозвать
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : null}

              {companyTab === "settings" ? (
                <div className="companyBody">
                  <label>Название компании</label>
                  <input value={orgNameInput} onChange={(e) => setOrgNameInput(e.target.value)} placeholder="sf-communication" />
                  <label>Logo URL</label>
                  <input value={orgLogoInput} onChange={(e) => setOrgLogoInput(e.target.value)} placeholder="https://..." />
                  <div className="row">
                    <div style={{ flex: 1 }}>
                      <label>Retention days</label>
                      <input value={orgRetentionDaysInput} onChange={(e) => setOrgRetentionDaysInput(e.target.value)} placeholder="30" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label>Max file size MB</label>
                      <input value={orgMaxFileSizeMbInput} onChange={(e) => setOrgMaxFileSizeMbInput(e.target.value)} placeholder="25" />
                    </div>
                  </div>
                  <div className="empty" style={{ textAlign: "left" }}>
                    <div>Organization ID: {displayOrganizationId}</div>
                    <div style={{ marginTop: 6 }}>Текущий пользователь: {email || "—"}</div>
                  </div>
                  <div className="row">
                    <button onClick={() => void saveCompanySettings()} disabled={!token || !organizationId}>
                      Сохранить настройки
                    </button>
                    <button onClick={() => void loadUsers()} disabled={!token || !organizationId}>
                      Синхронизировать сотрудников
                    </button>
                    <button
                      onClick={() => {
                        setCompanyUserQuery("");
                        setCompanyRoleFilter("all");
                        setCompanyActionMsg("Фильтры сброшены");
                      }}
                    >
                      Сбросить фильтры
                    </button>
                  </div>
                  <div className="empty" style={{ marginTop: 8 }}>
                    Для смены роли существующего сотрудника потребуется отдельная backend-мутация.
                  </div>
                </div>
              ) : null}
              {companyTab === "admin" ? (
                <div className="companyBody">
                  <div className="title">Добавить сотрудника (по одному)</div>
                  <input value={adminCreateEmail} onChange={(e) => setAdminCreateEmail(e.target.value)} placeholder="email сотрудника" />
                  <input value={adminCreateFullName} onChange={(e) => setAdminCreateFullName(e.target.value)} placeholder="ФИО" />
                  <div className="row">
                    <input
                      value={adminCreatePassword}
                      onChange={(e) => setAdminCreatePassword(e.target.value)}
                      placeholder="Временный пароль"
                      type="password"
                    />
                    <select
                      value={adminCreateRole}
                      onChange={(e) => setAdminCreateRole(e.target.value as "owner" | "admin" | "manager" | "employee" | "guest")}
                      style={{
                        boxSizing: "border-box",
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(0,0,0,0.25)",
                        color: "inherit",
                      }}
                    >
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="manager">manager</option>
                      <option value="employee">employee</option>
                      <option value="guest">guest</option>
                    </select>
                    <button onClick={() => void createCompanyUserSingle()} disabled={!token || !organizationId}>
                      Создать
                    </button>
                  </div>
                  <div className="title" style={{ marginTop: 8 }}>Массовый импорт из Excel/CSV</div>
                  <div className="empty" style={{ textAlign: "left" }}>
                    Колонки: <code>email</code>, <code>fio</code> (или <code>fullName</code>), <code>password</code>, <code>role</code> (опционально)
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
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        {showUserCabinet ? (
          <div className="companyModalBackdrop" onClick={() => setShowUserCabinet(false)}>
            <section className="companyModal" onClick={(e) => e.stopPropagation()}>
              <div className="companyModalHeader">
                <div style={{ fontWeight: 700 }}>Личный кабинет</div>
                <button className="chip" onClick={() => setShowUserCabinet(false)}>
                  Закрыть
                </button>
              </div>
              {profileMsg ? <div className="empty">{profileMsg}</div> : null}
              <div className="companyBody">
                <div className="profileHeaderRow">
                  <div className="profileAvatarPreview">
                    {profileAvatarUrl ? <img src={profileAvatarUrl} alt="avatar" /> : <span>{initials(myProfileEmail || email)}</span>}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{myProfileEmail || email}</div>
                    <div className="empty">
                      Уровень доступа: <b>{viewerRole || "unknown"}</b>
                    </div>
                    <div className="empty">
                      {(accessByRole[viewerRole] ?? []).join(" · ")}
                    </div>
                  </div>
                </div>

                <label>Имя</label>
                <input value={profileFirstName} onChange={(e) => setProfileFirstName(e.target.value)} placeholder="Имя" />
                <label>Фамилия</label>
                <input value={profileLastName} onChange={(e) => setProfileLastName(e.target.value)} placeholder="Фамилия" />
                <label>Статус</label>
                <input value={profileStatusText} onChange={(e) => setProfileStatusText(e.target.value)} placeholder="О чем вы думаете?" />
                <label>Avatar URL или data:image</label>
                <input value={profileAvatarUrl} onChange={(e) => setProfileAvatarUrl(e.target.value)} placeholder="https://... или data:image/..." />
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) applyAvatarFromFile(f);
                    e.currentTarget.value = "";
                  }}
                />
                <div className="row">
                  <div style={{ flex: 1 }}>
                    <label>Должность</label>
                    <input
                      value={profileTitle}
                      onChange={(e) => setProfileTitle(e.target.value)}
                      placeholder="Должность"
                      disabled={!canEditOrgFields}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>Отдел</label>
                    <input
                      value={profileDepartment}
                      onChange={(e) => setProfileDepartment(e.target.value)}
                      placeholder="Отдел"
                      disabled={!canEditOrgFields}
                    />
                  </div>
                </div>
                {!canEditOrgFields ? (
                  <div className="empty">Изменение отдела/должности доступно только для manager/admin/owner.</div>
                ) : null}
                <div className="row">
                  <button onClick={() => void saveMyProfile()} disabled={!token || !myProfileId}>
                    Сохранить профиль
                  </button>
                </div>

                <div className="title" style={{ marginTop: 8 }}>Стикеры</div>
                <div className="empty">Скачайте JSON-пак или установите/отключите набор для отправки в чате.</div>
                <div className="list companyList">
                  {stickerCatalog.map((pack) => {
                    const installed = installedStickerPackIds.includes(pack.id);
                    return (
                      <div key={pack.id} className="companyRow">
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13 }}>{pack.title}</div>
                          <div style={{ fontSize: 11, opacity: 0.7 }}>
                            {pack.stickers.slice(0, 6).join(" ")}
                            {pack.stickers.length > 6 ? " ..." : ""}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="chip" onClick={() => downloadStickerPack(pack)}>
                            Скачать
                          </button>
                          <button className="chip" onClick={() => toggleInstallStickerPack(pack.id)}>
                            {installed ? "Отключить" : "Установить"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <input
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
              className={`msg ${m.author?.email === email ? "mine" : "other"} ${showMeta ? "" : "compact"} ${forwardSelecting ? "selecting" : ""} ${forwardSelectedIds.has(m.id) ? "selected" : ""}`}
            >
              {showDay ? (
                <div className="daySep">
                  <span>{dt.toLocaleDateString()}</span>
                </div>
              ) : null}
              {showMeta ? (
                <div className="meta">
                  {m.author?.email ?? "user"}
                </div>
              ) : null}
              <div className="actions">
                <button className="chip" onClick={() => void editMessageInChat(m.id)} disabled={!token || m.author?.email !== email}>
                  ✎
                </button>
                <button className="chip" onClick={() => void deleteMessageInChat(m.id)} disabled={!token || m.author?.email !== email}>
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
              </div>
              <div
                className="bubble"
                onDoubleClick={() => setReplyTo({ id: m.id, preview: (m.content || "").slice(0, 80) || m.type || "" })}
                onClick={forwardSelecting ? () => toggleForwardSelected(m.id) : undefined}
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
                {m.type === "file" || m.type === "voice" ? (
                  m.file ? (
                    m._localFileState ? (
                      <div>
                        <div className="fileLine">
                          {m.type === "voice" ? "Голосовое" : "Файл"}: {m.file.originalName ?? m.file.id}
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
                        <div>
                          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>
                            Голосовое: {m.file.originalName ?? m.file.id}
                          </div>
                          <audio controls preload="none" src={normalizeDownloadUrl(m.file.downloadUrl)} style={{ maxWidth: 320 }} />
                        </div>
                      ) : (
                        <a href={normalizeDownloadUrl(m.file.downloadUrl)} target="_blank" rel="noreferrer">
                          Файл: {m.file.originalName ?? m.file.id}
                        </a>
                      )
                    ) : (
                      <span>
                        {m.type === "voice" ? "Голосовое" : "Файл"}: {m.file.originalName ?? m.file.id}{" "}
                        <button className="chip" onClick={() => void hydrateDownloadUrl(m.id, m.file!.id)}>
                          получить ссылку
                        </button>
                      </span>
                    )
                  ) : (
                    "(файл)"
                  )
                ) : (
                  m.content ? m.content : "(удалено)"
                )}
                <span className="bubbleTime">
                  {m.author?.email === email ? "✓✓ " : ""}
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
                  <button className="msgMenuItem" onClick={() => void editMessageInChat(m.id)} disabled={m.author?.email !== email}>
                    Редактировать
                  </button>
                  <button className="msgMenuItem danger" onClick={() => void deleteMessageInChat(m.id)} disabled={m.author?.email !== email}>
                    Удалить
                  </button>
                </div>
              ) : null}
              <div className="reactions">
                {quickEmojis.map((e) => (
                  <button key={`q-${m.id}-${e}`} onClick={() => void toggleReaction(m.id, e)} className="chip">
                    {e}
                  </button>
                ))}
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
        </section>
        {showScrollToBottom ? (
          <button
            className="scrollDownBtn"
            onClick={() => {
              stickToBottomRef.current = true;
              messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
            }}
            title="Вниз"
          >
            ↓
          </button>
        ) : null}

        <form onSubmit={(e) => void sendMessage(e)} className="composer">
          {isRecordingVoice ? (
            <div className="voiceHoldBar" style={{ gridColumn: "1 / -1" }}>
              <span className="dot" />
              Идет запись: {Math.floor(voiceHoldMs / 60000)
                .toString()
                .padStart(2, "0")}
              :
              {Math.floor((voiceHoldMs % 60000) / 1000)
                .toString()
                .padStart(2, "0")} (отпустите кнопку для отправки)
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
            onMouseDown={onVoiceMouseDown}
            onMouseUp={stopVoiceRecord}
            onMouseLeave={stopVoiceRecord}
            onTouchStart={onVoiceTouchStart}
            onTouchEnd={onVoiceTouchEnd}
            onTouchCancel={onVoiceTouchEnd}
            disabled={uploadDisabled}
            title={isRecordingVoice ? "Отпустите, чтобы отправить" : "Удерживайте для записи"}
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
                    onClick={() => setNewMessage((prev) => (prev ? `${prev} ${s}` : s))}
                    title="Добавить стикер в сообщение"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </form>
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
              <div className="infoPanelHeroAvatar">
                {mode === "channels"
                  ? "#"
                  : mode === "groups"
                    ? initials(activeGroupChat?.name ?? "G")
                    : (() => {
                        const otherId = activeDirectChat?.userIds.find((id) => id !== userId) ?? activeDirectChat?.userIds[0] ?? "";
                        const u = users.find((x) => x.id === otherId);
                        return initials(u?.email ?? otherId ?? "DM");
                      })()}
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
                      ? (() => {
                          const otherId =
                            activeDirectChat.userIds.find((id) => id !== userId) ?? activeDirectChat.userIds[0] ?? "";
                          const u = users.find((x) => x.id === otherId);
                          return u?.email ?? otherId ?? activeDirectChat.id;
                        })()
                      : "Личка не выбрана"}
              </div>
              <p className="infoPanelHeroSub">
                {organizationId ? `Организация: ${displayOrganizationId}` : "—"} · {myProfileEmail || email}
              </p>
              <div className="infoPanelSection">
                <div className="infoPanelSectionTitle">Действия</div>
                <button
                  type="button"
                  className="moreMenuWideBtn"
                  onClick={() => {
                    setShowCompanyCabinet(true);
                    setCompanyTab("employees");
                    void loadUsers();
                  }}
                  disabled={!token || !organizationId}
                >
                  Кабинет компании
                </button>
                {isCompanyAdmin ? (
                  <button
                    type="button"
                    className="moreMenuWideBtn"
                    onClick={() => void openAdminUsersPanel()}
                    disabled={!token || !organizationId}
                  >
                    Админ: пользователи
                  </button>
                ) : null}
                <button
                  type="button"
                  className="moreMenuWideBtn"
                  onClick={() => {
                    setShowUserCabinet(true);
                    setProfileMsg("");
                    void loadMyProfile();
                  }}
                  disabled={!token}
                >
                  Мой профиль
                </button>
                {mode === "channels" && activeChannelId ? (
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
                ) : null}
              </div>
              <p className="infoPanelFootnote">Медиа, файлы и участники в общем списке — следующие итерации UI.</p>
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
                    ? "Выберите одного собеседника"
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
                    <span className="newChatWizardEmail">{u.email}</span>
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
