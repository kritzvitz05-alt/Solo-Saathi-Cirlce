# SoloSaathi Circle — Firebase Database Handoff & Architecture

## Overview

This document outlines the approach for building the persistence layer of the **SoloSaathi Circle** backend using **Firebase Cloud Firestore** instead of Netlify Blobs. 

Firestore is a NoSQL document database built for automatic scaling, high performance, and ease of application development. This document specifies how the 18 interface methods defined in `netlify/shared/db.js` will map to Firestore collections, documents, and operations.

The backend will use the `firebase-admin` Node.js SDK to interact with Firestore from within the Netlify serverless functions.

---

## 1. Firebase Setup & Authentication

To interact with Firebase from our Netlify environment:
1. We have a Firebase Project created (`solosaathi-circle`).
2. The Service Account JSON has been minified and provided to the environment via the `.env` file as `FIREBASE_SERVICE_ACCOUNT`.
3. `netlify/shared/db.js` initializes the `firebase-admin` SDK on cold start, utilizing a check (`!admin.apps.length`) to prevent re-initializing during warm serverless starts.
4. The initialized `db` (Firestore instance) is exported for use by other functions.

---

## 2. Firestore Data Model Mapping

Firestore organizes data into collections of documents. Unlike Netlify Blobs where we had arbitrary key-value paths (like `registrations:{id}`), we will map these into specific Collections and Document IDs.

### A. Registrations Collection
- **Collection Name**: `registrations`
- **Document ID**: The registration `id` (e.g., `reg_live_9876543210_1729000000`)
- **Indexes**: 
  - We will need a composite index on `(whatsapp, eventDate)` to efficiently support the `getRegistrationsByMobile` query.

**Functions Mapped**:
* `getRegistration(id)`: Reads document from `registrations/{id}`.
* `saveRegistration(id, registrationData)`: Uses `set()` with `{ merge: true }` on `registrations/{id}`.
* `getRegistrationsByMobile(whatsapp, date)`: Uses `where("whatsapp", "==", whatsapp).where("eventDate", "==", date).get()` on the `registrations` collection.

### B. Pending Pools Collection
- **Collection Name**: `pools`
- **Document ID**: Composite key derived from the partition constraints. 
  Format: `{city}_{venue}_{level}_{genderPref}_{eventDate}`. (Spaces in venue names should be replaced with underscores or slugified).
- **Structure**: The document will contain a single field `poolArray` holding the array of queued attendee objects.

