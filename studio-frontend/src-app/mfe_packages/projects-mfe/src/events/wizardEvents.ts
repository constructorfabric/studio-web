/** The New project wizard's own events. */

import '@gears-frontx/react';
import type { ProjectDraft } from '../model/projectDraft';

export interface ProjectRef {
  id: string;
  name: string;
}

declare module '@gears-frontx/react' {
  interface EventPayloadMap {
    'mfe/projects/create-requested': { workspaceId: string; draft: ProjectDraft };
    'mfe/projects/created': { project: ProjectRef; siblings: ProjectRef[] };
  }
}
