/** Освобождение камеры/мика перед новым getUserMedia (иначе «Device in use» в Electron и после записи голоса). */
export async function getUserMediaWithRelease(
  constraints: MediaStreamConstraints,
  release?: () => void | Promise<void>,
): Promise<MediaStream> {
  if (release) await Promise.resolve(release());
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
      await new Promise((r) => setTimeout(r, 500));
      return await navigator.mediaDevices.getUserMedia(constraints);
    }
    throw e;
  }
}
