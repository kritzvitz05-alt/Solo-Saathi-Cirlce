# SoloSaathi Circle — Database Setup Context Log

> **Branch**: `database-setup`  
> **Date**: 2026-09-17  
> **Status**: ✅ Core database setup complete

---

## What Was Done

### Task 1: Secure Environment Setup

1. Received the Firebase Service Account JSON for project `solosaathi-circle`.
2. Minified the entire JSON into a single-line string using a Node.js script.
3. Created a `.env` file in the project root with the credential stored as:
   ```
   FIREBASE_SERVICE_ACCOUNT='{"type":"service_account","project_id":"solosaathi-circle",...}'
   ```
4. Verified `.gitignore` already contains `.env` — credentials will never be committed.

---

### Task 2: Firebase Admin Initialization

**File**: `netlify/shared/db.js`

- Imported `firebase-admin` v14 using the **modular API**:
  ```js
  const { getApps, initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  ```
- Added singleton initialization with `getApps().length` check to prevent re-initializing during warm serverless starts.
- Exported the `db` (Firestore instance) for use by all other backend functions.
- Added graceful fallback: if `FIREBASE_SERVICE_ACCOUNT` env var is missing, `db` resolves to `null` and a warning is logged.

---

### Task 3: Dependencies

- No `package.json` existed in the project root — created one via `npm init -y`.
- Installed `firebase-admin` (v14.4.0) as a dependency.
- `package-lock.json` generated and committed.

---

### Task 4: Implement All 18 Database Stub Functions

Replaced every `throw new Error("NOT_IMPLEMENTED...")` in `netlify/shared/db.js` with concrete Firestore operations. The implementation follows the architecture defined in `docs/database.md`.

#### Firestore Collections & Function Mapping

| # | Collection | Document ID Strategy | Functions |
|:--|:-----------|:---------------------|:----------|
| A | `registrations` | Registration `id` (e.g., `reg_live_9876543210_1729000000`) | `getRegistration(id)`, `saveRegistration(id, data)`, `getRegistrationsByMobile(whatsapp, date)` |
| B | `pools` | Composite: `{city}_{venue}_{level}_{genderPref}_{eventDate}` | `getPendingPool(...)`, `savePendingPool(...)` |
| C | `groupstate` | Composite: `{city}_{venue}_{level}_{genderPref}_{date}` | `getGroupState(...)`, `saveGroupState(...)` |
| D | `circles` | `circleId` (e.g., `circle_taal_toli_04`) | `getCircleState(circleId)`, `saveCircleState(circleId, state)` |
| E | `showups` | Composite: `{city}_{venue}_{today_IST_date}` | `getShowups(city, venue)`, `saveShowups(city, venue, array)` |
| F | `otp` | WhatsApp number | `getOtpRecord(whatsapp)`, `saveOtpRecord(whatsapp, otpData)` |
| F | `otplimit` | WhatsApp number | `getOtpRateLimit(whatsapp)`, `saveOtpRateLimit(whatsapp, data)` |
| F | `verified` | WhatsApp number | `getVerifiedStatus(whatsapp)`, `saveVerifiedStatus(whatsapp, timestamp)` |
| G | `config` | `venues` (static document) | `getVenues()` |

#### Internal Helper Functions Added

| Helper | Purpose |
|:-------|:--------|
| `_slugify(str)` | Converts multi-word strings to key-safe slugs (e.g., `"United Way Garba Grounds"` → `"united_way_garba_grounds"`) |
| `_compositeKey(...parts)` | Builds Firestore document IDs from partition parameters by slugifying and joining |
| `_todayIST()` | Returns current IST date as `YYYY-MM-DD` string for showup partitioning |

#### Key Implementation Details

- **`saveRegistration`** uses `set()` with `{ merge: true }` for upsert behavior.
- **`getRegistrationsByMobile`** uses a Firestore composite `where()` query (requires a composite index).
- **`getVerifiedStatus`** checks `expiresAt` against `Date.now()` and returns `null` if the 30-minute session has expired, even if the document still exists in Firestore.
- **`saveVerifiedStatus`** auto-computes the expiry window using `OTP_VERIFIED_TTL_MINUTES` (30 min) from `constants.js`.
- **Pools and Showups** store arrays inside a single document field (`poolArray` / `showupsArray`).

---

### Task 5: Documentation

- **`docs/database.md`** — Created the full Firestore architecture document covering:
  - Collection design and document ID strategies
  - Composite key patterns
  - TTL policy recommendations
  - Composite index requirements
  - Concurrency strategy (Firestore Transactions & Batched Writes)
- Updated the Firebase Setup section in `database.md` to reflect the actual implementation (project name, env var name, initialization pattern).

### Task 6: Concurrency Safeguards (Firestore Transactions & Batched Writes)

**Date**: 2026-09-18

The mentor review flagged that the original implementation used sequential `get()` → `set()` calls, which creates race conditions during high-traffic walk-up times (e.g., 100 people paying simultaneously).

#### Changes to `db.js` — New Exports (Additive, No Breaking Changes)

