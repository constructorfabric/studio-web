import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRegistry } from '@gears-frontx/react';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@gears-frontx/ui-kit';
import { useWorkspace } from '@constructor-studio/mfe-shared';
import { DocumentsApiService } from '../../../api/DocumentsApiService';
import { orderedStages, projectStatus } from '../../../model/project';
import type { ProjectConfig, TenantDto } from '../../../api/types';
import styles from '../ProjectScreen.module.css';
import { useProjectText } from '../../../i18n';

/**
 * Read-only for now. Renaming is `PATCH /tenants/{id}` (AM exposes `name` and
 * nothing else); mode/stages/status are a `PUT` of the whole project-config
 * metadata object. Both are `useApiMutation` +
 * `queryCache.invalidate(projectConfig)` once the edit UI is designed.
 *
 * TODO: no write path yet; nothing here is editable on purpose.
 */
export const SettingsSection: React.FC<{
  project: TenantDto;
  config: ProjectConfig | null;
}> = ({ project, config }) => {
  const t = useProjectText();
  const { workspace } = useWorkspace();
  const documents = apiRegistry.getService(DocumentsApiService);
  // The catalogue names and orders the stages; the project's own config says
  // which of them it carries. A workspace that is not resolved yet, or a
  // catalogue that failed to load, leaves the keys renderable under their own
  // names rather than blanking the field.
  const catalogueQuery = documents.stages({ workspaceId: workspace?.id ?? '' });
  const { data: catalogue } = useQuery({
    queryKey: catalogueQuery.key,
    queryFn: ({ signal }) => catalogueQuery.fetch({ signal }),
    enabled: Boolean(workspace?.id),
  });
  const stages = orderedStages(config, catalogue?.items ?? []);

  return (
    <div className={styles.sectionBody}>
      <Card>
        <CardHeader>
          <CardTitle>{t('section_settings')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{t('field_name')}</dt>
              <dd className={styles.factValue}>{project.name}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{t('field_status')}</dt>
              <dd className={styles.factValue}>{t(`status_${projectStatus(project, config)}`)}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{t('field_stages')}</dt>
              <dd className={styles.factValue}>
                {stages.length ? (
                  <span className={styles.chips}>
                    {stages.map((stage) => (
                      <Badge key={stage.key} variant="secondary">
                        {stage.label}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  t('none')
                )}
              </dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{t('field_id')}</dt>
              <dd className={styles.factValue}>
                <code className={styles.mono}>{project.id}</code>
              </dd>
            </div>
          </dl>
          <p className={styles.emptyNote}>{t('settings_read_only')}</p>
        </CardContent>
      </Card>
    </div>
  );
};

SettingsSection.displayName = 'SettingsSection';
