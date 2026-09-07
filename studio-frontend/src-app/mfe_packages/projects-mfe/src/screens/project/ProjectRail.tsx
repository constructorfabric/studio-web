import React from 'react';
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
} from '@gears-frontx/ui-kit';
import {
  CalendarDays,
  ClipboardCheck,
  FileText,
  LayoutDashboard,
  RotateCcw,
  Settings,
  Users,
} from 'lucide-react';
import { useProjectText } from '../../i18n';
import { useThemedRoot } from '../../shared/useThemedRoot';
import { requestSection } from '../../actions/projectsActions';
import type { ProjectSection } from '../../slices/navSlice';
import styles from './ProjectRail.module.css';

const SECTIONS: readonly { section: ProjectSection; icon: React.ReactNode }[] = [
  { section: 'overview', icon: <LayoutDashboard /> },
  { section: 'artifacts', icon: <FileText /> },
  { section: 'findings', icon: <ClipboardCheck /> },
  { section: 'activity', icon: <RotateCcw /> },
  { section: 'timeline', icon: <CalendarDays /> },
  { section: 'team', icon: <Users /> },
];

const SETTINGS: ProjectSection = 'settings';

interface ProjectRailProps {
  section: ProjectSection;
}

// @cpt-dod:cpt-studiofrontend-dod-project-artifacts-rail:p1
export const ProjectRail: React.FC<ProjectRailProps> = ({ section }) => {
  const t = useProjectText();
  const [open, setOpen] = React.useState(false);
  const [themedRoot, findThemedRoot] = useThemedRoot();

  const closeOnBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setOpen(false);
  };

  const item = (entry: { section: ProjectSection; icon: React.ReactNode }) => {
    const label = t(`section_${entry.section}`);
    return (
      <SidebarMenuItem key={entry.section}>
        <SidebarMenuButton
          className={styles.item}
          isActive={entry.section === section}
          tooltip={{ children: label, side: 'right', container: themedRoot ?? undefined }}
          onClick={() => requestSection(entry.section)}
        >
          <span className={styles.glyph}>{entry.icon}</span>
          <span>{label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  return (
    <SidebarProvider
      ref={findThemedRoot}
      open={open}
      className={styles.provider}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={closeOnBlur}
    >
      <Sidebar collapsible="icon" className={styles.panel}>
        <SidebarContent className={styles.content}>
          <SidebarMenu className={styles.menu}>
            {SECTIONS.map(item)}
            <SidebarSeparator className={styles.rule} />
            {item({ section: SETTINGS, icon: <Settings /> })}
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  );
};

ProjectRail.displayName = 'ProjectRail';
