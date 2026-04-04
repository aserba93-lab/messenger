import { prisma } from "../db/prisma.js";
let io = null;
export function setIo(server) {
    io = server;
}
/** DM: доставляем в комнаты user:<id>, иначе получатель не в dm:<chatId> не увидит сообщение в реальном времени */
export async function emitDmToMemberUsers(directChatId, event, payload) {
    if (!io)
        return;
    const members = await prisma.directChatMember.findMany({
        where: { directChatId },
        select: { userId: true },
    });
    for (const m of members) {
        io.to(`user:${m.userId}`).emit(event, payload);
    }
}
export function emitToChannel(channelId, event, payload) {
    if (!io)
        return;
    io.to(`channel:${channelId}`).emit(event, payload);
}
export function emitToRoom(room, event, payload) {
    if (!io)
        return;
    io.to(room).emit(event, payload);
}
export function emitToUser(userId, event, payload) {
    if (!io)
        return;
    io.to(`user:${userId}`).emit(event, payload);
}
