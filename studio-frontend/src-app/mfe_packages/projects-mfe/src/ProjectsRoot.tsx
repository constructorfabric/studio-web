import React, { useEffect, useRef } from 'react';
import {
  useAppDispatch,
  useAppSelector,
  useMfeBridge,
  useSharedProperty,
} from '@gears-frontx/react';
import {
  STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
  STUDIO_SHARED_PROPERTY_CONTEXT_SECTION,
  useHostChrome,
} from '@constructor-studio/mfe-shared';
import { ProjectListScreen } from './screens/project-list/ProjectListScreen';
import { ProjectScreen } from './screens/project/ProjectScreen';
import {
  NAV_SLICE_KEY,
  closeProject,
  openProject,
  selectSection,
  isProjectSection,
} from './slices/navSlice';
import { StudioScopeProvider } from './shared/workspaceProjects';
import { publishWorkspaceScope } from './actions/workspaceActions';
import { useSpecsCheckToasts } from './shared/useSpecsCheckToasts';
import { useUploadToasts } from './shared/useUploadToasts';
import styles from './ProjectsRoot.module.css';

/** This MFE's screen-domain root. */

// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-slot:p1
export const ProjectsRoot: React.FC = () => {
  const { containerRef, dataTheme } = useHostChrome();
  const bridge = useMfeBridge();
  const dispatch = useAppDispatch();

  useEffect(() => {
    publishWorkspaceScope(bridge);
  }, [bridge]);
  // Here, not in the Specs section: a check's toast outlives a switch of section or project.
  useSpecsCheckToasts();
  useUploadToasts();
  const projectId = useAppSelector((state) => state[NAV_SLICE_KEY].projectId);

  const projectIdRef = useRef(projectId);
  useEffect(() => {
    projectIdRef.current = projectId;
  });

  const publishedProject = useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT);

  useEffect(() => {
    const next = typeof publishedProject === 'string' && publishedProject ? publishedProject : null;
    if (next === projectIdRef.current) return;
    dispatch(next ? openProject(next) : closeProject());
  }, [publishedProject, dispatch]);

  const publishedSection = useSharedProperty(STUDIO_SHARED_PROPERTY_CONTEXT_SECTION);

  // Re-applied when the project changes too: `openProject` lands on Overview, and
  // a direct link publishes the section before the project (ADR-0028, #881).
  useEffect(() => {
    if (!isProjectSection(publishedSection)) return;
    dispatch(selectSection(publishedSection));
  }, [publishedSection, projectId, dispatch]);

  return (
    <div ref={containerRef} className={styles.root} data-theme={dataTheme}>
      <StudioScopeProvider>
        {projectId ? <ProjectScreen projectId={projectId} /> : <ProjectListScreen />}
      </StudioScopeProvider>
    </div>
  );
};

ProjectsRoot.displayName = 'ProjectsRoot';
