import '@gears-frontx/react';

export interface DocumentsUploadRequest {
  projectId: string;
  project: string;
  workspaceId: string;
  /** The panel's rows to send, in order. */
  ids: string[];
}

export interface DocumentsUploadFinished {
  projectId: string;
  project: string;
  added: number;
  refused: number;
}

declare module '@gears-frontx/react' {
  interface EventPayloadMap {
    'mfe/projects/documents-upload-requested': DocumentsUploadRequest;
    'mfe/projects/documents-upload-finished': DocumentsUploadFinished;
  }
}
