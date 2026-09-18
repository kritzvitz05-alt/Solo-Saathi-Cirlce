/**
 * @file netlify/shared/payment-helpers.js
 * @description Shared Payment & Matching Helpers for SoloSaathi Circle Phase 3.
 *
 * Implements:
 * - `joinMatchingBucket`: Decoupled matching engine entry point called only AFTER payment
 *   confirmation (used by both verify-payment.js and webhook.js). Idempotent to prevent
 *   duplicate circle allocations or pool duplicates on webhook retries or concurrent calls.
 *
 *   CONCURRENCY: Both live and advance paths use Firestore Transactions
 *   (`db.runTransaction`) to guarantee atomic read-modify-write cycles. Firestore
 *   automatically retries up to 5 times on contention.
 *
 * - `maskSecret`: Security utility masking all but the last 4 characters of sensitive keys
 *   in debug and failure logs.
 */

const {
  buildCircleId,
  shouldStartNewBucket,
  checkGenderCap,
} = require('./matching');
const db = require('./db');

/**
 * Masks a sensitive credential string for safe logging.
 * Retains only the last 4 characters, masking all preceding characters with '*'.
 *
 * @param {string} secret - The secret string to mask.
 * @returns {string} Masked string (e.g., '****************4a2f').
 */
function maskSecret(secret) {
  if (!secret || typeof secret !== 'string') return '[UNSET]';
  if (secret.length <= 4) return '****';
  return '*'.repeat(secret.length - 4) + secret.slice(-4);
}

/**
 * Places a paid attendee into their corresponding matching bucket (Live Circle or Advance Pool).
 * This function is strictly idempotent:
 * - For Live registrations: checks if a circleId is already assigned; if so, returns existing state.
 * - For Advance registrations: checks if the registration ID already exists in the pending pool;
 *   if so, returns existing pool state without creating duplicates.
 *
 * CONCURRENCY: Uses Firestore Transactions for atomic read-modify-write to prevent
 * race conditions during high-traffic walk-up times.
 *
 * @param {Object} registration - Confirmed registration document from Firestore.
 * @returns {Promise<Object>} Assignment result payload containing matching metadata.
 */
