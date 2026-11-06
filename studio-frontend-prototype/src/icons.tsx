// The shell's icon set: one drawing style for every control glyph.
//
// The header used to mix four sets side by side — a gradient-filled text ✦,
// a colour-emoji bell, a colour-emoji control-knobs and a text avatar — and
// emoji look different on every OS. Every glyph here is drawn the way
// ViewToggle's are: a 16-unit grid, a 1.6 round-capped stroke in
// `currentColor`, no fill, so a control's colour (and dark mode) decides the
// icon's colour and they all read as one set. Hand-drawn paths, no icon font
// or package, so nothing is fetched and nothing new is installed.
import type { ReactNode, SVGProps } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  /** Rendered width and height in px. The paths sit on a 16-unit grid, so at
   *  the default the stroke is exactly 1.6px. */
  size?: number;
}

function icon(name: string, paths: ReactNode) {
  function Icon({ size = 16, className, ...rest }: IconProps) {
    const labelled = rest["aria-label"] !== undefined;
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className ? `icon ${className}` : "icon"}
        aria-hidden={labelled ? undefined : true}
        role={labelled ? "img" : undefined}
        focusable="false"
        {...rest}
      >
        {paths}
      </svg>
    );
  }
  Icon.displayName = `${name}Icon`;
  return Icon;
}

/** Studio AI's mark: a four-point sparkle with a small one beside it. */
export const SparkleIcon = icon(
  "Sparkle",
  <>
    <path d="M7 2c.4 2.6 1.6 3.8 4.2 4.2C8.6 6.6 7.4 7.8 7 10.4 6.6 7.8 5.4 6.6 2.8 6.2 5.4 5.8 6.6 4.6 7 2z" />
    <path d="M12.5 10v4M10.5 12h4" />
  </>,
);

export const BellIcon = icon(
  "Bell",
  <>
    <path d="M4 11V7a4 4 0 0 1 8 0v4l1.3 1.5H2.7z" />
    <path d="M6.5 14.3a1.6 1.6 0 0 0 3 0" />
  </>,
);

/** The filters panel: three sliders, knobs at different stops. */
export const SlidersIcon = icon(
  "Sliders",
  <>
    <path d="M2 4h6M11 4h3M2 8h2M7 8h7M2 12h8M13 12h1" />
    <circle cx="9.5" cy="4" r="1.5" />
    <circle cx="5.5" cy="8" r="1.5" />
    <circle cx="11.5" cy="12" r="1.5" />
  </>,
);

export const MenuIcon = icon("Menu", <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />);

/** More of what this place offers: three dots in a row. */
export const MoreIcon = icon(
  "More",
  <>
    <circle cx="3.5" cy="8" r="0.9" />
    <circle cx="8" cy="8" r="0.9" />
    <circle cx="12.5" cy="8" r="0.9" />
  </>,
);

/** The inbox: a tray with what came in. */
export const InboxIcon = icon(
  "Inbox",
  <>
    <path d="M2.5 9.5 4.2 3.5h7.6l1.7 6v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
    <path d="M2.5 9.5h3l1 1.5h3l1-1.5h3" />
  </>,
);

