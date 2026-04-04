/** Локальные папки для группировки чатов в списке (без сервера). */

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

export function loadChatFolders(): ChatFolderState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const p = JSON.parse(raw) as ChatFolderState;
    if (!p || typeof p !== "object") return defaultState();
    const folders = Array.isArray(p.folders)
      ? p.folders
          .filter((f) => f && typeof f.id === "string" && typeof f.name === "string")
          .map((f, i) => ({ id: f.id, name: f.name.slice(0, 64), order: typeof f.order === "number" ? f.order : i }))
      : [];
    const assignment =
      p.assignment && typeof p.assignment === "object"
        ? Object.fromEntries(
            Object.entries(p.assignment).filter(
              ([k, v]) => typeof k === "string" && k.length > 0 && typeof v === "string" && v.length > 0,
            ),
          )
        : {};
    return { folders, assignment };
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
