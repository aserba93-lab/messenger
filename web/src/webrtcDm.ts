import type { Socket } from "socket.io-client";

const DEFAULT_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export type CallSignalPayload =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };

function parseIceFromEnv(): RTCIceServer[] {
  try {
    const raw = (import.meta as any).env?.VITE_ICE_SERVERS as string | undefined;
    if (raw && raw.trim()) return JSON.parse(raw) as RTCIceServer[];
  } catch {
    /* ignore */
  }
  return DEFAULT_ICE;
}

export type ActiveCall = {
  pc: RTCPeerConnection;
  localStream: MediaStream;
  hangup: () => void;
};

/** Исходящий звонок: создаём offer и шлём targetUserId через сокет */
export async function startOutgoingCall(
  socket: Socket,
  opts: {
    targetUserId: string;
    audioOnly: boolean;
    onRemoteStream: (s: MediaStream) => void;
    onClose: () => void;
  },
): Promise<ActiveCall> {
  const iceServers = parseIceFromEnv();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: !opts.audioOnly,
  });
  const pc = new RTCPeerConnection({ iceServers });
  for (const t of stream.getTracks()) pc.addTrack(t, stream);
  pc.ontrack = (ev) => {
    if (ev.streams[0]) opts.onRemoteStream(ev.streams[0]);
  };

  const target = opts.targetUserId;
  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    socket.emit("call:signal", {
      targetUserId: target,
      payload: {
        type: "ice",
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex,
      },
    });
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("call:signal", {
    targetUserId: target,
    payload: { type: "offer", sdp: offer.sdp || "" },
  });

  const onSignal = async (data: { fromUserId?: string; payload?: CallSignalPayload }) => {
    if (String(data?.fromUserId) !== target) return;
    const p = data.payload;
    if (!p) return;
    if (p.type === "answer" && p.sdp) {
      await pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
    } else if (p.type === "ice" && p.candidate) {
      try {
        await pc.addIceCandidate(
          new RTCIceCandidate({
            candidate: p.candidate,
            sdpMid: p.sdpMid ?? undefined,
            sdpMLineIndex: p.sdpMLineIndex ?? undefined,
          }),
        );
      } catch {
        /* ignore */
      }
    }
  };
  const onEnd = (data: { fromUserId?: string }) => {
    if (String(data?.fromUserId) === target) cleanup();
  };

  socket.on("call:signal", onSignal);
  socket.on("call:end", onEnd);

  function cleanup() {
    socket.off("call:signal", onSignal);
    socket.off("call:end", onEnd);
    stream.getTracks().forEach((t) => t.stop());
    try {
      pc.close();
    } catch {
      /* ignore */
    }
    opts.onClose();
  }

  return {
    pc,
    localStream: stream,
    hangup: () => {
      socket.emit("call:end", { targetUserId: target });
      cleanup();
    },
  };
}

/** Входящий offer — отвечаем answer */
export async function acceptIncomingOffer(
  socket: Socket,
  opts: {
    fromUserId: string;
    offerSdp: string;
    audioOnly: boolean;
    onRemoteStream: (s: MediaStream) => void;
    onClose: () => void;
  },
): Promise<ActiveCall> {
  const iceServers = parseIceFromEnv();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: !opts.audioOnly,
  });
  const pc = new RTCPeerConnection({ iceServers });
  for (const t of stream.getTracks()) pc.addTrack(t, stream);
  pc.ontrack = (ev) => {
    if (ev.streams[0]) opts.onRemoteStream(ev.streams[0]);
  };

  const peer = opts.fromUserId;
  await pc.setRemoteDescription({ type: "offer", sdp: opts.offerSdp });

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    socket.emit("call:signal", {
      targetUserId: peer,
      payload: {
        type: "ice",
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex,
      },
    });
  };

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("call:signal", {
    targetUserId: peer,
    payload: { type: "answer", sdp: answer.sdp || "" },
  });

  const onSignal = async (data: { fromUserId?: string; payload?: CallSignalPayload }) => {
    if (String(data?.fromUserId) !== peer) return;
    const p = data.payload;
    if (p?.type === "ice" && p.candidate) {
      try {
        await pc.addIceCandidate(
          new RTCIceCandidate({
            candidate: p.candidate,
            sdpMid: p.sdpMid ?? undefined,
            sdpMLineIndex: p.sdpMLineIndex ?? undefined,
          }),
        );
      } catch {
        /* ignore */
      }
    }
  };
  const onEnd = (data: { fromUserId?: string }) => {
    if (String(data?.fromUserId) === peer) cleanup();
  };

  socket.on("call:signal", onSignal);
  socket.on("call:end", onEnd);

  function cleanup() {
    socket.off("call:signal", onSignal);
    socket.off("call:end", onEnd);
    stream.getTracks().forEach((t) => t.stop());
    try {
      pc.close();
    } catch {
      /* ignore */
    }
    opts.onClose();
  }

  return {
    pc,
    localStream: stream,
    hangup: () => {
      socket.emit("call:end", { targetUserId: peer });
      cleanup();
    },
  };
}
