/**
 * The New project wizard — this MFE's second mounted root, drawn inside the
 * shell's overlay frame.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-steps:p1
import React, { useEffect } from 'react';
import {
  apiRegistry,
  eventBus,
  invalidateQueryCacheForApp,
  useFrontX,
} from '@gears-frontx/react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { useAppDispatch, useAppSelector } from '@gears-frontx/react';
import { Button } from '@gears-frontx/ui-kit';
import { BridgeProvider } from '../../shared/bridge';
import { useHostChrome } from '../../shared/useHostChrome';
import { useProjectCreateScreenTranslations, useProjectCreateText } from '../../i18n';
import { closeProjectWizard, requestProjectCreate } from '../../actions/wizardActions';
import '../../events/wizardEvents';
import { CREATE_SLICE_KEY, editDraft, goToStep, resetWizard } from '../../slices/createSlice';
import { OrganizationProvider, useOrganization } from '../../shared/organization';
import { useCurrentUser } from '../../shared/useCurrentUser';
import { AccountsApiService, childrenPageParams } from '../../api/AccountsApiService';
import { isFinalStep, nextStep, prevStep, stepFor, type WizardStepKey } from '../../model/wizardSteps';
import { DetailsStep } from './steps/DetailsStep';
import { RepositoriesStep } from './steps/RepositoriesStep';
import { RepositoriesFooterNote } from './steps/RepositoriesFooterNote';
import styles from './NewProjectWizard.module.css';

/** One entry per step key. Adding a step touches this map and `WIZARD_STEPS`. */
const STEP_BODIES: Record<WizardStepKey, React.FC> = {
  details: DetailsStep,
  repositories: RepositoriesStep,
};

/**
 * What a step contributes to the left of the footer buttons. Optional, and a
 * second map rather than a field on `WizardStep`: `wizardSteps` is pure logic
 * with no React in it, and it is worth keeping that way.
 */
const STEP_FOOTER_NOTES: Partial<Record<WizardStepKey, React.FC>> = {
  repositories: RepositoriesFooterNote,
};

interface NewProjectWizardProps {
  bridge: ChildMfeBridge;
}

const WizardBody: React.FC<NewProjectWizardProps> = ({ bridge }) => {
  const { containerRef, dataTheme } = useHostChrome(bridge);
  const { isLoaded } = useProjectCreateScreenTranslations();
  const t = useProjectCreateText();
  const dispatch = useAppDispatch();

  const stepKey = useAppSelector((state) => state[CREATE_SLICE_KEY].stepKey);
  const draft = useAppSelector((state) => state[CREATE_SLICE_KEY].draft);
  const submitting = useAppSelector((state) => state[CREATE_SLICE_KEY].submitting);
  const error = useAppSelector((state) => state[CREATE_SLICE_KEY].error);
  const { org, loading: orgLoading } = useOrganization();
  const orgId = org?.id ?? null;

  // Every opening starts clean. The store outlives this root (it belongs to the
  // MFE app, which `init.ts` builds once for any entry), so without this a
  // half-filled draft would reappear with no affordance explaining why.
  useEffect(() => {
    dispatch(resetWizard());
  }, [dispatch]);

  const { id: currentUserId } = useCurrentUser(bridge);
  useEffect(() => {
    if (currentUserId && !draft.ownerId) dispatch(editDraft({ ownerId: currentUserId }));
  }, [currentUserId, draft.ownerId, dispatch]);


  const step = stepFor(draft, stepKey);
  const back = prevStep(draft, step.key);
  const final = isFinalStep(draft, step.key);
  const Body = STEP_BODIES[step.key];
  const FooterNote = STEP_FOOTER_NOTES[step.key];

  const app = useFrontX();

  useEffect(() => {
    const subscription = eventBus.on('mfe/projects/created', () => {
      if (orgId) {
        const accounts = apiRegistry.getService(AccountsApiService);
        void invalidateQueryCacheForApp(app, accounts.children(childrenPageParams(orgId)));
      }
      closeProjectWizard(bridge);
    });
    return () => subscription.unsubscribe();
  }, [app, bridge, orgId]);

  const onPrimary = (): void => {
    if (final) {
      if (!orgId) return;
      requestProjectCreate(orgId, draft);
      return;
    }
    const next = nextStep(draft, step.key);
    if (next) dispatch(goToStep(next.key));
  };

  const onSecondary = (): void => {
    if (back) dispatch(goToStep(back.key));
    else closeProjectWizard(bridge);
  };

  return (
    <div ref={containerRef} className={styles.wizard} data-theme={dataTheme}>
      <BridgeProvider bridge={bridge}>
        <h2 className={styles.title}>{isLoaded ? t(step.titleKey) : ''}</h2>

        <div className={styles.body}>
          <Body />
        </div>

        {(error || (final && !orgId && !orgLoading)) && (
          <p className={styles.error} role="alert">
            {error ?? t('error_no_org')}
          </p>
        )}

        <div className={styles.footer}>
          {/* Left slot is the step's to fill — the pick counter on repositories. */}
          <div className={styles.footerNote}>{FooterNote ? <FooterNote /> : null}</div>
          <Button variant="ghost" size="sm" onClick={onSecondary} disabled={submitting}>
            {back ? t('back') : t('cancel')}
          </Button>
          <Button
            size="sm"
            onClick={onPrimary}
            disabled={
              submitting || orgLoading || !step.isComplete(draft) || (final && !orgId)
            }
          >
            {final ? t('create') : t('continue')}
          </Button>
        </div>
      </BridgeProvider>
    </div>
  );
};

WizardBody.displayName = 'WizardBody';

export const NewProjectWizard: React.FC<NewProjectWizardProps> = ({ bridge }) => (
  <OrganizationProvider bridge={bridge}>
    <WizardBody bridge={bridge} />
  </OrganizationProvider>
);

NewProjectWizard.displayName = 'NewProjectWizard';
