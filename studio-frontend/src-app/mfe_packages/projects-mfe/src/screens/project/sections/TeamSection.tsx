import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@gears-frontx/ui-kit';
import { UsersProvider, useUsers } from '../../../shared/users';
import styles from '../ProjectScreen.module.css';
import { useProjectText } from '../../../i18n';

/**
 * The project's users, straight from AM: a project is a tenant now, so
 * `/tenants/{projectId}/users` IS its membership — no Resource Group hop, and no
 * pretending the parent tenant's users are the project's.
 */
const TeamList: React.FC = () => {
  const t = useProjectText();
  const users = useUsers();
  const people = users ? [...users.values()] : [];

  return (
    <div className={styles.sectionBody}>
      <Card>
        <CardHeader>
          <CardTitle>{t('section_team')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className={styles.emptyNote}>{t('team_scope_note')}</p>
          {people.length === 0 ? (
            <p className={styles.emptyNote}>{t('team_empty')}</p>
          ) : (
            <ul className={styles.people}>
              {people.map((user) => {
                const name = user.display_name?.trim() || user.username;
                return (
                  <li key={user.id} className={styles.person}>
                    {/* No avatar: the kit's is coming, and this MFE is not the
                        place for a second copy of the hue hash. */}
                    <span className={styles.personName}>{name}</span>
                    {user.email ? <span className={styles.emptyNote}>{user.email}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export const TeamSection: React.FC<{
  /** The project tenant itself: its users ARE the project's members. */
  tenantId: string;
}> = ({ tenantId }) => (
  <UsersProvider tenantId={tenantId}>
    <TeamList />
  </UsersProvider>
);

TeamSection.displayName = 'TeamSection';
