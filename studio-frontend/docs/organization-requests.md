# Organization requests — how a person without an organization gets one

`studio-organizations` answers one question for a signed-in person with no
organization: what may they do about it? Depending on the installation they
create one at once, ask a platform administrator for one, or wait for an
invitation. Where they ask, the administrator approves the *organization*, not
the person; after that the owner invites people without the administrator.

The decision is ADR-0051
([`docs/adr/0051-an-owner-asks-for-an-organization-and-an-administrator-approves-it.md`](../../docs/adr/0051-an-owner-asks-for-an-organization-and-an-administrator-approves-it.md)),
§5 for what the portal shows; creating one yourself is ADR-0018 §2. This page
is the client half: what to call, and what bites.

- [The service](#the-service)
- [The types](#the-types)
- [Read the setting before offering a control](#read-the-setting-before-offering-a-control)
- [Ask, follow, withdraw](#ask-follow-withdraw)
- [Decide, as a platform administrator](#decide-as-a-platform-administrator)
- [Where it is used](#where-it-is-used)
- [Traps](#traps)

## The service

`OrganizationsApiService` lives in the shell
([`src-app/app/api/OrganizationsApiService.ts`](../src-app/app/api/OrganizationsApiService.ts)),
base URL `/cf/studio-organizations/v1`, with its mocks in
[`mocks.ts`](../src-app/app/api/mocks.ts). Get it from `apiRegistry`, and check
`has` first: a build without the gear must still render.

```tsx
import { apiRegistry } from '@gears-frontx/react';
import { OrganizationsApiService } from '@/app/api';

const organizations = apiRegistry.has(OrganizationsApiService)
  ? apiRegistry.getService(OrganizationsApiService)
  : null;
```

| Member | Route | What it is |
|---|---|---|
| `capabilities` | `GET /capabilities` | the setting (`open` / `request` / `off`) and whether the caller decides requests |
| `create` | `POST /organizations` | create one and own it, where the setting is `open` |
| `requestOrganization` | `POST /organization-requests` | ask for one, where it is `request` |
| `organizationRequests(query)` | `GET /organization-requests?scope=…` | the caller's own (`mine`, newest first) or, for a platform administrator, everybody's (`all`, oldest first) |
| `cancelRequest(id)` | `POST /organization-requests/{id}/cancel` | withdraw one's own pending request |
| `decideRequest(id)` | `POST /organization-requests/{id}/decision` | approve (optionally renamed) or reject (with a reason); platform administrator only |

`cancelRequest` and `decideRequest` are methods returning a mutation, because
the id is in the path: `service.cancelRequest(id).fetch(undefined)`.

## The types

All from `@/app/api`:

```ts
type OrganizationCreation = 'open' | 'request' | 'off';

interface OrganizationCapabilities {
  self_service: boolean;                       // true only for 'open'
  organization_creation?: OrganizationCreation; // absent from a backend older than ADR-0051
  decides_requests?: boolean;                   // the caller is a platform administrator
}

interface OrganizationRequest {
  id: string;                     // also the id the organization gets on approval
  requested_by: string;
  requester_name?: string | null; // filled for the administrator's list
  requester_email?: string | null;
  name: string;                   // what was asked for
  note: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  reason?: string | null;         // a rejection's, written for the requester
  organization_id?: string | null; // set once approved
  created_at_ms: number;
  decided_at_ms?: number | null;
}
```

## Read the setting before offering a control

```tsx
import { creationOf } from '@/app/layout/OrganizationAccessGate';

const capabilities = await organizations?.capabilities.fetch().catch(() => null);
const creation = creationOf(capabilities ?? null); // 'open' | 'request' | 'off'
```

`creationOf` falls back to `self_service` (`true` → `open`, `false` → `off`)
when `organization_creation` is absent, and to `off` when the read failed.

## Ask, follow, withdraw

```tsx
import { apiRegistry } from '@gears-frontx/react';
import { OrganizationsApiService, type OrganizationRequest } from '@/app/api';
import { messageOf } from '@/app/layout/OrganizationAccessGate';

const service = apiRegistry.getService(OrganizationsApiService);

async function ask(name: string, note: string): Promise<OrganizationRequest | string> {
  try {
    return await service.requestOrganization.fetch(
      note.trim() ? { name: name.trim(), note: note.trim() } : { name: name.trim() }
    );
  } catch (failure) {
    return messageOf(failure); // "you already have a request waiting", not "Failed Precondition"
  }
}

async function newestOfMine(): Promise<OrganizationRequest | null> {
  const page = await service
    .organizationRequests({ scope: 'mine', limit: 1 })
    .fetch({ staleTime: 0 });
  return page?.items[0] ?? null;
}

const withdrawn = await service.cancelRequest(requestId).fetch(undefined);
```

When the newest request turns `approved`, the organization exists with the
requester as its owner: emit `app/context/fetch` and let the shell resolve its
context again, as after accepting an invitation.

## Decide, as a platform administrator

```tsx
const pending = await service
  .organizationRequests({ scope: 'all', status: 'pending', offset: 0, limit: 50 })
  .fetch({ staleTime: 0 });

await service.decideRequest(id).fetch({ decision: 'approve', name: 'Corrected name' });
await service.decideRequest(id).fetch({ decision: 'reject', reason: 'Use your company email.' });
```

## Where it is used

- [`OrganizationAccessGate`](../src-app/app/layout/OrganizationAccessGate.tsx):
  the screen a person with no organization sees, in all three modes.
- [`OrganizationRequests`](../src-app/app/layout/OrganizationRequests.tsx):
  the administrator's list, opened from the account menu
  ([`UserMenu`](../src-app/app/layout/UserMenu.tsx)) only when
  `decides_requests` is true. The menu stays in the top bar when the gate is
  shown, so an administrator with no organization reaches it too.
- The desktop's landing page (`theia/studio/src/browser/desktop-landing-widget.tsx`)
  reads the same two routes through its Studio proxy and points to the portal.

## Traps

**Offer the control only after the setting answers.** A create button that
answers 403 in a `request` installation teaches a person the product is broken.
Default to `off` until `capabilities` has answered, and treat a failed read as
`off`.

**`self_service` is not the setting.** It is `true` only for `open`, so a client
reading it alone sees a `request` installation as `off` and hides the form.
Read `organization_creation`; keep `self_service` only as the fallback for an
older backend.

**A failed precondition says nothing in `detail`.** `REQUEST_ALREADY_PENDING`,
`ORGANIZATION_LIMIT_REACHED` and `REQUEST_NOT_PENDING` arrive as `400`
`failed_precondition` whose `detail` is "Operation precondition not met"; the
sentence is in `context.violations[].description` (docs/errors-catalog.md).
`messageOf` reads it; a screen that shows `detail` shows the category.

**`REQUESTS_DISABLED` is a 403 about the installation, not the person.** The
setting changed under the screen; read `capabilities` again rather than
showing a retry.

**A 500 on approve is not a lost decision.** Approval creates the organization
with the request's id and marks the request approved only once the owner's
membership exists. Until then it is still pending, and approving again finishes
the same organization — it can never make a second one. Say so, and keep the
Approve control where it was.

**The mock matches the query string.** `RestMockPlugin` keys on the whole URL,
so `organizationRequests({ scope: 'mine' })` and
`organizationRequests({ scope: 'mine', limit: 1 })` are different keys. The
mock map lists the reads the portal makes; a new query shape needs its own
entry or it goes to the network.

**The person without an organization has no event stream to wait on.** Studio
events are per tenant (studio-events.md), and they have none — so the gate reads
their own pending request again every 30 s, only while it is pending, and stops
when the screen unmounts. Read with `staleTime: 0`, or the cache answers the
poll with the pending request it already had.

**Accepting an invitation does not withdraw a pending request.** The person may
want both (ADR-0051 §5); the request stays until decided or withdrawn.