async function joinMatchingBucket(registration) {
  if (!registration || typeof registration !== 'object') {
    throw new Error('[joinMatchingBucket] Invalid registration payload provided.');
  }

  const now = Date.now();
  const registrationType = registration.registrationType || 'live';
  const genderPref = registration.allWomenToggle ? 'allWomen' : 'mixed';
  const level = registration.skillLevel || 'beginner';
  const eventDate = registration.eventDate;
  const city = registration.city;
  const venue = registration.venue;

  // -------------------------------------------------------------------------
  // 1. LIVE REGISTRATION MATCHING (Transactional)
  // -------------------------------------------------------------------------
  if (registrationType === 'live') {
    // Idempotency: If circle is already assigned, fetch and return current state
    if (registration.circleId) {
      const existingCircle = await db.getCircleState(registration.circleId);
      if (existingCircle) {
        return {
          success: true,
          type: 'live',
          circleId: registration.circleId,
          circle: {
            id: existingCircle.circleId,
            name: existingCircle.name,
            meetingPoint: existingCircle.meetingPoint,
            chatLink: existingCircle.chatLink,
            isCaptain: existingCircle.captainId === registration.id,
            totalMembers: existingCircle.totalCount,
          },
          alreadyJoined: true,
        };
      }
    }

    // Build document references for the transaction
    const groupStateDocId = db.getGroupStateDocId(city, venue, level, genderPref, eventDate);
    const groupStateRef = db.getDocRef('groupstate', groupStateDocId);
    const registrationRef = db.getDocRef('registrations', registration.id);

    // Run the entire read-evaluate-write matching cycle inside a transaction
    const result = await db.runTransaction(async (transaction) => {
      // 1a. Read group state atomically
      const groupStateSnap = await transaction.get(groupStateRef);
      const groupState = groupStateSnap.exists ? groupStateSnap.data() : {};

      let activeCircleId = groupState.activeCircleId || null;
      let circleCounter = groupState.lastCircleCounter || 0;
      let circleState = null;

      // 1b. Read active circle state atomically (if one exists)
      if (activeCircleId) {
        const circleRef = db.getDocRef('circles', activeCircleId);
        const circleSnap = await transaction.get(circleRef);
        circleState = circleSnap.exists ? circleSnap.data() : null;
      }

      // 1c. Determine if we need a new circle (pure computation, no DB calls)
      let needNewCircle = false;
      if (!circleState || circleState.status === 'locked' || circleState.status === 'closed') {
        needNewCircle = true;
      } else {
        if (shouldStartNewBucket(circleState)) {
          needNewCircle = true;
        }
        const genderViolated = checkGenderCap(
          { male: circleState.maleCount, female: circleState.femaleCount },
          registration.gender,
          registration.allWomenToggle
        );
        if (genderViolated) {
          needNewCircle = true;
        }
      }

      if (needNewCircle) {
        circleCounter += 1;
        activeCircleId = buildCircleId(level, genderPref, circleCounter);
        circleState = {
          circleId: activeCircleId,
          name: `${activeCircleId.replace('-', ' ')}`,
          skillLevel: level,
          isAllWomen: Boolean(registration.allWomenToggle),
          city,
          venue,
          eventDate,
          captainId: null,
          captainName: null,
          meetingPoint: 'Near Main Festival Entrance / Information Desk',
          chatLink: `https://chat.whatsapp.com/demo_${activeCircleId.toLowerCase()}`,
          members: [],
          maleCount: 0,
          femaleCount: 0,
          otherCount: 0,
          totalCount: 0,
          status: 'active',
          isLocked: false,
          createdAt: now,
        };
      }

      // 1d. Captain assignment
      let isCaptain = false;
      if (registration.captainOptIn && !circleState.captainId) {
        isCaptain = true;
        circleState.captainId = registration.id;
        circleState.captainName = registration.name;
      }

      // 1e. Add attendee to circle member roster
      const newMember = {
        registrationId: registration.id,
        name: registration.name,
        gender: registration.gender,
        ageBand: registration.ageBand,
        skillLevel: registration.skillLevel,
        captainOptIn: Boolean(registration.captainOptIn),
        isCaptain,
        joinedAt: now,
      };

      circleState.members.push(newMember);
      circleState.totalCount = circleState.members.length;
      if (registration.gender === 'male') {
        circleState.maleCount = (circleState.maleCount || 0) + 1;
      } else if (registration.gender === 'female') {
        circleState.femaleCount = (circleState.femaleCount || 0) + 1;
      } else {
        circleState.otherCount = (circleState.otherCount || 0) + 1;
      }

      // Fallback captain assignment
      if (!circleState.captainId && circleState.members.length > 0) {
        circleState.captainId = circleState.members[0].registrationId;
        circleState.captainName = circleState.members[0].name;
        circleState.members[0].isCaptain = true;
        if (circleState.members[0].registrationId === registration.id) {
          isCaptain = true;
        }
      }

      // 1f. Atomic writes — all succeed or none do
      const circleRef = db.getDocRef('circles', activeCircleId);
      transaction.set(circleRef, circleState, { merge: true });

      transaction.set(groupStateRef, {
        activeCircleId,
        lastCircleCounter: circleCounter,
        updatedAt: now,
      }, { merge: true });

      const updatedRegistration = { ...registration, circleId: activeCircleId };
      transaction.set(registrationRef, updatedRegistration, { merge: true });

      return {
        success: true,
        type: 'live',
        circleId: activeCircleId,
        circle: {
          id: activeCircleId,
          name: circleState.name,
          meetingPoint: circleState.meetingPoint,
          chatLink: circleState.chatLink,
          isCaptain,
          totalMembers: circleState.totalCount,
        },
        alreadyJoined: false,
      };
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // 2. ADVANCE REGISTRATION MATCHING (Transactional Pool Queue)
  // -------------------------------------------------------------------------
  if (registrationType === 'advance') {
    const poolDocId = db.getPoolDocId(city, venue, level, genderPref, eventDate);
    const poolRef = db.getDocRef('pools', poolDocId);

    const result = await db.runTransaction(async (transaction) => {
      // 2a. Read pool atomically
      const poolSnap = await transaction.get(poolRef);
      const currentPool = poolSnap.exists ? (poolSnap.data().poolArray || []) : [];

      // 2b. Idempotency: check if attendee is already in the pool
      const alreadyInPool = currentPool.some(
        (item) => item.registrationId === registration.id
      );

      if (alreadyInPool) {
        return {
          success: true,
          type: 'advance',
          eventDate,
          poolSize: currentPool.length,
          alreadyJoined: true,
        };
      }

      // 2c. Append new pool item
      const poolItem = {
        registrationId: registration.id,
        name: registration.name,
        whatsapp: registration.whatsapp,
        gender: registration.gender,
        ageBand: registration.ageBand,
        skillLevel: registration.skillLevel,
        allWomenToggle: Boolean(registration.allWomenToggle),
        captainOptIn: Boolean(registration.captainOptIn),
        joinedPoolAt: now,
      };

      currentPool.push(poolItem);

      // 2d. Atomic write
      transaction.set(poolRef, { poolArray: currentPool }, { merge: true });

      return {
        success: true,
        type: 'advance',
        eventDate,
        poolSize: currentPool.length,
        alreadyJoined: false,
      };
    });

    return result;
  }

  throw new Error(`[joinMatchingBucket] Unknown registrationType: '${registrationType}'`);
}

module.exports = {
  maskSecret,
  joinMatchingBucket,
};