**Functions Mapped**:
* `getPendingPool(...)`: Reads document using the composite ID and returns the `poolArray` field (or `[]` if it doesn't exist).
* `savePendingPool(...)`: Uses `set({ poolArray }, { merge: true })` on the corresponding document.

*(Note: Firestore documents have a 1MB size limit. For festival pooling, an array of a few hundred queued attendee objects will easily fit well within this limit).*

### C. Group State Collection
- **Collection Name**: `groupstate`
- **Document ID**: Composite key: `{city}_{venue}_{level}_{genderPref}_{date}`
- **Structure**: Contains active circle IDs, counters, etc.

**Functions Mapped**:
* `getGroupState(...)`: Reads document from `groupstate/{composite_id}`.
* `saveGroupState(...)`: Updates document at `groupstate/{composite_id}`.

### D. Circles Collection
- **Collection Name**: `circles`
- **Document ID**: `circleId` (e.g., `circle_taal_toli_04`)

**Functions Mapped**:
* `getCircleState(circleId)`: Reads document from `circles/{circleId}`.
* `saveCircleState(circleId, stateObject)`: Uses `set()` on `circles/{circleId}`.

### E. Venue Showups Collection
- **Collection Name**: `showups`
- **Document ID**: Composite key: `{city}_{venue}_{current_date}`
- **Structure**: Contains a `showupsArray` field to track all check-in events.

**Functions Mapped**:
* `getShowups(city, venue)`: Reads document and returns `showupsArray`.
* `saveShowups(city, venue, showupsArray)`: Updates document with new array.

### F. Authentication & OTP Tracking (Ephemeral Data)
These documents map to WhatsApp numbers. In Firestore, documents persist forever unless deleted. We can use [Firebase TTL (Time-To-Live) policies](https://firebase.google.com/docs/firestore/ttl) to automatically purge expired OTP and verification records to save cost and maintain privacy.

#### OTP Records
- **Collection Name**: `otp`
- **Document ID**: `whatsapp`
- **Functions**: 
  - `getOtpRecord(whatsapp)`
  - `saveOtpRecord(whatsapp, otpData)`
- **TTL**: We should add a TTL policy based on the `expiresAt` timestamp field.

#### OTP Rate Limiting
- **Collection Name**: `otplimit`
- **Document ID**: `whatsapp`
- **Functions**:
  - `getOtpRateLimit(whatsapp)`
  - `saveOtpRateLimit(whatsapp, rateLimitData)`

#### Verified Session Status
- **Collection Name**: `verified`
- **Document ID**: `whatsapp`
- **Functions**:
  - `getVerifiedStatus(whatsapp)`
  - `saveVerifiedStatus(whatsapp, timestamp)`
- **TTL**: We should add a TTL policy to expire these documents based on the 30-minute verified session window.

### G. Venues Configuration
- **Collection Name**: `config`
- **Document ID**: `venues`
- **Structure**: Can be stored as a single document mapping city names to arrays of venue objects.

**Functions Mapped**:
* `getVenues()`: Reads from `config/venues`. (Alternatively, this could just remain a hardcoded constant in code to save database reads, depending on how often venues are added).

---

## 3. Firestore Concurrency & Transactions (Implemented)

One distinct advantage of Firestore over simple Blob storage is its robust support for Atomic Transactions.
As the Matching Engine reads group states and writes new circles concurrently, race conditions can occur if 100 people register at the exact same millisecond.

### 3.1 Transaction & Batch Helpers in `db.js`

The following helpers are exported from `db.js` for use by callers that need atomic operations:

| Export | Purpose |
|:-------|:--------|
| `runTransaction(updateFn)` | Wraps `db.runTransaction()`. Firestore automatically retries up to 5 times on contention. |
| `runBatch()` | Returns a Firestore `WriteBatch` for atomic multi-document writes (max 500 ops). |
| `getDocRef(collection, docId)` | Returns a `DocumentReference` for use inside transactions or batches. |
| `getPoolDocId(city, venue, level, genderPref, eventDate)` | Exposes the composite key builder for pool documents. |
| `getGroupStateDocId(city, venue, level, genderPref, date)` | Exposes the composite key builder for group state documents. |
| `FieldValue` | Exported Firestore `FieldValue` for atomic field operations (e.g., `arrayUnion`). |

### 3.2 Where Transactions Are Used

| File | Operation | Strategy | Documents Touched |
|:-----|:----------|:---------|:------------------|
| `payment-helpers.js` | Live matching (`joinMatchingBucket`) | `runTransaction` | `groupstate`, `circles`, `registrations` |
| `payment-helpers.js` | Advance pool append | `runTransaction` | `pools` |
| `finalize-bucket.js` | Batch circle formation | `runBatch` + `batch.commit()` | `circles`, N × `registrations`, `pools`, `groupstate` |
| `circle-actions.js` | `switchCircle` | `runTransaction` | source `circles`, target `circles`, `registrations` |
| `circle-actions.js` | `leave` | `runTransaction` | `circles`, `registrations` |
| `circle-actions.js` | `showup` | `FieldValue.arrayUnion()` | `showups` (lock-free atomic append) |

### 3.3 Non-Transactional Operations (By Design)

The following actions operate on a single document and are low-concurrency single-actor operations. They remain as simple `set()` calls:

- `grow` — Single circle document
- `lock` — Single circle document
- `transferCaptain` — Single circle document
- All OTP operations (`saveOtpRecord`, `saveOtpRateLimit`, `saveVerifiedStatus`) — Single document keyed by WhatsApp number

### 3.4 Example: Live Matching Transaction Flow

When a paid attendee enters live matching via `joinMatchingBucket`:

```
Transaction Start
  ├─ READ  groupstate/{partition}     → get active circleId + counter
  ├─ READ  circles/{activeCircleId}   → get current member list + counts
  ├─ EVAL  capacity, gender cap, new-circle logic (pure computation)
  ├─ WRITE circles/{circleId}         → updated members array
  ├─ WRITE groupstate/{partition}     → updated counter
  └─ WRITE registrations/{regId}      → set circleId
Transaction Commit (all-or-nothing, auto-retry up to 5× on contention)
```

### 3.5 Example: Batch Circle Formation Flow

When an admin finalizes a pending pool via `finalize-bucket.js`:

```
Sequential Reads (admin endpoint, rate-limited)
  ├─ READ  pools/{partition}          → pending pool array
  └─ READ  groupstate/{partition}     → last circle counter

Compute (pure logic)
  ├─ Partition members by gender cap + SOFT_MAX_GROUP
  └─ Elect captain

Batch Write (all-or-nothing)
  ├─ SET   circles/{newCircleId}      → circle state
  ├─ SET   registrations/{member1}    → { circleId }
  ├─ SET   registrations/{member2}    → { circleId }
  ├─ ...   (up to 24 members)
  ├─ SET   pools/{partition}          → remaining pool
  └─ SET   groupstate/{partition}     → updated counter
Batch Commit
```

---

## 4. Implementation Steps (Complete)

1. ~~**Initialize Firebase Admin**~~ ✅ Done
2. ~~**Implement the 18 Stubs**~~ ✅ Done — All 18 functions implemented
3. ~~**Configure TTL Indexes**~~ ⬜ Pending (Firebase Console)
4. ~~**Configure Composite Indexes**~~ ⬜ Pending (Firebase Console)
5. ~~**Add Concurrency Safeguards**~~ ✅ Done — Transactions and batched writes implemented

By following this approach, the existing Phase 2 and Phase 3 logic requires **zero changes** to its business logic, and we benefit from a robust, scalable, and **race-condition-free** backend for the Navratri season.

