import type { Socket } from "socket.io-client";

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

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
  audioOnly: boolean;
  hangup: () => void;
  setMicEnabled: (on: boolean) => void;
  setCamEnabled: (on: boolean) => void;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => Promise<void>;
  isScreenSharing: () => boolean;
};

function createPeerConnection(iceServers: RTCIceServer[]): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: 10,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  } as RTCConfiguration);
}

/** ICE иногда приходит до установки remoteDescription — буферизуем и сливаем после setRemote. */
function makeIceCandidateQueue(pc: RTCPeerConnection) {
  const pending: RTCIceCandidateInit[] = [];
  const flush = async () => {
    if (!pc.remoteDescription) return;
    while (pending.length) {
      const init = pending.shift()!;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(init));
      } catch {
        /* ignore */
      }
    }
  };
  return {
    push: async (init: RTCIceCandidateInit) => {
      pending.push(init);
      await flush();
    },
    flush,
  };
}

function attachRemoteTracks(pc: RTCPeerConnection, onRemoteStream: (s: MediaStream) => void) {
  const remoteMediaStream = new MediaStream();
  pc.ontrack = (ev) => {
    const t = ev.track;
    const existing = remoteMediaStream.getTracks().some((x) => x.id === t.id);
    if (!existing) {
      remoteMediaStream.addTrack(t);
    }
    t.addEventListener("ended", () => {
      try {
        remoteMediaStream.removeTrack(t);
      } catch {
        /* ignore */
      }
      onRemoteStream(remoteMediaStream);
    });
    onRemoteStream(remoteMediaStream);
  };
}