| Export | Purpose |
|:-------|:--------|
| `runTransaction(updateFn)` | Wraps `db.runTransaction()` with auto-retry (up to 5×) |
| `runBatch()` | Returns a `WriteBatch` for atomic multi-document writes |
| `getDocRef(collection, docId)` | Returns a `DocumentReference` for use in transactions/batches |
| `getPoolDocId(...)` | Exposes composite key builder for pool docs |
| `getGroupStateDocId(...)` | Exposes composite key builder for group state docs |
| `FieldValue` | Exported for `arrayUnion()` and other atomic field operations |

#### Changes to `payment-helpers.js` — Transactional Matching

- **Live path**: Wrapped in `db.runTransaction()` — atomically reads `groupstate` + `circles`, evaluates capacity/gender, then writes `circles` + `groupstate` + `registrations` in one commit.
- **Advance path**: Wrapped in `db.runTransaction()` — atomically reads pool, checks idempotency, appends, and writes.

#### Changes to `finalize-bucket.js` — Batched Write

- Replaced 4+ sequential writes with a single `batch.commit()`:
  - `batch.set(circleRef, circleState)` — create circle
  - `batch.set(regRef, { circleId })` × N — update each matched member's registration
  - `batch.set(poolRef, { poolArray: remaining })` — clear matched from pool
  - `batch.set(groupStateRef, updatedState)` — increment counter

#### Changes to `circle-actions.js` — Transactions + ArrayUnion

| Action | Strategy | Documents |
|:-------|:---------|:----------|
| `switchCircle` | `runTransaction` | source circle + target circle + registration (3-doc atomic) |
| `leave` | `runTransaction` | circle + registration (2-doc atomic) |
| `showup` | `FieldValue.arrayUnion()` | showups (lock-free atomic append, no full transaction needed) |
| `grow`, `lock`, `transferCaptain` | Unchanged | Single-actor, single-document operations |

---

### Task 7: Local Development Setup

**Date**: 2026-09-18

- Created `netlify.toml` configuring `[build] functions = "netlify/functions"` and `[dev] port = 8888`.
- Installed `netlify-cli` as a dev dependency.
- Added dummy env vars for `ADMIN_SECRET`, `WHATSAPP_API_KEY`, `RAZORPAY_KEY_*`, etc. to `.env` for local testing.
- Verified local dev server starts at `http://localhost:8888`.

---

## Git History

```
007dca0 feat: setup firebase admin and environment variables
5f46de7 feat: implement firestore database collections and v14 modular API
02bd8e7 docs: add database context file
(pending) feat: add firestore transactions and batched writes for concurrency
```

Branch pushed to `origin/database-setup`.

---

## Verification Results

- ✅ `db.js` loads — all 25 exports present (18 original + 6 new transaction helpers + `FieldValue`)
- ✅ `payment-helpers.js` loads cleanly
- ✅ `finalize-bucket.js` passes syntax check (`node --check`)
- ✅ `circle-actions.js` passes syntax check (`node --check`)
- ✅ Firestore instance initializes when `FIREBASE_SERVICE_ACCOUNT` is provided
- ✅ Graceful `null` fallback when env var is missing
- ✅ Local Netlify dev server starts at `http://localhost:8888`

---

## Remaining Manual Steps (Firebase Console / Deployment)

These cannot be done from code and must be completed before production:

| # | Task | Where | Status |
|:--|:-----|:------|:-------|
| 1 | Create composite index on `registrations` (`whatsapp` Asc + `eventDate` Asc) | Firebase Console → Firestore → Indexes | ⬜ Pending |
| 2 | Configure TTL policy on `otp` collection (field: `expiresAt`) | Firebase Console → Firestore → TTL Policies | ⬜ Pending |
| 3 | Configure TTL policy on `verified` collection (field: `expiresAt`) | Firebase Console → Firestore → TTL Policies | ⬜ Pending |
| 4 | Seed `config/venues` document with venue catalog | Firebase Console → Firestore → Data | ⬜ Pending |
| 5 | Add `FIREBASE_SERVICE_ACCOUNT` to Netlify env vars | Netlify Dashboard → Site → Environment Variables | ⬜ Pending |

---

## Files Modified / Created

| File | Action | Description |
|:-----|:-------|:------------|
| `.env` | Created | Contains minified Firebase Service Account JSON + dummy dev vars |
| `package.json` | Created | Node.js project manifest with `firebase-admin` + `netlify-cli` dependencies |
| `package-lock.json` | Created | Dependency lockfile |
| `netlify.toml` | Created | Netlify configuration for functions directory and local dev port |
| `netlify/shared/db.js` | Modified | 18 Firestore implementations + 6 transaction/batch helpers |
| `netlify/shared/payment-helpers.js` | Modified | Wrapped live + advance matching in Firestore transactions |
| `netlify/functions/circle/finalize-bucket.js` | Modified | Replaced sequential writes with batched write |
| `netlify/functions/circle/circle-actions.js` | Modified | Transactions for switchCircle/leave, arrayUnion for showup |
| `docs/database.md` | Modified | Updated concurrency section with implemented transaction details |

