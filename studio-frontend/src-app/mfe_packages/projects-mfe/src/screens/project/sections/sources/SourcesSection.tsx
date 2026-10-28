import React from 'react';
import { useEverLoaded, useOrganization, useWorkspace } from '@constructor-studio/mfe-shared';
import { useProjectText, useSourcesSectionTranslations, useSourcesText } from '../../../../i18n';
import { useSyncRefusals } from '../../../../shared/useSyncRefusals';
import { SectionSkeleton } from '../../../../components/SectionStates';
import { PlaceholderSection } from '../PlaceholderSection';
import { SourcesTable } from './SourcesTable';

export const SourcesSection: React.FC<{ projectId: string; projectName: string }> = ({
  projectId,
  projectName,
}) => {
  const { isLoaded, error } = useSourcesSectionTranslations();
  const everLoaded = useEverLoaded(isLoaded);
  const { org, loading: orgLoading } = useOrganization();
  const { workspace, loading: workspaceLoading } = useWorkspace();
  const t = useSourcesText();
  const projectText = useProjectText();
  useSyncRefusals(projectId);

  if ((!everLoaded && !error) || orgLoading) return <SectionSkeleton />;
  if (!org) return <PlaceholderSection title={projectText('section_sources')} note={t('no_org')} />;
  if (workspaceLoading) return <SectionSkeleton />;
  return (
    <SourcesTable
      projectId={projectId}
      projectName={projectName}
      orgId={org.id}
      workspaceId={workspace?.id ?? null}
    />
  );
};

SourcesSection.displayName = 'SourcesSection';