/** Pinned to the rail: a push pin. */
export const PinIcon = icon("Pin", <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" />);

export const CloseIcon = icon("Close", <path d="M4 4l8 8M12 4l-8 8" />);

export const CheckIcon = icon("Check", <path d="M3 8.5l3.2 3L13 4.5" />);

export const ChevronRightIcon = icon("ChevronRight", <path d="M6 3.5 10.5 8 6 12.5" />);

export const ArrowUpIcon = icon("ArrowUp", <path d="M8 13V3M4 7l4-4 4 4" />);

export const RefreshIcon = icon(
  "Refresh",
  <>
    <path d="M14 8a6 6 0 1 1-6-6c1.7 0 3.3.7 4.5 1.8L14 5.3" />
    <path d="M14 2v3.3h-3.3" />
  </>,
);

export const GearIcon = icon(
  "Gear",
  <>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.7v2M8 12.3v2M1.7 8h2M12.3 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4" />
  </>,
);

/** Administration: the same shield the nav rail's `shield` icon draws. */
export const ShieldIcon = icon("Shield", <path d="M8 1.8l5 2v3.6c0 3-2 5.1-5 6.3-3-1.2-5-3.3-5-6.3V3.8z" />);

/** Studio itself in the product menu: four tiles, as ViewToggle's tiles. */
export const GridIcon = icon(
  "Grid",
  <>
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </>,
);

/** Docs & API: an open book. */
export const BookIcon = icon(
  "Book",
  <path d="M8 4.3C6.3 2.9 4.5 2.7 2.5 3.5v9.2c2-.8 3.8-.6 5.5.8 1.7-1.4 3.5-1.6 5.5-.8V3.5c-2-.8-3.8-.6-5.5.8zM8 4.3v9.2" />,
);

/** How Studio is built, in the product menu: three stacked layers, as the
 *  page draws the gears. */
export const LayersIcon = icon(
  "Layers",
  <>
    <path d="M8 2.2l5.8 2.9L8 8 2.2 5.1z" />
    <path d="M2.2 8.1L8 11l5.8-2.9" />
    <path d="M2.2 11.1L8 14l5.8-2.9" />
  </>,
);

/* ── Marks a workspace or a project may wear (tenant-glyphs.tsx) ── */

export const FolderIcon = icon("Folder", <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.7l1.5 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />);

export const BoxIcon = icon(
  "Box",
  <>
    <path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" />
    <path d="M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4" />
  </>,
);

export const CodeIcon = icon("Code", <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3l-2 10" />);

export const DatabaseIcon = icon(
  "Database",
  <>
    <ellipse cx="8" cy="3.8" rx="5" ry="1.8" />
    <path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" />
  </>,
);

export const GlobeIcon = icon(
  "Globe",
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c1.7 1.7 2.5 3.7 2.5 6S9.7 12.3 8 14C6.3 12.3 5.5 10.3 5.5 8S6.3 3.7 8 2z" />
  </>,
);

export const RocketIcon = icon(
  "Rocket",
  <>
    <path d="M9.5 2.5c2-.6 3.6-.6 4 0 .6.4.6 2-.1 4L8.5 11.3 4.7 7.5z" />
    <path d="M4.7 7.5 2.5 7l2-2.5 3 .2M8.5 11.3 9 13.5l2.5-2-.2-3" />
    <path d="M4 12c-.6.6-1 1.6-1 1.6s1-.4 1.6-1" />
  </>,
);

export const StarIcon = icon("Star", <path d="M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z" />);

export const HeartIcon = icon("Heart", <path d="M8 13.5S2 10 2 6a3 3 0 0 1 6-1 3 3 0 0 1 6 1c0 4-6 7.5-6 7.5z" />);

export const FlagIcon = icon("Flag", <path d="M3.5 14V2.5M3.5 3c3-1.5 5 1.5 9 0v6c-4 1.5-6-1.5-9 0" />);

export const BoltIcon = icon("Bolt", <path d="M9 1.8 3.5 9H8l-1 5.2L12.5 7H8z" />);

export const LeafIcon = icon(
  "Leaf",
  <>
    <path d="M3 13c0-6 3.5-9.5 10-10 0 6.5-3.5 10-9 10z" />
    <path d="M3 13l5.5-5.5" />
  </>,
);

export const FlaskIcon = icon(
  "Flask",
  <>
    <path d="M6 2h4M6.5 2v4L2.8 12.5A1 1 0 0 0 3.7 14h8.6a1 1 0 0 0 .9-1.5L9.5 6V2" />
    <path d="M4.5 9.5h7" />
  </>,
);

export const ChartIcon = icon("Chart", <path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" />);

export const CloudIcon = icon("Cloud", <path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.6-1A3.3 3.3 0 0 1 11.5 12.5z" />);

export const LockIcon = icon(
  "Lock",
  <>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </>,
);

export const UsersIcon = icon(
  "Users",
  <>
    <circle cx="6" cy="5.5" r="2.3" />
    <path d="M2 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4M10.5 3.4a2.3 2.3 0 0 1 0 4.3M14 13.5c0-1.8-1-3.2-2.5-3.8" />
  </>,
);
