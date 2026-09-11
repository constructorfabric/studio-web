import { ProjectSource } from '../../api/types';
import { AccountsApiService } from '@constructor-studio/mfe-shared';
import React, { useEffect } from 'react';
import {
  apiRegistry,
  useApiQuery,
  useAppDispatch,
  useAppSelector,
  useMfeBridge,
} from '@gears-frontx/react';
import { Skeleton } from '@gears-frontx/ui-kit';
import { useOrganization, useWorkspace } from '@constructor-studio/mfe-shared';
import { useProjectScreenTranslations, useProjectText } from '../../i18n';
import { useArtifactCount } from '../../shared/useArtifacts';
import { useArtifactImport } from '../../shared/useArtifactImport';
import { NAV_SLICE_KEY, landOnFirstImport } from '../../slices/navSlice';
import { announceSection } from '../../actions/projectsActions';
import { PlaceholderSection } from './sections/PlaceholderSection';
import { ArtifactsSection } from './sections/ArtifactsSection';
import styles from './ProjectScreen.module.css';

interface ImportWatchProps {
  projectId: string;
  orgId: string;
  workspaceId: string | null;
  artifactCount: number;
  sources: readonly ProjectSource[];
  artifactsRead: boolean;
}
const ImportWatch: React.FC<ImportWatchProps> = ({
  projectId,
  orgId,
  workspaceId,
  artifactCount,
  sources,
  artifactsRead,
}) => {
  const dispatch = useAppDispatch();
  const bridge = useMfeBridge();
  const { isFirstImport, start } = useArtifactImport({
    projectId,
    workspaceId,
    orgId,
    sources,
    artifactCount,
    artifactsRead,
  });

  useEffect(() => {
    if (!isFirstImport) return;
    dispatch(landOnFirstImport());
    announceSection(bridge, 'artifacts');
    start();
  }, [isFirstImport, dispatch, start, bridge]);

  return null;
};

ImportWatch.displayName = 'ImportWatch';

interface ProjectScreenProps {
  projectId: string;
}

export const ProjectScreen: React.FC<ProjectScreenProps> = ({ projectId }) => {
  const { isLoaded, error: translationsFailed } = useProjectScreenTranslations();
  const t = useProjectText();
  const accounts = apiRegistry.getService(AccountsApiService);
  const {
    data: project,
    isLoading,
    isError,
  } = useApiQuery(accounts.getTenant({ tenantId: projectId }));
  const section = useAppSelector((state) => state[NAV_SLICE_KEY].section);

  const { org } = useOrganization();
  const { workspace } = useWorkspace();
  const {
    total: artifactCount,
    sources,
    loading: artifactsLoading,
    failed: artifactsFailed,
  } = useArtifactCount(projectId);
  const artifactsRead = !artifactsLoading && !artifactsFailed;

  const busy = (!isLoaded && !translationsFailed) || isLoading;

  const body = () => {
    if (busy) {
      return (
        <div className={styles.sectionBody}>
          <Skeleton className={styles.blockSkeleton} />
          <Skeleton className={styles.blockSkeleton} />
        </div>
      );
    }
    if (isError || !project) {
      return <PlaceholderSection title={t('error_title')} note={t('error_hint')} />;
    }

    switch (section) {
      case 'artifacts':
        return <ArtifactsSection projectId={projectId} />;
      default:
        return <PlaceholderSection title={t(`section_${section}`)} note={t('no_source_yet')} />;
    }
  };

  return (
    <div className={styles.frame}>
      <div className={styles.content}>
        {org && (
          <ImportWatch
            projectId={projectId}
            orgId={org.id}
            workspaceId={workspace?.id ?? null}
            artifactCount={artifactCount}
            sources={sources}
            artifactsRead={artifactsRead}
          />
        )}
        <header className={styles.header}>
          <h1 className={styles.title}>
            {busy ? <Skeleton className={styles.titleSkeleton} /> : t(`section_${section}`)}
          </h1>
        </header>
        <div className={styles.body} data-section={section}>
          {body()}
        </div>
      </div>
    </div>
  );
};

ProjectScreen.displayName = 'ProjectScreen';
