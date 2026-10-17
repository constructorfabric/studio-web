import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppSelector, useMfeBridge } from '@gears-frontx/react';
import { notify, type ScreenText, type StudioNotice } from '@constructor-studio/mfe-shared';
import { useSpecsSectionTranslations, useSpecsText } from '../../../../i18n';
import { behindPhase, fileName, type SpecsCheckOutcome } from '../../../../model/specsCheck';
import {
  SPECS_CHECK_SLICE_KEY,
  outcomeShown,
  type SpecsCheck,
} from '../../../../slices/specsCheckSlice';

/** One toast per project: its progress, then its outcome, in place. */
export const specsCheckToastId = (projectId: string): string => `specs-check:${projectId}`;

function outcomeNotice(t: ScreenText, project: string, outcome: SpecsCheckOutcome): StudioNotice {
  switch (outcome.kind) {
    case 'checked': {
      const checked = t.count('check_checked', outcome.checked);
      const summary =
        outcome.findings === null
          ? checked
          : t('check_summary', { checked, findings: t.count('check_findings', outcome.findings) });
      if (outcome.unchecked === 0) {
        return { kind: 'success', text: t('check_done', { project, summary }) };
      }
      const unchecked = t.count('check_unchecked', outcome.unchecked);
      const text = outcome.reason
        ? t('check_partial_because', { project, summary, unchecked, reason: outcome.reason })
        : t('check_partial', { project, summary, unchecked });
      return { kind: 'info', text };
    }
    case 'stopped': {
      const { done, total, error } = outcome;
      const text = error
        ? t('check_stopped_because', { project, done, total, error })
        : t('check_stopped', { project, done, total });
      return { kind: 'error', text };
    }
    case 'not_started': {
      const text = outcome.reason
        ? t('check_not_started_because', { project, reason: outcome.reason })
        : t('check_not_started', { project });
      return { kind: 'error', text };
    }
    case 'lost':
      return { kind: 'info', text: t('check_lost', { project }) };
  }
}

/** What a check's toast says now. */
export function checkNotice(t: ScreenText, check: SpecsCheck): StudioNotice {
  const { project, count, outcome } = check;
  if (outcome) return outcomeNotice(t, project, outcome);
  const phase = behindPhase(Object.values(check.phases));
  const text = phase
    ? t.count('check_progress_at', count, {
        project,
        step: phase.step,
        total: phase.total,
        file: fileName(phase.path),
      })
    : t.count('check_progress', count, { project });
  return { kind: 'loading', text };
}

/**
 * Turns each project's check into the shell's toast (#691): the effect has
 * neither the bridge nor this dictionary. Leaving the projects screen turns a
 * running check's toast into a note that it goes on; coming back picks it up.
 */
export function useSpecsCheckToasts(): void {
  const { isLoaded } = useSpecsSectionTranslations();
  const t = useSpecsText();
  const bridge = useMfeBridge();
  const dispatch = useAppDispatch();
  const checks = useAppSelector((state) => state[SPECS_CHECK_SLICE_KEY].checks);
  /** What each project's toast says, so a render that changes nothing sends nothing. */
  const said = useRef(new Map<string, string>());
  const leave = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!isLoaded) return;
    const shown = said.current;
    for (const [projectId, check] of Object.entries(checks)) {
      const notice = checkNotice(t, check);
      const text = `${notice.kind}:${notice.text}`;
      if (shown.get(projectId) !== text) {
        notify(bridge, { ...notice, id: specsCheckToastId(projectId) }, 'projects');
        shown.set(projectId, text);
      }
      if (check.outcome) {
        shown.delete(projectId);
        dispatch(outcomeShown(projectId));
      }
    }
    leave.current = () => {
      for (const projectId of shown.keys()) {
        const project = checks[projectId]?.project ?? '';
        notify(
          bridge,
          { kind: 'info', text: t('check_left', { project }), id: specsCheckToastId(projectId) },
          'projects'
        );
      }
      shown.clear();
    };
  }, [isLoaded, checks, t, bridge, dispatch]);

  useEffect(() => () => leave.current(), []);
}
