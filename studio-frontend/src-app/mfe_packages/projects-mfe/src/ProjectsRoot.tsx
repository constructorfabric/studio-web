import React, { useEffect, useRef } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { useAppDispatch, useAppSelector } from '@gears-frontx/react';
import { BridgeProvider } from './shared/bridge';
import { useHostChrome } from './shared/useHostChrome';
import { ProjectListScreen } from './screens/project-list/ProjectListScreen';
import { ProjectScreen } from './screens/project/ProjectScreen';
import { NAV_SLICE_KEY, closeProject, openProject } from './slices/navSlice';
import { STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT } from './shared/hostProperties';
import styles from './ProjectsRoot.module.css';

interface ProjectsRootProps {
  bridge: ChildMfeBridge;
}

/**
 * This MFE's screen-domain root. Not its only root any more: the New project
 * wizard is a second extension of the same MFE in the shell's overlay domain,
 * with its own bridge and its own shadow root (`NewProjectWizard`). The chrome
 * both of them need lives in `useHostChrome`; what stays here is the half that
 * is the screen's alone — the shell's project selection.
 *
 * Which screen shows is `projects/nav`, not a route — the shell has no router,
 * and ADR-0008 puts the project's own rail inside this frame.
 */
export const ProjectsRoot: React.FC<ProjectsRootProps> = ({ bridge }) => {
  const { containerRef, dataTheme } = useHostChrome(bridge);
  const dispatch = useAppDispatch();
  const projectId = useAppSelector((state) => state[NAV_SLICE_KEY].projectId);

  // Read inside the subscription without re-subscribing on every navigation.
  // Written in a deps-less effect, not during render: a discarded render
  // (StrictMode's double-invoke) would leave the ref ahead of what committed.
  const projectIdRef = useRef(projectId);
  useEffect(() => {
    projectIdRef.current = projectId;
  });

  /**
   * The shell's selection, applied to this MFE's own navigation — the half
   * ADR-0008 left out. The top bar's switcher clicks are `app/context/*` events
   * on the SHELL's eventBus, inaudible here; this property is what crosses.
   *
   * Two things the mechanism does NOT do, both load-bearing: it never fires on
   * subscribe, so the current value is read separately (which doubles as the
   * bridge-swap path), and it does not dedupe. Since the shell echoes back the
   * opens this MFE started, an unguarded apply would re-dispatch `openProject`
   * and reset the section to `overview` — clicking Team would bounce back.
   */
  useEffect(() => {
    const apply = (raw: unknown): void => {
      const next = typeof raw === 'string' && raw ? raw : null;
      if (next === projectIdRef.current) return;
      dispatch(next ? openProject(next) : closeProject());
    };

    apply(bridge.getProperty(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT)?.value);
    return bridge.subscribeToProperty(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT, (property) =>
      apply(property.value)
    );
  }, [bridge, dispatch]);

  return (
    <div ref={containerRef} className={styles.root} data-theme={dataTheme}>
      <BridgeProvider bridge={bridge}>
        {projectId ? (
          <ProjectScreen bridge={bridge} projectId={projectId} />
        ) : (
          <ProjectListScreen />
        )}
      </BridgeProvider>
    </div>
  );
};

ProjectsRoot.displayName = 'ProjectsRoot';
