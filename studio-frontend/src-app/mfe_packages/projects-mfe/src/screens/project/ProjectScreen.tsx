import React from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';
import { apiRegistry, useApiQuery, useAppSelector } from '@gears-frontx/react';
import { Button, Skeleton } from '@gears-frontx/ui-kit';
import { useProjectScreenTranslations, useProjectText } from '../../i18n';
import { AccountsApiService } from '../../api/AccountsApiService';
import { useProjectConfig } from '../../shared/useProjectConfig';
import { requestCloseProject } from '../../actions/projectsActions';
import { NAV_SLICE_KEY } from '../../slices/navSlice';
import { TeamSection } from './sections/TeamSection';
import { SettingsSection } from './sections/SettingsSection';
import { PlaceholderSection } from './sections/PlaceholderSection';
import styles from './ProjectScreen.module.css';

interface ProjectScreenProps {
  bridge: ChildMfeBridge;
  projectId: string;
}

export const ProjectScreen: React.FC<ProjectScreenProps> = ({ bridge, projectId }) => {
  const { isLoaded, error: translationsFailed } = useProjectScreenTranslations();
  const t = useProjectText();
  const accounts = apiRegistry.getService(AccountsApiService);

  const { data: project, isLoading, isError } = useApiQuery(
    accounts.tenant({ tenantId: projectId })
  );
  const { config } = useProjectConfig(projectId);
  const section = useAppSelector((state) => state[NAV_SLICE_KEY].section);

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
      case 'team':
        return <TeamSection tenantId={project.id} />;
      case 'settings':
        return <SettingsSection project={project} config={config} />;
      default:
        return <PlaceholderSection title={t(`section_${section}`)} note={t('no_source_yet')} />;
    }
  };

  return (
    <div className={styles.frame}>
      {/* The rail's slot: a kit component takes it, and it drives `section`
          through `requestSection`. Until then only `overview` is reachable. */}
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.headerMain}>
            <Button variant="ghost" size="sm" onClick={() => requestCloseProject(bridge)}>
              {t('back_to_projects')}
            </Button>
            <h1 className={styles.title}>
              {busy ? <Skeleton className={styles.titleSkeleton} /> : t(`section_${section}`)}
            </h1>
          </div>
        </header>
        {body()}
      </div>
    </div>
  );
};

ProjectScreen.displayName = 'ProjectScreen';
