# Security Specification — Yemen Commercial Electricity Station Platform

## 1. Multi-Tenant Isolation & Licensing Invariants
1. **Super Admin Authority (`nabilalzuraigy@gmail.com`)**: Only the Super Admin can create, suspend, or revoke commercial station licenses in `/licenses/{licenseCode}` and toggle `/stations/{stationId}.licenseStatus`.
2. **One-Time Activation Code Redemption**: Redeeming a license code executes an atomic `writeBatch` transitioning `/licenses/{code}.status` from `'unused'` to `'active'`, creating `/stations/{stationId}` with `ownerUid == request.auth.uid`, and binding `/userRoles/{uid}` via `getAfter()` verification.
3. **Strict Station Tenant Isolation**: Every `/stations/{stationId}` subcollection (`collectors`, `subscribers`, `readings`, `receipts`) requires `isStationActive(stationId)` and restricts access strictly to that station's `ownerUid`, active `collectors/{uid}`, or Super Admin. Station A cannot read, list, or write Station B's data.
4. **Manager-Controlled Collector Permissions & Activation**: Each collector document stores `active` and a strict `permissions` map (`canRecordReadings`, `canCollectCash`, `canSendInvoices`, `canViewDebts`). Firestore rules block deactivated collectors (`active == false`) and block unpermitted mutations (e.g., creating receipts without `canCollectCash == true`).
5. **Hashed Subscriber Portal Lookup**: `/subscriberPortals/{lookupHash}` forbids `list` queries (`allow list: if false`) so subscribers can only view their own meter bill and proof image using their `meterNumber + phone` SHA-256 hash.
