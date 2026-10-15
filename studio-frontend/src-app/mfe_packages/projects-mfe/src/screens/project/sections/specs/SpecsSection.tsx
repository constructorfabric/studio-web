// @cpt-dod:cpt-studiofrontend-dod-project-specs-section:p1
import React from 'react';
import { useEverLoaded } from '@constructor-studio/mfe-shared';
import { useProjectText, useSpecsSectionTranslations, useSpecsText } from '../../../../i18n';
import { PlaceholderSection, PlaceholderSkeleton } from '../PlaceholderSection';
import { useTypeDecisionRefusals } from './useTypeDecisionRefusals';

export const SpecsSection: React.FC<{ projectId: string }> = ({ projectId }) => {
  const { isLoaded, error } = useSpecsSectionTranslations();
  useTypeDecisionRefusals(projectId);
  const everLoaded = useEverLoaded(isLoaded);
  const t = useSpecsText();
  const projectText = useProjectText();

  if (!everLoaded && !error) return <PlaceholderSkeleton />;
  return <PlaceholderSection title={projectText('section_specs')} note={t('placeholder')} />;
};

SpecsSection.displayName = 'SpecsSection';
