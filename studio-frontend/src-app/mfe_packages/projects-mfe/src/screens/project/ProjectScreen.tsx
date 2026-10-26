import { AccountsApiService, type ProjectSource } from '@constructor-studio/mfe-shared';
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
import { useSourcesSync } from '../../shared/useSourcesSync';
import { NAV_SLICE_KEY, landOnFirstImport, type ProjectSection } from '../../slices/navSlice';
import { announceSection } from '../../actions/projectsActions';
import { SectionHeader } from '../../components/SectionHeader';
import { PlaceholderSection } from './sections/PlaceholderSection';
import { ArtifactsSection } from './sections/ArtifactsSection';
import { SpecsSection } from './sections/specs/SpecsSection';
import { SourcesSection } from './sections/sources/SourcesSection';
import { SourcesActions } from './sections/sources/SourcesActions';
import { SpecsActions } from './sections/specs/SpecsActions';
import styles from './ProjectScreen.module.css';

/** A section's buttons in the project header, given the open project. */
const SECTION_ACTIONS: Partial<
  Record<ProjectSection, React.FC<{ projectId: string; projectName: string }>>
> = {
  specs: SpecsActions,
  sources: SourcesActions,
};

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
  useSourcesSync({
    projectId,
    workspaceId,
    orgId,
    sources,
    sourcesRead: artifactsRead,
    isFirstImport,
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
  const Actions = SECTION_ACTIONS[section];

  const actions = () => {
    if (busy || !project || !Actions) return null;
    return <Actions projectId={projectId} projectName={project.name} />;
  };

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
      case 'specs':
        return <SpecsSection projectId={projectId} projectName={project.name} />;
      case 'sources':
        return <SourcesSection projectId={projectId} />;
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
        <SectionHeader
          className={styles.header}
          title={t(`section_${section}`)}
          busy={busy}
          actions={actions()}
        />
        <div className={styles.body} data-section={section}>
          {body()}
        </div>
      </div>
    </div>
  );
};

ProjectScreen.displayName = 'ProjectScreen';
