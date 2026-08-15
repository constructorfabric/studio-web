/**
 * Accounts Domain - API Types
 * Type definitions for accounts service endpoints
 * (users, tenants, authentication, permissions)
 *
 * Application-specific types (copied from CLI template)
 */

import type { Language } from '@gears-frontx/react';

/**
 * User Extra Properties
 * Applications extend this via module augmentation for platform-specific fields
 * @public Reserved for future module augmentation
 */
export interface UserExtra {
  // Applications add their types via module augmentation
  // Empty by default
  [key: string]: unknown;
}

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

/**
 * User entity from API
 */
export interface ApiUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  language: Language;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  extra?: UserExtra;
}

/**
 * User roles
 * @public Reserved for future use
 */
export enum UserRole {
  Admin = 'admin',
  User = 'user',
}

