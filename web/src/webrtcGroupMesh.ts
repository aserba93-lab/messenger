import type { Socket } from "socket.io-client";
import type { CallSignalPayload } from "./webrtcDm";

/** Полносвязный mesh WebRTC внутри организации (тот же сокет, что и 1:1). Без SFU: нагрузка растёт с N², поэтому жёсткий лимит участников. */
export const GROUP_MESH_MAX_PEERS = 12;

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

function parseIceFromEnv(): RTCIceServer[] {
  try {
    const raw = (import.meta as any).env?.VITE_ICE_SERVERS as string | undefined;
    if (raw && raw.trim()) return JSON.parse(raw) as RTCIceServer[];
  } catch {
    /* ignore */
  }
  return DEFAULT_ICE;
}

function createPeerConnection(iceServers: RTCIceServer[]): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: 5,
    bundlePolicy: "balanced",
    rtcpMuxPolicy: "require",
  } as RTCConfiguration);
}

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
  let remoteMediaStream: MediaStream | null = null;
  const notify = () => {
    if (remoteMediaStream) onRemoteStream(remoteMediaStream);
  };
  pc.ontrack = (ev) => {
    const t = ev.track;
    const fromEvent = ev.streams && ev.streams[0];
    if (fromEvent) {
      if (!remoteMediaStream || remoteMediaStream.id === fromEvent.id) {
        remoteMediaStream = fromEvent;
      } else if (!remoteMediaStream.getTracks().some((x) => x.id === t.id)) {
        try {
          remoteMediaStream.addTrack(t);
        } catch {
          /* ignore */
        }
      }
    } else {
      if (!remoteMediaStream) remoteMediaStream = new MediaStream();
      if (!remoteMediaStream.getTracks().some((x) => x.id === t.id)) {
        remoteMediaStream.addTrack(t);
      }
    }
    t.addEventListener("unmute", notify);
    t.addEventListener("mute", notify);
    t.addEventListener("ended", () => {
      try {
        remoteMediaStream?.removeTrack(t);
      } catch {
        /* ignore */
      }
      t.removeEventListener("unmute", notify);
      t.removeEventListener("mute", notify);
      notify();
    });
    notify();
  };
}

function emitSignal(socket: Socket, targetUserId: string, payload: CallSignalPayload, groupChatId: string) {
  socket.emit("call:signal", { targetUserId, payload, groupChatId });
}

function setupIceRecoveryMesh(pc: RTCPeerConnection, socket: Socket, peerUserId: string, groupChatId: string) {
  let lastRestartAt = 0;
  const tryRestart = () => {
    const now = Date.now();
    if (now - lastRestartAt < 4000) return;
    lastRestartAt = now;
    try {
      void (async () => {
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        emitSignal(socket, peerUserId, { type: "offer", sdp: offer.sdp || "" }, groupChatId);
      })();
    } catch {
      /* ignore */
    }
  };
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === "failed" || s === "disconnected") tryRestart();
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "failed" || s === "disconnected") tryRestart();
  };
}

type PeerLink = {
  pc: RTCPeerConnection;
  iceQueue: ReturnType<typeof makeIceCandidateQueue>;
  role: "offer" | "answer";
};

export class GroupMeshSession {
  readonly groupChatId: string;
  private readonly myUserId: string;
  private readonly socket: Socket;
  private readonly localStream: MediaStream;
  private readonly onRemoteStream: (peerId: string, stream: MediaStream) => void;
  private readonly onPeerDisconnected?: (peerId: string) => void;
  private readonly audioOnly: boolean;
  private readonly links = new Map<string, PeerLink>();
  private readonly iceEarly = new Map<string, RTCIceCandidateInit[]>();
  private closed = false;
  private savedCamVideoTrack: MediaStreamTrack | null = null;
  private screenShareEnd: (() => Promise<void>) | null = null;

  constructor(
    socket: Socket,
    opts: {
      groupChatId: string;
      myUserId: string;
      localStream: MediaStream;
      audioOnly: boolean;
      onRemoteStream: (peerId: string, stream: MediaStream) => void;
      onPeerDisconnected?: (peerId: string) => void;
    },
  ) {
    this.socket = socket;
    this.groupChatId = opts.groupChatId;
    this.myUserId = opts.myUserId;
    this.localStream = opts.localStream;
    this.onRemoteStream = opts.onRemoteStream;
    this.onPeerDisconnected = opts.onPeerDisconnected;
    this.audioOnly = opts.audioOnly;
  }

