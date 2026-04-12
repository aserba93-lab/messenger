import type { SVGProps } from "react";

const S = {
  stroke: "currentColor",
  fill: "none" as const,
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function TgIconSearch(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden {...props}>
      <circle cx="11" cy="11" r="7" {...S} />
      <path d="M21 21l-4.3-4.3" {...S} />
    </svg>
  );
}

export function TgIconPhone(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden {...props}>
      <path
        d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.81.3 1.6.57 2.36a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.72-1.14a2 2 0 0 1 2.11-.45c.76.27 1.55.45 2.36.57A2 2 0 0 1 22 16.92z"
        {...S}
      />
    </svg>
  );
}

export function TgIconInfo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden {...props}>
      <circle cx="12" cy="12" r="10" {...S} />
      <path d="M12 16v-4M12 8h.01" {...S} />
    </svg>
  );
}

export function TgIconPaperclip(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden {...props}>
      <path
        d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
        {...S}
      />
    </svg>
  );
}

export function TgIconMic(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden {...props}>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" {...S} />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" {...S} />
    </svg>
  );
}

export function TgIconSmile(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden {...props}>
      <circle cx="12" cy="12" r="10" {...S} />
      <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" {...S} />
    </svg>
  );
}

export function TgIconSend(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden {...props}>
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" {...S} />
    </svg>
  );
}

export function TgIconChevronLeft(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden {...props}>
      <path d="M15 18l-6-6 6-6" {...S} />
    </svg>
  );
}

export function TgIconPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden {...props}>
      <path d="M12 5v14M5 12h14" {...S} />
    </svg>
  );
}
