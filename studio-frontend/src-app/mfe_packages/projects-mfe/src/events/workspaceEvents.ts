/** The New workspace form's own events.*/

import '@gears-frontx/react';

declare module '@gears-frontx/react' {
  interface EventPayloadMap {
    'mfe/workspaces/create-requested': { orgId: string; name: string };
    'mfe/workspaces/created': { id: string; name: string; orgId: string };
  }
}
