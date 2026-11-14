# Security Specification — The Fire Inventario

## 1. Data Invariants

1. **Workspace Isolation**: Every `stations`, `stationLinks`, `items`, `dailyReports`, `entries`, `invites`, and `teamMembers` document belongs to a single `workspaceId` and `ownerUid`. Users cannot read or write documents from workspaces they do not own or belong to via `authorizedEmails` / `teamMembers`.
2. **Email Verification**: Every authenticated read/write requires `request.auth != null && request.auth.token.email_verified == true`.
3. **No Self-Assigned Roles**: A user cannot create or modify a `teamMembers` document to grant themselves `jefe` or workstation access without either a valid `invites/{inviteId}` document matching their verified email and station OR an active `stationLinks/{accessCode}` document issued by the workspace owner for that specific `stationId`.
4. **Master Gate for Subcollections**: A `dailyReports/{reportId}/entries/{itemId}` document cannot exist or be read/written without an existing (or atomically created via `existsAfter`) parent `dailyReports/{reportId}` document matching `workspaceId` and `station`.
5. **Station Scope Enforcement**: Workstation employees can only create/update `dailyReports` and `entries` for their assigned `stationId`. Only the workspace owner (`ownerUid`) or an active `jefe` can create/edit/delete `stations`, `stationLinks`, `items` catalog, `invites`, `teamMembers`, or reopen a `completed` report.
6. **Temporal Integrity & Immutability**: `createdAt` and `updatedAt` must equal `request.time` on creation; `createdAt`, `workspaceId`, and `ownerUid` are immutable on update, and `updatedAt` must equal `request.time`.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Unverified Email Spoof**: Request with `request.auth.token.email == 'jsjg1023.305@gmail.com'` and `email_verified: false` -> `PERMISSION_DENIED`.
2. **Shadow Field Injection on Item Create**: `items` create payload containing an extra `isVerified: true` ghost key -> `PERMISSION_DENIED`.
3. **Self-Role Escalation**: Non-owner user attempting to write `/teamMembers/{uid}` with `station: 'jefe'` without a matching `/invites/{inviteId}` -> `PERMISSION_DENIED`.
4. **Cross-Station Report Write**: User assigned to `mesera` attempting to create `/dailyReports/restaurante_principal_2026-11-13_asados` -> `PERMISSION_DENIED`.
5. **Orphaned Entry Injection**: Creating `/dailyReports/fake_report/entries/item1` when parent `/dailyReports/fake_report` does not exist -> `PERMISSION_DENIED`.
6. **ID Poisoning (Oversized ID)**: Writing `/items/${'a'.repeat(200)}` or `/items/bad$id!` -> `PERMISSION_DENIED`.
7. **Negative Stock Value Poisoning**: Updating `dailyReports/.../entries/...` with `closing: -5` -> `PERMISSION_DENIED`.
8. **Client Timestamp Forgery**: Creating an item with `createdAt: new Date('2020-01-01')` instead of `serverTimestamp()` -> `PERMISSION_DENIED`.
9. **Terminal State Bypass by Station Staff**: Station employee updating a `dailyReports` document whose existing `status` is `'completed'` -> `PERMISSION_DENIED`.
10. **Catalog & Workstation Mutation by Staff**: Station employee attempting to create/delete `/stations/{stationId}` or modify `minStock` in `/items/{itemId}` -> `PERMISSION_DENIED`.
11. **Unfiltered List Scraping**: External user running `getDocs(collection(db, 'items'))` or `getDocs(collection(db, 'stations'))` without matching `authorizedEmails` or `ownerUid` -> `PERMISSION_DENIED`.
12. **Owner UID Reassignment**: Updating an existing `items`, `stations`, or `workspaces` document to change `ownerUid` to another user's UID -> `PERMISSION_DENIED`.
