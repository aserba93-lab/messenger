/** Освобождение камеры/мика перед новым getUserMedia (иначе «Device in use» в Electron и после записи голоса). */

/** Ограничения для звонка: на iPhone/iPad Safari нужен facingMode, иначе часто NotAllowedError. */
export function avConstraintsForCall(audioOnly: boolean): MediaStreamConstraints {
  if (audioOnly) return { audio: true, video: false };
  if (typeof navigator === "undefined") return { audio: true, video: true };
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  if (isIOS) {
    return {
      audio: true,
      video: { facingMode: "user" },
    };
  }
  return { audio: true, video: true };
}

export async function getUserMediaWithRelease(
  constraints: MediaStreamConstraints,
  release?: () => void | Promise<void>,
): Promise<MediaStream> {
  if (release) {
    const r = release();
    if (r != null && typeof (r as Promise<void>).then === "function") {
      await r;
    }
  }
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    const err = e as DOMException;
    const msg = String(err?.message ?? e ?? "");
    if (
      err?.name === "NotReadableError" ||
      err?.name === "AbortError" ||
      /in use|busy|could not start/i.test(msg)
    ) {
      await new Promise((res) => setTimeout(res, 500));
      return await navigator.mediaDevices.getUserMedia(constraints);
    }
    throw e;
  }
}
