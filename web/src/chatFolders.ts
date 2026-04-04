/** Папки для группировки чатов в списке: кэш в localStorage + синхронизация через `chatFoldersJson` на сервере. */

const STORAGE_KEY = "tg:chatFolders:v1";

export type ChatFolderDef = {
  id: string;
  name: string;
  order: number;
};

export type ChatFolderState = {
  folders: ChatFolderDef[];
  /** chatKey (напр. "d:xxx") → folderId; отсутствие ключа — чат «вне папок» */
  assignment: Record<string, string>;
};

const defaultState = (): ChatFolderState => ({ folders: [], assignment: {} });

/** Разбор JSON с сервера или для импорта — та же схема, что и в localStorage. */
export function parseChatFolderStateJson(raw: string): ChatFolderState | null {
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== "object") return null;
    const o = p as Record<string, unknown>;
    const folders = Array.isArray(o.folders)
      ? (o.folders as unknown[])
          .filter((f) => f && typeof f === "object" && f !== null)
          .map((f, i) => {
            const x = f as Record<string, unknown>;
            return {
              id: String(x.id ?? ""),
              name: String(x.name ?? ""),
              order: typeof x.order === "number" ? x.order : i,
            };
          })
          .filter((f) => f.id.length > 0 && f.name.length > 0)
      : [];
    const assignment: Record<string, string> =
      o.assignment && typeof o.assignment === "object"
        ? Object.fromEntries(
            Object.entries(o.assignment as Record<string, unknown>).filter(
              ([k, v]) => typeof k === "string" && k.length > 0 && typeof v === "string" && v.length > 0,
            ) as [string, string][],
          )
        : {};
    return { folders, assignment };
  } catch {
    return null;
  }
}

export function loadChatFolders(): ChatFolderState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = parseChatFolderStateJson(raw);
    if (!parsed) return defaultState();
    const folders = parsed.folders.map((f, i) => ({ id: f.id, name: f.name.slice(0, 64), order: typeof f.order === "number" ? f.order : i }));
    return { folders, assignment: parsed.assignment };
  } catch {
    return defaultState();
  }
}

export function saveChatFolders(state: ChatFolderState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export function createFolderId(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
