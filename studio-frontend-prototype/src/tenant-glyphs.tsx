// The drawings behind tenant-icon.ts's glyph names: every one from icons.tsx,
// so a workspace's mark is drawn the way the shell's controls are.
import type { ComponentType } from "react";

import {
  BellIcon,
  BoltIcon,
  BookIcon,
  BoxIcon,
  ChartIcon,
  CloudIcon,
  CodeIcon,
  DatabaseIcon,
  FlagIcon,
  FlaskIcon,
  FolderIcon,
  GearIcon,
  GlobeIcon,
  GridIcon,
  HeartIcon,
  LayersIcon,
  LeafIcon,
  LockIcon,
  RocketIcon,
  ShieldIcon,
  SlidersIcon,
  SparkleIcon,
  StarIcon,
  UsersIcon,
  type IconProps,
} from "./icons";
import type { ICON_GLYPHS } from "./tenant-icon";

export const GLYPHS: Record<(typeof ICON_GLYPHS)[number], ComponentType<IconProps>> = {
  folder: FolderIcon,
  box: BoxIcon,
  gear: GearIcon,
  code: CodeIcon,
  grid: GridIcon,
  layers: LayersIcon,
  database: DatabaseIcon,
  globe: GlobeIcon,
  rocket: RocketIcon,
  sparkle: SparkleIcon,
  star: StarIcon,
  heart: HeartIcon,
  flag: FlagIcon,
  bolt: BoltIcon,
  leaf: LeafIcon,
  flask: FlaskIcon,
  chart: ChartIcon,
  cloud: CloudIcon,
  lock: LockIcon,
  shield: ShieldIcon,
  users: UsersIcon,
  book: BookIcon,
  bell: BellIcon,
  sliders: SlidersIcon,
};

/** One glyph by name; a name nobody draws is a grid. */
export function TenantGlyph({ glyph, size = 14 }: { glyph: string; size?: number }) {
  const Glyph = GLYPHS[glyph as keyof typeof GLYPHS] ?? GridIcon;
  return <Glyph size={size} />;
}
