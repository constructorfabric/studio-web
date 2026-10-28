import { eventBus } from '@gears-frontx/react';
import type { DocumentsUploadRequest } from '../events/documentUploadEvents';
import '../events/documentUploadEvents';

export function requestDocumentsUpload(request: DocumentsUploadRequest): void {
  eventBus.emit('mfe/projects/documents-upload-requested', request);
}