  private iceServers() {
    return parseIceFromEnv();
  }

  async startOfferers(peerIds: string[]) {
    for (const peerId of peerIds) {
      if (this.myUserId < peerId) {
        await this.startAsOfferer(peerId);
      }
    }
  }

  private async startAsOfferer(peerId: string) {
    if (this.closed || this.links.has(peerId)) return;
    const iceServers = this.iceServers();
    const pc = createPeerConnection(iceServers);
    const iceQueue = makeIceCandidateQueue(pc);
    for (const t of this.localStream.getTracks()) {
      pc.addTrack(t, this.localStream);
    }
    attachRemoteTracks(pc, (s) => this.onRemoteStream(peerId, s));
    setupIceRecoveryMesh(pc, this.socket, peerId, this.groupChatId);

    this.links.set(peerId, { pc, iceQueue, role: "offer" });

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || this.closed) return;
      emitSignal(this.socket, peerId, {
        type: "ice",
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex,
      }, this.groupChatId);
    };

    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: !this.audioOnly });
    await pc.setLocalDescription(offer);
    emitSignal(this.socket, peerId, { type: "offer", sdp: offer.sdp || "" }, this.groupChatId);
  }

  async handleSignal(data: { fromUserId?: string; groupChatId?: string; payload?: CallSignalPayload }) {
    if (this.closed) return;
    if (String(data?.groupChatId ?? "") !== this.groupChatId) return;
    const from = String(data?.fromUserId ?? "");
    const p = data?.payload;
    if (!from || !p) return;

    const link = this.links.get(from);
    if (link) {
      await this.dispatch(from, link, p);
      return;
    }

    if (p.type === "ice" && p.candidate) {
      const buf = this.iceEarly.get(from) ?? [];
      buf.push({
        candidate: p.candidate,
        sdpMid: p.sdpMid ?? undefined,
        sdpMLineIndex: p.sdpMLineIndex ?? undefined,
      });
      this.iceEarly.set(from, buf);
      return;
    }

    if (p.type === "offer" && p.sdp && this.myUserId > from) {
      await this.startAsAnswerer(from, p.sdp);
    }
  }

  private async dispatch(peerId: string, link: PeerLink, p: CallSignalPayload) {
    const { pc, iceQueue } = link;
    try {
      if (p.type === "answer" && p.sdp && link.role === "offer") {
        await pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
        await iceQueue.flush();
      } else if (p.type === "offer" && p.sdp && link.role === "offer") {
        await pc.setRemoteDescription({ type: "offer", sdp: p.sdp });
        await iceQueue.flush();
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        emitSignal(this.socket, peerId, { type: "answer", sdp: ans.sdp || "" }, this.groupChatId);
      } else if (p.type === "offer" && p.sdp && link.role === "answer") {
        await pc.setRemoteDescription({ type: "offer", sdp: p.sdp });
        await iceQueue.flush();
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        emitSignal(this.socket, peerId, { type: "answer", sdp: ans.sdp || "" }, this.groupChatId);
      } else if (p.type === "ice" && p.candidate) {
        await iceQueue.push({
          candidate: p.candidate,
          sdpMid: p.sdpMid ?? undefined,
          sdpMLineIndex: p.sdpMLineIndex ?? undefined,
        });
      }
    } catch {
      /* ignore */
    }
  }

  private async startAsAnswerer(fromUserId: string, offerSdp: string) {
    if (this.closed || this.links.has(fromUserId)) return;
    const iceServers = this.iceServers();
    const pc = createPeerConnection(iceServers);
    const iceQueue = makeIceCandidateQueue(pc);
    for (const t of this.localStream.getTracks()) {
      pc.addTrack(t, this.localStream);
    }
    attachRemoteTracks(pc, (s) => this.onRemoteStream(fromUserId, s));
    setupIceRecoveryMesh(pc, this.socket, fromUserId, this.groupChatId);

    this.links.set(fromUserId, { pc, iceQueue, role: "answer" });

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || this.closed) return;
      emitSignal(this.socket, fromUserId, {
        type: "ice",
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex,
      }, this.groupChatId);
    };

    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    await iceQueue.flush();
    const early = this.iceEarly.get(fromUserId);
    if (early?.length) {
      for (const init of early) {
        await iceQueue.push(init);
      }
      this.iceEarly.delete(fromUserId);
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    emitSignal(this.socket, fromUserId, { type: "answer", sdp: answer.sdp || "" }, this.groupChatId);
  }

  handleCallEnd(fromUserId: string) {
    if (this.closed) return;
    this.removePeer(fromUserId);
  }

  private removePeer(peerId: string) {
    const link = this.links.get(peerId);
    if (!link) return;
    this.links.delete(peerId);
    try {
      link.pc.close();
    } catch {
      /* ignore */
    }
    this.onPeerDisconnected?.(peerId);
  }

  isScreenSharing(): boolean {
    return this.screenShareEnd != null;
  }

  /** Демонстрация экрана всем участникам mesh (как в 1:1). */
  async startScreenShare(): Promise<void> {
    if (this.closed) throw new Error("Созвон завершён");
    if (this.audioOnly) throw new Error("Демонстрация экрана только в видеозвонке");
    const cam = this.localStream.getVideoTracks()[0];
    if (!cam) throw new Error("Нет видеотрека камеры");
    if (this.screenShareEnd) return;

    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: false,
    });
    const screenTrack = display.getVideoTracks()[0];
    if (!screenTrack) {
      display.getTracks().forEach((t) => t.stop());
      throw new Error("Нет видео экрана");
    }

    this.savedCamVideoTrack = cam;
    screenTrack.addEventListener("ended", () => {
      void this.stopScreenShare().catch(() => {});
    });

    try {
      this.localStream.removeTrack(cam);
      this.localStream.addTrack(screenTrack);
    } catch {
      /* ignore */
    }

    for (const [, link] of this.links) {
      const sender = link.pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(screenTrack);
    }

    this.screenShareEnd = async () => {
      screenTrack.stop();
      try {
        this.localStream.removeTrack(screenTrack);
      } catch {
        /* ignore */
      }
      const restore = this.savedCamVideoTrack;
      this.savedCamVideoTrack = null;
      if (restore && restore.readyState === "live") {
        try {
          this.localStream.addTrack(restore);
        } catch {
          /* ignore */
        }
        for (const [, link] of this.links) {
          const sender = link.pc.getSenders().find((s) => s.track?.kind === "video");
          if (sender) await sender.replaceTrack(restore);
        }
      }
      this.screenShareEnd = null;
    };
  }

  async stopScreenShare(): Promise<void> {
    if (this.screenShareEnd) await this.screenShareEnd();
  }

  hangupAll() {
    if (this.closed) return;
    void this.stopScreenShare().catch(() => {});
    this.closed = true;
    const peers = [...this.links.keys()];
    for (const peerId of peers) {
      try {
        this.socket.emit("call:end", { targetUserId: peerId });
      } catch {
        /* ignore */
      }
      this.removePeer(peerId);
    }
    this.iceEarly.clear();
    try {
      this.localStream.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
  }
}

