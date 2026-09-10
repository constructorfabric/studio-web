/**
 * The public surface of this package. The `host/`, `connector/` and `errors/`
 * split inside is an implementation detail — MFEs import from here.
 */

export { useHostChrome, type HostChrome } from './host/useHostChrome';
export {
  STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT,
  STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION,
  STUDIO_SHARED_PROPERTY_SESSION_PROFILE,
  STUDIO_SHARED_PROPERTY_CONTEXT_WORKSPACE,
} from './host/hostProperties';
export {
  OrganizationProvider,
  useOrganization,
  type OrganizationRef,
  type OrganizationState,
} from './host/organization';
export {
  WorkspaceProvider,
  useWorkspace,
  type WorkspaceRef,
  type WorkspaceState,
} from './host/workspace';

export {
  ConnectorsApiService,
  CONNECTORS_API_BASE_URL,
  REPOSITORY_PAGE_LIMIT,
  connectionsPath,
  connectionTestPath,
  repositoriesPath,
  sendMessagePath,
  targetsPath,
  type ConnectionsParams,
  type ConnectionTestParams,
  type RepositoriesParams,
  type SendMessageParams,
  type TargetsParams,
} from './connector/ConnectorsApiService';
export type {
  ConnectionDto,
  ConnectionListDto,
  ConnectionTestDto,
  CreateConnectionBody,
  NotifyTargetDto,
  NotifyTargetListDto,
  ProviderDto,
  ProviderListDto,
  RemoteRepoDto,
  RemoteRepoListDto,
  SendMessageBody,
  SentMessageDto,
} from './connector/connectorTypes';

export {
  parseProblemDetails,
  refusalFrom,
  refusalText,
  violationOfType,
  type ProblemDetails,
  type Refusal,
  type Violation,
} from './errors/problemDetails';
