/** Sends a person's decision on a repository file's type (#690). */

import {
  apiRegistry,
  eventBus,
  invalidateQueryCacheForApp,
  type AppDispatch,
  type FrontXApp,
} from '@gears-frontx/react';
import { refusalFrom } from '@constructor-studio/mfe-shared';
import { DocumentsApiService } from '../api/DocumentsApiService';
import { decisionSettled, decisionStarted } from '../slices/typeDecisionSlice';
import '../events/specsEvents';

export function initTypeDecisionEffects(dispatch: AppDispatch, app: FrontXApp): void {
  eventBus.on('mfe/projects/type-decision-requested', (request) => {
    const { projectId, workspaceId, bindingId, name, decision } = request;
    const documents = apiRegistry.getService(DocumentsApiService);
    dispatch(decisionStarted(bindingId));
    void documents
      .decideBinding({ workspaceId, bindingId })
      .fetch(decision)
      .then(
        () => {
          // A confirmation changes the Sources section's Specs counts.
          void invalidateQueryCacheForApp(app, documents.specsPerSource({ scope: projectId }));
          eventBus.emit('mfe/projects/specs-changed', { projectId });
        },
        (error: unknown) => {
          eventBus.emit('mfe/projects/type-decision-refused', {
            projectId,
            name,
            refusal: refusalFrom(error, 'type_refused'),
          });
        }
      )
      .finally(() => dispatch(decisionSettled(bindingId)));
  });
}
