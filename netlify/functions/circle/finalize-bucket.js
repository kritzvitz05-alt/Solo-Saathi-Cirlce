/**
 * @file netlify/functions/circle/finalize-bucket.js
 * @description Pending Pool Batch Finalizer for SoloSaathi Circle.
 *
 * Converts a pending registration pool into one or more finalized active Circles:
 * - Admin Protected: Requires valid ADMIN_SECRET in headers or request body.
 * - Enforces business rules:
 *   - Gender balance: GENDER_CAP = 10 per declared gender in mixed circles.
 *   - All-women rules: Soft minimum 4 (ALL_WOMEN_MIN_FLOOR), hard minimum 3 (ALL_WOMEN_ABSOLUTE_MIN).
 *   - Group sizing: SOFT_MAX_GROUP = 24.
 *   - Captain assignment: First attendee opted-in as captain (or first attendee if none opted in).
 * - Updates attendee registration documents with assigned circleId.
 * - Clears finalized members from pending pool and creates Circle records.
 */

const config = require('../../config/env');
const {
  GENDER_CAP,
  ALL_WOMEN_MIN_FLOOR,
  ALL_WOMEN_ABSOLUTE_MIN,
  SOFT_MAX_GROUP,
} = require('../../shared/constants');
const { successResponse, errorResponse, handleOptions } = require('../../shared/response');
const { buildCircleId } = require('../../shared/matching');
const db = require('../../shared/db');

/**
 * Validates admin authentication against ADMIN_SECRET.
 *
 * @param {Object} event - Netlify HTTP event.
 * @param {Object} body - Parsed JSON body.
 * @returns {boolean} True if authenticated.
 */
