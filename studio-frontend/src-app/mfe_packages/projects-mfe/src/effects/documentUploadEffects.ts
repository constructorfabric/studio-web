import {
  apiRegistry,
  eventBus,
  invalidateQueryCacheForApp,
  type AppDispatch,
  type FrontXApp,
  type RootState,
} from '@gears-frontx/react';
import { parseProblemDetails } from '@constructor-studio/mfe-shared';
import { DocumentsApiService } from '../api/DocumentsApiService';
import { isFileProblem, nameProblem, type UploadEntry } from '../model/documentUpload';
import { projectDocumentsQuery } from '../shared/useProjectDocuments';
import {
  DOCUMENT_UPLOAD_SLICE_KEY,
  uploadAdded,
  uploadAdding,
  uploadRefused,
} from '../slices/documentUploadSlice';
import type { DocumentsUploadRequest } from '../events/documentUploadEvents';
import '../events/documentUploadEvents';
import '../events/specsEvents';

type Sendable = UploadEntry & { typeKey: string; content: string };

function sendable(entry: UploadEntry | undefined): entry is Sendable {
  return (
    entry !== undefined &&
    (entry.status === 'ready' || (entry.status === 'error' && !isFileProblem(entry.problem))) &&
    entry.typeKey !== null &&
    entry.content !== null
  );
}

export function initDocumentUploadEffects(dispatch: AppDispatch, app: FrontXApp): void {
  let queue = Promise.resolve();
  const send = async (
    { projectId, workspaceId }: DocumentsUploadRequest,
    batch: readonly UploadEntry[],
    rows: readonly Sendable[]
  ): Promise<number> => {
    let titles: string[];
    try {
      const listed = await projectDocumentsQuery(workspaceId, projectId).fetch();
      titles = listed.map((document) => document.title);
    } catch (error) {
      console.warn('[upload] could not read the project documents:', error);
      for (const row of rows) dispatch(uploadRefused({ id: row.id, problem: 'refused' }));
      return 0;
    }

    const documents = apiRegistry.getService(DocumentsApiService);
    // A POST with no answer may still have created its document.
    let sent = 0;
    let added = 0;
    // A name taken here may be one the panel's list, which checks names as typed, has not seen.
    let behind = false;
    for (const row of rows) {
      const problem = nameProblem(row, batch, titles);
      if (problem) {
        behind ||= problem === 'taken';
        dispatch(uploadRefused({ id: row.id, problem }));
        continue;
      }
      sent += 1;
      try {
        const created = await documents
          .createDocument({ workspaceId, projectId })
          .fetch({ type_key: row.typeKey, title: row.title.trim(), content: row.content });
        titles.push(created.title);
        added += 1;
        dispatch(uploadAdded({ id: row.id, documentId: created.id }));
      } catch (error) {
        // The server's words only: a client error ("Network Error") gets the translated fallback.
        const { detail, message } = parseProblemDetails(error);
        dispatch(uploadRefused({ id: row.id, problem: 'refused', message: detail ?? message }));
      }
    }

    if (sent === 0 && !behind) return added;
    if (sent > 0) eventBus.emit('mfe/projects/specs-changed', { projectId });
    void invalidateQueryCacheForApp(app, projectDocumentsQuery(workspaceId, projectId)).catch(
      (error: unknown) => {
        console.warn('[upload] the documents list not invalidated', error);
      }
    );
    return added;
  };

  eventBus.on('mfe/projects/documents-upload-requested', (request) => {
    const batch = (app.store.getState() as RootState)[DOCUMENT_UPLOAD_SLICE_KEY].entries;
    const rows = request.ids
      .map((id) => batch.find((entry) => entry.id === id))
      .filter(sendable);
    if (rows.length === 0) return;
    dispatch(uploadAdding(rows.map((row) => row.id)));
    queue = queue
      .then(async () => {
        const added = await send(request, batch, rows);
        eventBus.emit('mfe/projects/documents-upload-finished', {
          projectId: request.projectId,
          project: request.project,
          added,
          refused: rows.length - added,
        });
      })
      .catch((error: unknown) => console.error('[upload] the upload broke off:', error));
  });
}
