// @cpt-dod:cpt-studiofrontend-dod-project-specs-section:p1
import React, { useState } from 'react';
import { useEverLoaded, useWorkspace } from '@constructor-studio/mfe-shared';
import { useSpecsSectionTranslations } from '../../../../i18n';
import { PlaceholderSkeleton } from '../PlaceholderSection';
import { useTypeDecisionRefusals } from './useTypeDecisionRefusals';
import { SpecsTable } from './SpecsTable';

export const SpecsSection: React.FC<{ projectId: string; projectName: string }> = ({
  projectId,
  projectName,
}) => {
  const { isLoaded, error } = useSpecsSectionTranslations();
  useTypeDecisionRefusals(projectId);
  const everLoaded = useEverLoaded(isLoaded);
  const { workspace } = useWorkspace();
  const [attempt, setAttempt] = useState(0);

  // The documents are the workspace's: without one there is nothing to read them by.
  if ((!everLoaded && !error) || !workspace) return <PlaceholderSkeleton />;
  return (
    <SpecsTable
      // The grid keeps `load` in a ref, so another project or workspace needs another grid.
      key={`${projectId}/${workspace.id}/${attempt}`}
      projectId={projectId}
      projectName={projectName}
      workspaceId={workspace.id}
      onRetry={() => setAttempt((count) => count + 1)}
    />
  );
};

SpecsSection.displayName = 'SpecsSection';