function checkAdminAuth(event, body) {
  const headerSecret =
    event.headers['x-admin-secret'] ||
    event.headers['X-Admin-Secret'] ||
    (event.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  const bodySecret = body?.adminSecret;
  return (
    (headerSecret && headerSecret === config.ADMIN_SECRET) ||
    (bodySecret && bodySecret === config.ADMIN_SECRET)
  );
}

/**
 * Netlify Function Handler: Batch finalizes pending pool into active circles.
 *
 * @param {Object} event - Netlify HTTP event.
 * @param {Object} context - Netlify execution context.
 * @returns {Promise<Object>} Netlify HTTP response.
 */
exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return handleOptions();
  }

  if (event.httpMethod !== 'POST') {
    return errorResponse('Method Not Allowed. Use POST.', 405);
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (err) {
    return errorResponse('Invalid JSON body in request payload.', 400);
  }

  // 1. Admin authentication check
  if (!checkAdminAuth(event, body)) {
    return errorResponse('Unauthorized: Invalid or missing ADMIN_SECRET.', 401);
  }

  const { city, venue, level, genderPref, eventDate } = body;
  if (!city || !venue || !level || !genderPref || !eventDate) {
    return errorResponse(
      'Missing required partition parameters: city, venue, level, genderPref, eventDate.',
      400
    );
  }

  const now = Date.now();

  try {
    // 2. Fetch current pending pool
    const pool = (await db.getPendingPool(city, venue, level, genderPref, eventDate)) || [];
    if (!Array.isArray(pool) || pool.length === 0) {
      return errorResponse('Pending pool is empty for this partition.', 404);
    }

    const isAllWomen = genderPref === 'allWomen';

    // Check minimum threshold for all-women circles
    if (isAllWomen && pool.length < ALL_WOMEN_ABSOLUTE_MIN) {
      return errorResponse(
        `Insufficient attendees to finalize all-women circle. Current count is ${pool.length}, minimum is ${ALL_WOMEN_ABSOLUTE_MIN}.`,
        422,
        { currentCount: pool.length, minimumRequired: ALL_WOMEN_ABSOLUTE_MIN }
      );
    }

    // 3. Partition members into circle up to SOFT_MAX_GROUP with gender cap
    const selectedMembers = [];
    const remainingPool = [];
    let maleCount = 0;
    let femaleCount = 0;
    let otherCount = 0;

    for (const attendee of pool) {
      if (selectedMembers.length >= SOFT_MAX_GROUP) {
        remainingPool.push(attendee);
        continue;
      }

      if (isAllWomen) {
        selectedMembers.push(attendee);
        femaleCount += 1;
      } else {
        // Mixed circle: check gender cap
        if (attendee.gender === 'male') {
          if (maleCount + 1 <= GENDER_CAP) {
            selectedMembers.push(attendee);
            maleCount += 1;
          } else {
            remainingPool.push(attendee);
          }
        } else if (attendee.gender === 'female') {
          if (femaleCount + 1 <= GENDER_CAP) {
            selectedMembers.push(attendee);
            femaleCount += 1;
          } else {
            remainingPool.push(attendee);
          }
        } else {
          selectedMembers.push(attendee);
          otherCount += 1;
        }
      }
    }

    // 4. Determine Circle Index & Construct Circle ID
    const groupState = (await db.getGroupState(city, venue, level, genderPref, eventDate)) || {};
    const nextIndex = (groupState.lastCircleCounter || 0) + 1;
    const circleId = buildCircleId(level, genderPref, nextIndex);

    // 5. Elect Circle Captain: first with captainOptIn, else first entrant
    let captain = selectedMembers.find((m) => m.captainOptIn);
    if (!captain && selectedMembers.length > 0) {
      captain = selectedMembers[0];
    }

    const circleMembers = selectedMembers.map((m) => ({
      registrationId: m.registrationId,
      name: m.name,
      whatsapp: m.whatsapp,
      gender: m.gender,
      ageBand: m.ageBand,
      skillLevel: m.skillLevel,
      captainOptIn: m.captainOptIn,
      isCaptain: captain ? m.registrationId === captain.registrationId : false,
      joinedAt: now,
    }));

    // 6. Build and persist Circle State
    const circleState = {
      circleId,
      name: circleId.replace('-', ' '),
      skillLevel: level,
      isAllWomen,
      city,
      venue,
      eventDate,
      captainId: captain ? captain.registrationId : null,
      captainName: captain ? captain.name : null,
      meetingPoint: 'Near Main Festival Entrance / Information Desk',
      chatLink: `https://chat.whatsapp.com/adv_${circleId.toLowerCase()}`,
      members: circleMembers,
      maleCount,
      femaleCount,
      otherCount,
      totalCount: circleMembers.length,
      status: 'active',
      isLocked: false,
      createdAt: now,
    };

    // 6. Build and persist all documents atomically via Batched Write
    //    This guarantees no attendee is left in a broken state if the function crashes.
    const batch = db.runBatch();

    // 6a. Create circle document
    const circleRef = db.getDocRef('circles', circleId);
    batch.set(circleRef, circleState, { merge: true });

    // 6b. Update each matched attendee's registration with their circleId
    for (const member of circleMembers) {
      const regRef = db.getDocRef('registrations', member.registrationId);
      batch.set(regRef, { circleId, updatedAt: now }, { merge: true });
    }

    // 6c. Persist remaining pool (remove finalized members)
    const poolDocId = db.getPoolDocId(city, venue, level, genderPref, eventDate);
    const poolRef = db.getDocRef('pools', poolDocId);
    batch.set(poolRef, { poolArray: remainingPool }, { merge: true });

    // 6d. Update group partition state counter
    const groupStateDocId = db.getGroupStateDocId(city, venue, level, genderPref, eventDate);
    const groupStateRef = db.getDocRef('groupstate', groupStateDocId);
    batch.set(groupStateRef, {
      activeCircleId: circleId,
      lastCircleCounter: nextIndex,
      updatedAt: now,
    }, { merge: true });

    // 6e. Commit all writes atomically
    await batch.commit();

    return successResponse({
      circleId,
      name: circleState.name,
      totalMatched: circleMembers.length,
      captain: {
        registrationId: captain?.registrationId,
        name: captain?.name,
      },
      remainingInPool: remainingPool.length,
      isAllWomen,
      allWomenTargetMet: isAllWomen ? circleMembers.length >= ALL_WOMEN_MIN_FLOOR : null,
    });
  } catch (error) {
    console.error('[finalize-bucket fatal error]', error);
    return errorResponse(
      error.message || 'Internal server error during bucket finalization.',
      500
    );
  }
};
