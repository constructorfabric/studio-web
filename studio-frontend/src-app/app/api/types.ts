/**
 * Accounts Domain - API Types
 * Type definitions for accounts service endpoints
 */

/**
 * The backend's identity check (GET /cf/account-management/v1/me):
 * whom the presented token authenticates as. Display data (name, email)
 * comes from the token claims, not from this endpoint.
 */
export interface Me {
  subject_id: string;
  subject_type?: string;
  subject_tenant_id?: string;
}