async function emitRenegotiationOffer(pc: RTCPeerConnection, socket: Socket, targetUserId: string) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("call:signal", {
    targetUserId,
    payload: { type: "offer", sdp: offer.sdp || "" },
  });
}

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
  const pc = createPeerConnection(iceServers);
  const iceQueue = makeIceCandidateQueue(pc);
  for (const t of stream.getTracks()) pc.addTrack(t, stream);
  attachRemoteTracks(pc, opts.onRemoteStream);

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
    if (p.type === "offer" && p.sdp) {
      await pc.setRemoteDescription({ type: "offer", sdp: p.sdp });
      await iceQueue.flush();
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit("call:signal", {
        targetUserId: target,
        payload: { type: "answer", sdp: ans.sdp || "" },
      });
    } else if (p.type === "answer" && p.sdp) {
      await pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
      await iceQueue.flush();
    } else if (p.type === "ice" && p.candidate) {
      await iceQueue.push({
        candidate: p.candidate,
        sdpMid: p.sdpMid ?? undefined,
        sdpMLineIndex: p.sdpMLineIndex ?? undefined,
      });
    }
  };
  const onEnd = (data: { fromUserId?: string }) => {
    if (String(data?.fromUserId) === target) cleanup();
  };

  socket.on("call:signal", onSignal);
  socket.on("call:end", onEnd);

  let screenStop: (() => Promise<void>) | null = null;
  let screenAudioSender: RTCRtpSender | null = null;

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

  const startScreenShareWrapped = async () => {
    if (opts.audioOnly) throw new Error("Демонстрация экрана доступна в видеозвонке");
    if (screenStop) return;

    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: true,
    });

    const v = display.getVideoTracks()[0];
    if (!v) {
      display.getTracks().forEach((t) => t.stop());
      throw new Error("Нет видеодорожки экрана");
    }

    const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
    const cam = stream.getVideoTracks()[0];
    if (!videoSender || !cam) {
      display.getTracks().forEach((t) => t.stop());
      throw new Error("Нет видеотрека камеры");
    }

    const savedCamTrack = cam;
    await videoSender.replaceTrack(v);
    try {
      v.contentHint = "detail";
    } catch {
      /* ignore */
    }

    v.addEventListener("ended", () => {
      void stopScreenShareWrapped();
    });

    const displayAudios = display.getAudioTracks().filter((t) => t.readyState === "live");
    for (const at of displayAudios) {
      at.addEventListener("ended", () => {
        if (screenAudioSender && screenAudioSender.track === at) {
          try {
            pc.removeTrack(screenAudioSender);
          } catch {
            /* ignore */
          }
          screenAudioSender = null;
          void emitRenegotiationOffer(pc, socket, target);
        }
      });
      screenAudioSender = pc.addTrack(at, stream);
      break;
    }

    await emitRenegotiationOffer(pc, socket, target);

    screenStop = async () => {
      display.getTracks().forEach((t) => t.stop());
      if (screenAudioSender) {
        try {
          pc.removeTrack(screenAudioSender);
        } catch {
          /* ignore */
        }
        screenAudioSender = null;
      }
      await videoSender.replaceTrack(savedCamTrack);
      screenStop = null;
      await emitRenegotiationOffer(pc, socket, target);
    };
  };

  const stopScreenShareWrapped = async () => {
    if (screenStop) await screenStop();
  };

  return {
    pc,
    localStream: stream,
    audioOnly: opts.audioOnly,
    hangup: () => {
      void stopScreenShareWrapped();
      socket.emit("call:end", { targetUserId: target });
      cleanup();
    },
    setMicEnabled: (on: boolean) => {
      stream.getAudioTracks().forEach((t) => {
        if (screenAudioSender?.track && t.id === screenAudioSender.track.id) return;
        t.enabled = on;
      });
    },
    setCamEnabled: (on: boolean) => {
      if (opts.audioOnly) return;
      stream.getVideoTracks().forEach((t) => {
        t.enabled = on;
      });
    },
    startScreenShare: startScreenShareWrapped,
    stopScreenShare: stopScreenShareWrapped,
    isScreenSharing: () => screenStop != null,
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
  const pc = createPeerConnection(iceServers);
  const iceQueue = makeIceCandidateQueue(pc);
  for (const t of stream.getTracks()) pc.addTrack(t, stream);
  attachRemoteTracks(pc, opts.onRemoteStream);

  const peer = opts.fromUserId;

  const onSignal = async (data: { fromUserId?: string; payload?: CallSignalPayload }) => {
    if (String(data?.fromUserId) !== peer) return;
    const p = data.payload;
    if (!p) return;
    if (p.type === "offer" && p.sdp) {
      await pc.setRemoteDescription({ type: "offer", sdp: p.sdp });
      await iceQueue.flush();
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit("call:signal", {
        targetUserId: peer,
        payload: { type: "answer", sdp: ans.sdp || "" },
      });
    } else if (p.type === "answer" && p.sdp) {
      await pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
      await iceQueue.flush();
    } else if (p.type === "ice" && p.candidate) {
      await iceQueue.push({
        candidate: p.candidate,
        sdpMid: p.sdpMid ?? undefined,
        sdpMLineIndex: p.sdpMLineIndex ?? undefined,
      });
    }
  };
  const onEnd = (data: { fromUserId?: string }) => {
    if (String(data?.fromUserId) === peer) cleanup();
  };

  socket.on("call:signal", onSignal);
  socket.on("call:end", onEnd);

  await pc.setRemoteDescription({ type: "offer", sdp: opts.offerSdp });
  await iceQueue.flush();

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

  let screenStop: (() => Promise<void>) | null = null;
  let screenAudioSender: RTCRtpSender | null = null;

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

  const startScreenShareWrapped = async () => {
    if (opts.audioOnly) throw new Error("Демонстрация экрана доступна в видеозвонке");
    if (screenStop) return;

    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: true,
    });

    const v = display.getVideoTracks()[0];
    if (!v) {
      display.getTracks().forEach((t) => t.stop());
      throw new Error("Нет видеодорожки экрана");
    }

    const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
    const cam = stream.getVideoTracks()[0];
    if (!videoSender || !cam) {
      display.getTracks().forEach((t) => t.stop());
      throw new Error("Нет видеотрека камеры");
    }

    const savedCamTrack = cam;
    await videoSender.replaceTrack(v);
    try {
      v.contentHint = "detail";
    } catch {
      /* ignore */
    }

    v.addEventListener("ended", () => {
      void stopScreenShareWrapped();
    });

    const displayAudios = display.getAudioTracks().filter((t) => t.readyState === "live");
    for (const at of displayAudios) {
      at.addEventListener("ended", () => {
        if (screenAudioSender && screenAudioSender.track === at) {
          try {
            pc.removeTrack(screenAudioSender);
          } catch {
            /* ignore */
          }
          screenAudioSender = null;
          void emitRenegotiationOffer(pc, socket, peer);
        }
      });
      screenAudioSender = pc.addTrack(at, stream);
      break;
    }

    await emitRenegotiationOffer(pc, socket, peer);

    screenStop = async () => {
      display.getTracks().forEach((t) => t.stop());
      if (screenAudioSender) {
        try {
          pc.removeTrack(screenAudioSender);
        } catch {
          /* ignore */
        }
        screenAudioSender = null;
      }
      await videoSender.replaceTrack(savedCamTrack);
      screenStop = null;
      await emitRenegotiationOffer(pc, socket, peer);
    };
  };

  const stopScreenShareWrapped = async () => {
    if (screenStop) await screenStop();
  };

  return {
    pc,
    localStream: stream,
    audioOnly: opts.audioOnly,
    hangup: () => {
      void stopScreenShareWrapped();
      socket.emit("call:end", { targetUserId: peer });
      cleanup();
    },
    setMicEnabled: (on: boolean) => {
      stream.getAudioTracks().forEach((t) => {
        if (screenAudioSender?.track && t.id === screenAudioSender.track.id) return;
        t.enabled = on;
      });
    },
    setCamEnabled: (on: boolean) => {
      if (opts.audioOnly) return;
      stream.getVideoTracks().forEach((t) => {
        t.enabled = on;
      });
    },
    startScreenShare: startScreenShareWrapped,
    stopScreenShare: stopScreenShareWrapped,
    isScreenSharing: () => screenStop != null,
  };
}
