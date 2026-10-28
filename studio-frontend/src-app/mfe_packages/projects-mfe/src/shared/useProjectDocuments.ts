/** Every Studio document a project lists, its own and its workspace's, newest first. */

import { useMemo } from 'react';
import { apiRegistry, useApiQuery, type EndpointDescriptor } from '@gears-frontx/react';
import { DocumentsApiService } from '../api/DocumentsApiService';
import type { DocumentDto } from '../api/documentTypes';

/** The backend's clamp on `limit`. */
const PAGE = 200;

export interface ProjectDocuments {
  documents: DocumentDto[];
  own: DocumentDto[];
  loading: boolean;
  failed: boolean;
}

export function projectDocumentsQuery(
  workspaceId: string,
  projectId: string
): EndpointDescriptor<DocumentDto[]> {
  return {
    key: ['projects-mfe', 'project-documents', workspaceId, projectId],
    fetch: async ({ signal } = {}) => {
      const documents = apiRegistry.getService(DocumentsApiService);
      const all: DocumentDto[] = [];
      for (;;) {
        const page = await documents
          .projectDocuments({ workspaceId, projectId, limit: PAGE, offset: all.length })
          .fetch({ signal, staleTime: 0 });
        all.push(...page.items);
        if (page.items.length === 0 || all.length >= page.total) return all;
      }
    },
  };
}

const UNASKED: EndpointDescriptor<DocumentDto[]> = {
  key: ['projects-mfe', 'unasked', 'project-documents'],
  fetch: () => Promise.resolve([]),
};

export function useProjectDocuments(
  workspaceId: string | null,
  projectId: string
): ProjectDocuments {
  const { data, isLoading, isError } = useApiQuery(
    workspaceId ? projectDocumentsQuery(workspaceId, projectId) : UNASKED
  );
  return useMemo(() => {
    const documents = data ?? [];
    return {
      documents,
      own: documents.filter((document) => !document.inherited),
      loading: isLoading,
      failed: isError,
    };
  }, [data, isLoading, isError]);
}
