/** The Connect source form */

// @cpt-dod:cpt-studiofrontend-dod-connection-create-overlay:p1
// @cpt-dod:cpt-studiofrontend-dod-connection-create-verify:p1
// @cpt-dod:cpt-studiofrontend-dod-connection-create-announce:p1
// @cpt-dod:cpt-studiofrontend-dod-connection-create-refusal:p1
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  apiRegistry,
  eventBus,
  useApiQuery,
  useAppDispatch,
  useAppSelector,
  useMfeBridge,
} from '@gears-frontx/react';
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@gears-frontx/ui-kit';
import { ConnectorsApiService, OrganizationProvider, useHostChrome, useOrganization } from '@constructor-studio/mfe-shared';
import { useConnectSourceScreenTranslations, useConnectSourceText } from '../../i18n';
import { isDraftUsable } from '../../model/connectionDraft';
import { CONNECT_SLICE_KEY, editDraft, resetForm } from '../../slices/connectSlice';
import { closeConnectDialog, requestConnectionCreate } from '../../actions/connectActions';
import '../../events/connectEvents';
import styles from './ConnectSourceDialog.module.css';

const DialogBody: React.FC = () => {
  const bridge = useMfeBridge();
  const { containerRef, dataTheme } = useHostChrome();
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const ids = { provider: useId(), label: useId(), baseUrl: useId(), token: useId() };
  const attachContainer = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      setContainerEl(node);
    },
    [containerRef]
  );
  const { isLoaded, error: translationsFailed } = useConnectSourceScreenTranslations();
  const t = useConnectSourceText();
  const dispatch = useAppDispatch();

  const draft = useAppSelector((state) => state[CONNECT_SLICE_KEY].draft);
  const submitting = useAppSelector((state) => state[CONNECT_SLICE_KEY].submitting);
  const error = useAppSelector((state) => state[CONNECT_SLICE_KEY].error);

  const tokenError = error?.kind === 'provider' ? error.text : null;
  const { org, loading: orgLoading } = useOrganization();
  const orgId = org?.id ?? null;

  const connectors = apiRegistry.getService(ConnectorsApiService);
  const {
    data: providerData,
    isLoading: providersLoading,
    isError: providersFailed,
  } = useApiQuery(connectors.providers);
  const providers = providerData?.items ?? [];
  const chosen = providers.find((provider) => provider.provider === draft.provider);


  useEffect(() => {
    dispatch(resetForm());
  }, [dispatch]);

  useEffect(() => {
    const subscription = eventBus.on('mfe/connections/created', () => {
      closeConnectDialog(bridge);
    });
    return () => subscription.unsubscribe();
  }, [bridge]);

  /**
   * The skeleton is for the first load and nothing else.
   */
  const everLoaded = useRef(false);
  everLoaded.current ||= isLoaded;
  const showSkeleton = !everLoaded.current && !translationsFailed;

  const blocked = submitting || orgLoading || !orgId || !isDraftUsable(draft);

  const providerPlaceholder = providersLoading
    ? t('loading_providers')
    : t('field_provider_placeholder');

  const onCreate = (): void => {
    if (!orgId) return;
    requestConnectionCreate(orgId, draft);
  };

  return (
    <div ref={attachContainer} className={styles.dialog} data-theme={dataTheme}>
      {showSkeleton ? (
        <Skeleton className={styles.titleSkeleton} />
      ) : (
        <h2 className={styles.title}>{t('title')}</h2>
      )}

      <div className={styles.body}>
        {showSkeleton ? (
          <Skeleton className={styles.bodySkeleton} />
        ) : (
          <>
            <Field>
              <FieldLabel className={styles.fieldLabel} htmlFor={ids.provider}>
                {t('field_provider')}
              </FieldLabel>
              <Select
                value={draft.provider}
                modal={false}
                disabled={providersLoading}
                onValueChange={(next) => dispatch(editDraft({ provider: next ?? '' }))}
              >
                <SelectTrigger id={ids.provider} className={styles.providerTrigger}>
                  <SelectValue placeholder={providerPlaceholder}>
                    {(selected) =>
                      selected ? (chosen?.display_name ?? String(selected)) : providerPlaceholder
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent container={containerEl ?? undefined}>
                  {providers.map((provider) => (
                    <SelectItem key={provider.provider} value={provider.provider}>
                      {provider.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel className={styles.fieldLabel} htmlFor={ids.label}>
                {t('field_label')}
              </FieldLabel>
              <Input
                id={ids.label}
                value={draft.label}
                onChange={(event) => dispatch(editDraft({ label: event.target.value }))}
              />
              <FieldDescription>{t('field_label_hint')}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel className={styles.fieldLabel} htmlFor={ids.baseUrl}>
                {t('field_base_url')}
              </FieldLabel>
              <Input
                id={ids.baseUrl}
                value={draft.baseUrl}
                placeholder={chosen?.default_base_url ?? ''}
                onChange={(event) => dispatch(editDraft({ baseUrl: event.target.value }))}
              />
            </Field>

            <Field data-invalid={Boolean(tokenError)}>
              <FieldLabel className={styles.fieldLabel} htmlFor={ids.token}>
                {chosen?.credential_label || t('field_token')}
              </FieldLabel>
              <Input
                id={ids.token}
                type="password"
                autoComplete="off"
                aria-invalid={Boolean(tokenError) || undefined}
                value={draft.token}
                placeholder={chosen?.credential_hint ?? ''}
                onChange={(event) => dispatch(editDraft({ token: event.target.value }))}
              />
              <FieldError className={styles.fieldError} title={tokenError ?? undefined}>
                {tokenError}
              </FieldError>
            </Field>
          </>
        )}
      </div>

      {(translationsFailed ||
        error?.kind === 'i18n' ||
        providersFailed ||
        (!orgId && !orgLoading)) && (
        <p className={styles.error} role="alert">
          {translationsFailed
            ? 'Could not load this screen.'
            : error?.kind === 'i18n'
              ? t(error.key)
              : providersFailed
                ? t('error_providers')
                : t('error_no_org')}
        </p>
      )}

      <div className={styles.footer}>
        <div className={styles.footerNote} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => closeConnectDialog(bridge)}
          disabled={submitting}
        >
          {t('cancel')}
        </Button>
        <Button size="sm" onClick={onCreate} disabled={blocked}>
          {t('create')}
        </Button>
      </div>
    </div>
  );
};

DialogBody.displayName = 'DialogBody';

export const ConnectSourceDialog: React.FC = () => (
  <OrganizationProvider>
    <DialogBody />
  </OrganizationProvider>
);

ConnectSourceDialog.displayName = 'ConnectSourceDialog';
