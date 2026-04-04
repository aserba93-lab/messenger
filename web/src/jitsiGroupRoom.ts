/** Комната Jitsi Meet для группового звонка (внешний SFU). Имя комнаты — только безопасные символы. */

export function jitsiRoomSlug(organizationId: string, groupChatId: string): string {
  const raw = `sf-${organizationId}-${groupChatId}`;
  return raw
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 200);
}

export function jitsiMeetEmbedUrl(origin: string, roomSlug: string): string {
  const o = origin.replace(/\/$/, "");
  const room = encodeURIComponent(roomSlug);
  return `${o}/${room}#config.startWithAudioMuted=false&config.startWithVideoMuted=false`;
}

export function defaultJitsiOrigin(): string {
  const v = (import.meta as unknown as { env?: { VITE_JITSI_ORIGIN?: string } }).env?.VITE_JITSI_ORIGIN;
  if (v && v.trim()) return v.trim().replace(/\/$/, "");
  return "https://meet.jit.si";
}
