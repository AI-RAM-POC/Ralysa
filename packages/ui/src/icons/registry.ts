// Icon registry (F-001 design §3.4; AC-7). The only module that imports lucide-react: the
// `icon-set` group in tooling/eslint-config/boundaries.js bans it everywhere else (ESLint,
// dependency-cruiser and check-banned-deps). Each entry says whether the icon is directional:
// drawn for LTR and mirrored in RTL (back/forward, chevrons, send, undo/redo). Non-directional
// icons never mirror (search, check, close, status symbols). Media and charts are not icons.
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Inbox,
  Info,
  Languages,
  LoaderCircle,
  Lock,
  type LucideIcon,
  Minus,
  Monitor,
  Moon,
  Redo2,
  Search,
  Send,
  Sun,
  Undo2,
  X,
} from 'lucide-react';

export interface IconDef {
  component: LucideIcon;
  /** true = drawn for LTR and mirrored in RTL. */
  directional: boolean;
}

export const ICONS = {
  // Directional: mirrored in RTL.
  back: { component: ArrowLeft, directional: true },
  forward: { component: ArrowRight, directional: true },
  chevronStart: { component: ChevronLeft, directional: true },
  chevronEnd: { component: ChevronRight, directional: true },
  send: { component: Send, directional: true },
  undo: { component: Undo2, directional: true },
  redo: { component: Redo2, directional: true },
  // Non-directional: never mirrored.
  search: { component: Search, directional: false },
  check: { component: Check, directional: false },
  close: { component: X, directional: false },
  chevronDown: { component: ChevronDown, directional: false },
  minus: { component: Minus, directional: false },
  alert: { component: CircleAlert, directional: false },
  info: { component: Info, directional: false },
  lock: { component: Lock, directional: false },
  inbox: { component: Inbox, directional: false },
  loading: { component: LoaderCircle, directional: false },
  language: { component: Languages, directional: false },
  themeLight: { component: Sun, directional: false },
  themeDark: { component: Moon, directional: false },
  themeSystem: { component: Monitor, directional: false },
} as const satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;

// Pure, so an app that renders no icon tree-shakes the registry and the icon set away.
export const ICON_NAMES = /* @__PURE__ */ Object.keys(ICONS) as IconName[];
