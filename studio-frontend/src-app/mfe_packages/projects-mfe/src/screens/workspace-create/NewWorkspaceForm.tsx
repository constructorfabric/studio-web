/** The New workspace form */

// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-overlay:p1
// @cpt-dod:cpt-studiofrontend-dod-workspace-scope-announce:p1
import React, { useCallback, useEffect, useRef } from 'react';
import { eventBus, useAppDispatch, useAppSelector, useMfeBridge } from '@gears-frontx/react';
import { Button, Input, Label, Skeleton } from '@gears-frontx/ui-kit';
import {
  OrganizationProvider,
  refusalFrom,
  useHostChrome,
  useOrganization,
} from '@constructor-studio/mfe-shared';
import { useWorkspaceCreateScreenTranslations, useWorkspaceCreateText } from '../../i18n';
import {
  closeWorkspaceForm,
  publishCreatedWorkspace,
  requestWorkspaceCreate,
} from '../../actions/workspaceActions';
import '../../events/workspaceEvents';
import {
  WORKSPACE_CREATE_SLICE_KEY,
  editWorkspaceName,
  resetWorkspaceForm,
  workspaceAnnounceFailed,
  workspaceSubmitStarted,
  type CreatedWorkspace,
} from '../../slices/workspaceSlice';
import styles from './NewWorkspaceForm.module.css';

const FormBody: React.FC = () => {
  const bridge = useMfeBridge();
  const { containerRef, dataTheme } = useHostChrome();
  const { isLoaded, error: translationsFailed } = useWorkspaceCreateScreenTranslations();
  const t = useWorkspaceCreateText();
  const dispatch = useAppDispatch();

  const name = useAppSelector((state) => state[WORKSPACE_CREATE_SLICE_KEY].name);
  const submitting = useAppSelector((state) => state[WORKSPACE_CREATE_SLICE_KEY].submitting);
  const error = useAppSelector((state) => state[WORKSPACE_CREATE_SLICE_KEY].error);
  const created = useAppSelector((state) => state[WORKSPACE_CREATE_SLICE_KEY].created);
  const { org, loading: orgLoading } = useOrganization();
  const orgId = org?.id ?? null;

  useEffect(() => {
    dispatch(resetWorkspaceForm());
  }, [dispatch]);

  const announceToShell = useCallback(
    async (workspace: CreatedWorkspace): Promise<void> => {
      try {
        await publishCreatedWorkspace(
          bridge,
          { id: workspace.id, name: workspace.name },
          workspace.orgId
        );
      } catch (error) {
        dispatch(workspaceAnnounceFailed({ workspace, error: refusalFrom(error, 'error_announce') }));
        return;
      }
      await closeWorkspaceForm(bridge);
    },
    [bridge, dispatch]
  );

  useEffect(() => {
    const subscription = eventBus.on('mfe/workspaces/created', (workspace) => {
      void announceToShell(workspace);
    });
    return () => subscription.unsubscribe();
  }, [announceToShell]);

  /** The skeleton is for the first load and nothing else. */
  const everLoaded = useRef(false);
  everLoaded.current ||= isLoaded;
  const showSkeleton = !everLoaded.current && !translationsFailed;

  const blocked = submitting || (!created && (orgLoading || !orgId || !name.trim()));

  const submit = (): void => {
    if (blocked) return;
    if (created) {
      dispatch(workspaceSubmitStarted());
      void announceToShell(created);
      return;
    }
    if (!orgId) return;
    requestWorkspaceCreate(orgId, name);
  };

  return (
    <div ref={containerRef} className={styles.form} data-theme={dataTheme}>
      {showSkeleton ? (
        <Skeleton className={styles.titleSkeleton} />
      ) : (
        <h2 className={styles.title}>{t('title')}</h2>
      )}

      {showSkeleton ? (
        <Skeleton className={styles.bodySkeleton} />
      ) : (
        <div className={styles.field}>
          <Label className={styles.fieldLabel} htmlFor="ws-name">
            {t('field_name')}
          </Label>
          <Input
            id="ws-name"
            autoFocus
            value={name}
            placeholder={t('field_name_placeholder')}
            disabled={submitting || !!created}
            onChange={(event) => dispatch(editWorkspaceName(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
          <span className={styles.fieldHint}>{t('field_name_hint')}</span>
        </div>
      )}

      {(translationsFailed || error || (!created && !orgId && !orgLoading)) && (
        <p className={styles.error} role="alert">
          {translationsFailed
            ? 'Could not load this screen.'
            : error
              ? error.kind === 'i18n'
                ? t(error.key)
                : error.text
              : t('error_no_org')}
        </p>
      )}

      <div className={styles.footer}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void closeWorkspaceForm(bridge)}
          disabled={submitting}
        >
          {t('cancel')}
        </Button>
        <Button size="sm" onClick={submit} disabled={blocked}>
          {created ? t('retry') : t('create')}
        </Button>
      </div>
    </div>
  );
};

FormBody.displayName = 'WorkspaceFormBody';

export const NewWorkspaceForm: React.FC = () => (
  <OrganizationProvider>
    <FormBody />
  </OrganizationProvider>
);

NewWorkspaceForm.displayName = 'NewWorkspaceForm';
