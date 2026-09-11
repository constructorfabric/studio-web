/**
 * Identity API - Exports
 *
 * The shell's own API layer is identity only. Account-management is reached
 * through `AccountsApiService` from `@constructor-studio/mfe-shared`, the one
 * copy the shell and every MFE share.
 */

export { IdentityApiService, IDENTITY_API_BASE_URL } from './IdentityApiService';
export { type Membership, type MembershipList, PLATFORM_ROOT_TENANT_ID } from './types';
export { identityMockMap } from './mocks';
