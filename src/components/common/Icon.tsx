import type { CSSProperties } from "react";

const paths = {
  upload: "M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5",
  download: "M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5",
  trash: "M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7",
  external: "M14 3h7v7M21 3l-11 11M10 3H3v18h18v-7",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M6 18 18 6",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  server: "M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6",
  terminal: "m4 6 5 5-5 5M12 17h8",
  folder: "M3 7V4h6l3 3h9v13H3z",
  file: "M14 2H5v20h14V7zM14 2v6h5",
  history: "M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2",
  monitor: "M4 20V10M10 20V4M16 20v-8M22 20V7",
  vault: "M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4M12 14v3",
  snippets: "m8 5-6 7 6 7M16 5l6 7-6 7M14 3l-4 18",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 2h6l1 4 4 1 2 5-3 3 1 4-5 3-3-3-4 1-3-5 3-3-1-4 4-2z",
  panel: "M3 3h18v18H3zM9 3v18",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z",
  edit: "m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z",
  chevron: "m9 5 7 7-7 7",
  refresh: "M20 7A9 9 0 1 0 21 14M20 2v6h-6",
  transfer: "M4 7h16l-4-4M20 17H4l4 4",
} as const;

export type IconName = keyof typeof paths;

export default function Icon({
  name,
  size = 16,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, ...style }}
    >
      <path d={paths[name]} />
    </svg>
  );
}
