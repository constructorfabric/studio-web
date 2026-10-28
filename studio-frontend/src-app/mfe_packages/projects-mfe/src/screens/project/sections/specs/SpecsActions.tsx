import React, { useState } from 'react';
import { ListChecks } from 'lucide-react';
import { apiRegistry, useApiQuery, useAppSelector } from '@gears-frontx/react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@gears-frontx/ui-kit';
import { useEverLoaded, useWorkspace } from '@constructor-studio/mfe-shared';
import { SpecQualityApiService } from '../../../../api/SpecQualityApiService';
import { useSpecsSectionTranslations, useSpecsText } from '../../../../i18n';
import { CHECK_CONFIRM_ABOVE, checkTargets } from '../../../../model/specsCheck';
import { SPECS_CHECK_SLICE_KEY, checkRunning } from '../../../../slices/specsCheckSlice';
import { requestSpecsCheck } from '../../../../actions/specsCheckActions';
import { useThemedRoot } from '../../../../shared/useThemedRoot';
import { UploadDocumentsButton } from '../../upload/UploadDocumentsButton';

interface SpecsActionsProps {
  projectId: string;
  projectName: string;
}

export const SpecsActions: React.FC<SpecsActionsProps> = ({ projectId, projectName }) => {
  const { isLoaded } = useSpecsSectionTranslations();
  const everLoaded = useEverLoaded(isLoaded);
  const t = useSpecsText();
  const { workspace } = useWorkspace();
  const selected = useAppSelector((state) => state[SPECS_CHECK_SLICE_KEY].selected);
  const shown = useAppSelector((state) => state[SPECS_CHECK_SLICE_KEY].shown);
  const running = useAppSelector((state) => checkRunning(state[SPECS_CHECK_SLICE_KEY], projectId));
  // While it loads, or when it cannot be read, Check stays enabled: the run says what went wrong.
  const { data: status } = useApiQuery(apiRegistry.getService(SpecQualityApiService).status);
  const [confirming, setConfirming] = useState(false);
  const [container, findThemedRoot] = useThemedRoot();

  const upload = <UploadDocumentsButton projectId={projectId} />;
  if (!everLoaded || shown === null || !workspace) return upload;

  const targets = checkTargets(selected, shown);
  const start = (): void =>
    requestSpecsCheck({ projectId, workspaceId: workspace.id, project: projectName, targets });
  const disabledBy =
    status?.configured === false
      ? 'check_unconfigured'
      : targets.length === 0
        ? 'check_nothing'
        : running
          ? 'check_running'
          : null;

  const label = t.count('check', targets.length);
  const icon = <ListChecks />;

  return (
    <>
      {upload}
      <span ref={findThemedRoot}>
        {disabledBy ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button size="sm" icon={icon} disabled focusableWhenDisabled>
                  {label}
                </Button>
              }
            />
            <TooltipContent container={container ?? undefined}>{t(disabledBy)}</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            size="sm"
            icon={icon}
            onClick={() => (targets.length > CHECK_CONFIRM_ABOVE ? setConfirming(true) : start())}
          >
            {label}
          </Button>
        )}
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent container={container ?? undefined}>
            <AlertDialogHeader>
              <AlertDialogTitle>{t.count('check_confirm_title', targets.length)}</AlertDialogTitle>
              <AlertDialogDescription>{t('check_confirm_note')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('check_cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={start}>{t('check_confirm')}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </span>
    </>
  );
};

SpecsActions.displayName = 'SpecsActions';