export function prepareGroupMeshPeerIds(myUserId: string, peerUserIds: string[]): string[] {
  const peers = [...new Set(peerUserIds)].filter((id) => id && id !== myUserId).sort();
  if (peers.length > GROUP_MESH_MAX_PEERS) {
    throw new Error(
      `Слишком много участников для внутреннего группового звонка (максимум ${GROUP_MESH_MAX_PEERS}). Выберите меньше людей в группе или позвоните по одному.`,
    );
  }
  return peers;
}

export async function createGroupMeshSession(
  socket: Socket,
  opts: {
    groupChatId: string;
    myUserId: string;
    peerUserIds: string[];
    audioOnly: boolean;
    onRemoteStream: (peerId: string, stream: MediaStream) => void;
    onPeerDisconnected?: (peerId: string) => void;
  },
): Promise<{ session: GroupMeshSession; localStream: MediaStream; peerIds: string[] }> {
  const peers = prepareGroupMeshPeerIds(opts.myUserId, opts.peerUserIds);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: !opts.audioOnly,
  });
  const session = new GroupMeshSession(socket, {
    groupChatId: opts.groupChatId,
    myUserId: opts.myUserId,
    localStream: stream,
    audioOnly: opts.audioOnly,
    onRemoteStream: opts.onRemoteStream,
    onPeerDisconnected: opts.onPeerDisconnected,
  });
  return { session, localStream: stream, peerIds: peers };
}
