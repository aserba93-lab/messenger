let io = null;
export function setIo(server) {
    io = server;
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
