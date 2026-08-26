/**
 * Turns this MFE's own intents into `projects/nav` state. Nothing here talks to
 * the shell: outbound publication goes through `bridge.executeActionsChain`
 * (see actions/projectsActions.ts).
 *
 * What is deliberately NOT here: subscriptions to the shell's
 * `app/context/project/changed` / `project/closed`. Those are emitted on the
 * SHELL's eventBus, and an MFE runs in an isolated module realm with its own
 * instance — a subscription here would simply never fire. The switcher's
 * selection arrives as a shared property instead, applied in ProjectsRoot, and it
 * dispatches straight into the slice: routing it through these events would
 * republish it to the shell.
 *
 * No fetching here. Server state is read by components through `useApiQuery`.
 */

import { eventBus, type AppDispatch } from '@gears-frontx/react';
import { closeProject, openProject, selectSection, type ProjectSection } from '../slices/navSlice';
import '../events/projectsEvents';

const SECTIONS: readonly ProjectSection[] = [
  'overview',
  'artifacts',
  'findings',
  'activity',
  'timeline',
  'team',
  'settings',
];

function asSection(value: string): ProjectSection | null {
  return (SECTIONS as readonly string[]).includes(value) ? (value as ProjectSection) : null;
}

export function initProjectsEffects(dispatch: AppDispatch): void {
  eventBus.on('mfe/projects/open-requested', ({ id }) => {
    dispatch(openProject(id));
  });

  eventBus.on('mfe/projects/close-requested', () => {
    dispatch(closeProject());
  });

  eventBus.on('mfe/projects/section-selected', ({ section }) => {
    const next = asSection(section);
    if (next) dispatch(selectSection(next));
  });
}
