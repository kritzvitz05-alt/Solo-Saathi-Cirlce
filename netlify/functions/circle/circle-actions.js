/**
 * @file netlify/functions/circle/circle-actions.js
 * @description Circle Management and Participant Actions Handler for SoloSaathi Circle.
 *
 * Dispatches and processes circle participant actions:
 * - 'grow': Any member opens 1-20 spots (GROW_MIN_SPOTS to GROW_MAX_SPOTS) and unlocks the circle.
 * - 'lock': Any member locks circle to prevent additional walk-ins.
 * - 'leave': Member departs circle, freeing their slot; auto-elects replacement captain if needed.
 *     Uses a Firestore Transaction for atomic read-modify-write on circle + registration.
 * - 'transferCaptain': Captain transfers role to another roster member (with cancel support).
 * - 'showup': Physical attendee check-in at venue ground. Uses FieldValue.arrayUnion()
 *     for atomic append without full transaction overhead.
 * - 'switchCircle': Moves attendee to another circle using a Firestore Transaction
 *     to atomically modify source circle, target circle, and registration:
 *   - Capped at 3 switches per night (SWITCH_CIRCLE_MAX_PER_NIGHT = 3).
 *   - Locked for first 5 minutes after joining (SWITCH_CIRCLE_LOCK_MINUTES = 5).
 *   - 20-minute cooldown between subsequent switches (SWITCH_CIRCLE_COOLDOWN_MINUTES = 20).
 */

const {
  GROW_MIN_SPOTS,
  GROW_MAX_SPOTS,
  SWITCH_CIRCLE_MAX_PER_NIGHT,
  SWITCH_CIRCLE_LOCK_MINUTES,
  SWITCH_CIRCLE_COOLDOWN_MINUTES,
  SOFT_MAX_GROUP,
} = require('../../shared/constants');
const { successResponse, errorResponse, handleOptions } = require('../../shared/response');
const { checkGenderCap } = require('../../shared/matching');
const db = require('../../shared/db');

/**
 * Netlify Function Handler: Dispatches circle management actions.
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

  const { action, circleId, registrationId } = body;
  if (!action || typeof action !== 'string') {
    return errorResponse("Missing required 'action' parameter.", 400);
  }

  const now = Date.now();

  try {
    // -------------------------------------------------------------------------
    // ACTION: SHOWUP (Venue gate check-in) — Atomic via FieldValue.arrayUnion
    // -------------------------------------------------------------------------
    if (action === 'showup') {
      const { city, venue, gate } = body;
      if (!city || !venue || !registrationId) {
        return errorResponse("Missing required parameters for 'showup': city, venue, registrationId.", 400);
      }

      // Read existing showups to check for duplicates
      const showups = (await db.getShowups(city, venue)) || [];
      const alreadyCheckedIn = showups.some((s) => s.registrationId === registrationId);

      if (alreadyCheckedIn) {
        return successResponse({
          message: 'Attendee already checked in.',
          alreadyCheckedIn: true,
          totalShowups: showups.length,
        });
      }

      const newCheckin = {
        registrationId,
        circleId: circleId || null,
        checkedInAt: now,
        gate: gate || 'Main Gate',
      };

      // Atomic append using FieldValue.arrayUnion — no transaction needed.
      // If two gate scanners fire at the same millisecond, both appends succeed
      // without overwriting each other.
      const showupDocId = db.getDocRef('showups',
        db.getPoolDocId(city, venue, new Date(now + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0])
      );
      // Use the existing _todayIST-based key via saveShowups path
      // but with arrayUnion for atomicity
      const todayIST = new Date(now + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
      const showupRef = db.getDocRef('showups',
        [city, venue, todayIST].map(s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')).join('_')
      );
      await showupRef.set({
        showupsArray: db.FieldValue.arrayUnion(newCheckin),
      }, { merge: true });

      return successResponse({
        message: 'Attendee check-in recorded successfully.',
        checkedInAt: now,
        totalShowups: showups.length + 1,
      });
    }

    // All subsequent actions require circleId and an existing circleState
    if (!circleId) {
      return errorResponse("circleId is required for this action.", 400);
    }

    const circle = await db.getCircleState(circleId);
    if (!circle) {
      return errorResponse(`Circle '${circleId}' not found.`, 404);
    }

    // -------------------------------------------------------------------------
    // ACTION: GROW (Open 1-20 additional spots, unlock circle)
    // -------------------------------------------------------------------------
    if (action === 'grow') {
      const additionalSpots = parseInt(body.spots, 10) || 5;

      if (additionalSpots < GROW_MIN_SPOTS || additionalSpots > GROW_MAX_SPOTS) {
        return errorResponse(
          `Can only grow between ${GROW_MIN_SPOTS} and ${GROW_MAX_SPOTS} spots. Requested: ${additionalSpots}.`,
          400
        );
      }

      circle.maxSpots = (circle.maxSpots || SOFT_MAX_GROUP) + additionalSpots;
      circle.isLocked = false; // Growing unlocks the circle
      circle.status = 'active';
      circle.updatedAt = now;

      await db.saveCircleState(circleId, circle);

      return successResponse({
        message: `Circle unlocked and expanded by ${additionalSpots} spots.`,
        circleId,
        isLocked: false,
        maxSpots: circle.maxSpots,
        currentMembers: circle.totalCount,
      });
    }

    // -------------------------------------------------------------------------
    // ACTION: LOCK (Close circle to new attendees)
    // -------------------------------------------------------------------------
    if (action === 'lock') {
      circle.isLocked = true;
      circle.status = 'locked';
      circle.lockedAt = now;
      circle.updatedAt = now;

      await db.saveCircleState(circleId, circle);

      return successResponse({
        message: 'Circle is now locked to new members.',
        circleId,
        isLocked: true,
      });
    }

    // -------------------------------------------------------------------------
    // ACTION: LEAVE (Member leaves circle) — Transactional
    // -------------------------------------------------------------------------
    if (action === 'leave') {
      if (!registrationId) {
        return errorResponse("registrationId is required to leave a circle.", 400);
      }

      const circleRef = db.getDocRef('circles', circleId);
      const regRef = db.getDocRef('registrations', registrationId);

      const result = await db.runTransaction(async (transaction) => {
        // Read both documents atomically
        const circleSnap = await transaction.get(circleRef);
        const regSnap = await transaction.get(regRef);

        if (!circleSnap.exists) {
          throw new Error(`Circle '${circleId}' not found.`);
        }

        const circleData = circleSnap.data();
        const regData = regSnap.exists ? regSnap.data() : null;

        const memberIndex = circleData.members.findIndex((m) => m.registrationId === registrationId);
        if (memberIndex === -1) {
          throw new Error("Attendee is not currently a member of this circle.");
        }

        const leavingMember = circleData.members[memberIndex];
        circleData.members.splice(memberIndex, 1);
        circleData.totalCount = circleData.members.length;

        if (leavingMember.gender === 'male') circleData.maleCount = Math.max(0, (circleData.maleCount || 1) - 1);
        else if (leavingMember.gender === 'female') circleData.femaleCount = Math.max(0, (circleData.femaleCount || 1) - 1);
        else circleData.otherCount = Math.max(0, (circleData.otherCount || 1) - 1);

        // If the leaving member was the Captain, designate a replacement
        let newCaptainName = null;
        if (circleData.captainId === registrationId) {
          const replacement = circleData.members.find((m) => m.captainOptIn) || circleData.members[0];
          if (replacement) {
            circleData.captainId = replacement.registrationId;
            circleData.captainName = replacement.name;
            replacement.isCaptain = true;
            newCaptainName = replacement.name;
          } else {
            circleData.captainId = null;
            circleData.captainName = null;
          }
        }

        circleData.updatedAt = now;

        // Atomic writes
        transaction.set(circleRef, circleData, { merge: true });

        if (regData) {
          transaction.set(regRef, {
            ...regData,
            circleId: null,
            updatedAt: now,
          }, { merge: true });
        }

        return {
          remainingMembers: circleData.totalCount,
          newCaptain: newCaptainName,
        };
      });

      return successResponse({
        message: 'Left circle successfully.',
        circleId,
        remainingMembers: result.remainingMembers,
        newCaptain: result.newCaptain,
      });
    }

    // -------------------------------------------------------------------------
    // ACTION: TRANSFER CAPTAIN
    // -------------------------------------------------------------------------
    if (action === 'transferCaptain') {
      const { currentCaptainId, newCaptainId, cancelTransfer } = body;

      if (cancelTransfer) {
        circle.pendingCaptainTransfer = null;
        await db.saveCircleState(circleId, circle);
        return successResponse({ message: 'Captain transfer cancelled.', circleId });
      }

      if (circle.captainId && circle.captainId !== currentCaptainId) {
        return errorResponse('Only the current Circle Captain can transfer leadership.', 403);
      }

      const targetMember = circle.members.find((m) => m.registrationId === newCaptainId);
      if (!targetMember) {
        return errorResponse('Target member is not in this circle roster.', 404);
      }

      // Reassign Captain
      for (const m of circle.members) {
        m.isCaptain = m.registrationId === newCaptainId;
      }
      circle.captainId = targetMember.registrationId;
      circle.captainName = targetMember.name;
      circle.updatedAt = now;

      await db.saveCircleState(circleId, circle);

      return successResponse({
        message: `Captaincy successfully transferred to ${targetMember.name}.`,
        circleId,
        newCaptainId: targetMember.registrationId,
        newCaptainName: targetMember.name,
      });
    }

    // -------------------------------------------------------------------------
    // ACTION: SWITCH CIRCLE — Transactional
    // -------------------------------------------------------------------------
    if (action === 'switchCircle') {
      const { targetCircleId } = body;
      if (!registrationId || !targetCircleId) {
        return errorResponse("Missing required parameters: registrationId, targetCircleId.", 400);
      }

      if (circleId === targetCircleId) {
        return errorResponse("Attendee is already in target circle.", 400);
      }

      const sourceCircleRef = db.getDocRef('circles', circleId);
      const targetCircleRef = db.getDocRef('circles', targetCircleId);
      const regRef = db.getDocRef('registrations', registrationId);

      const result = await db.runTransaction(async (transaction) => {
        // Read all three documents atomically
        const sourceSnap = await transaction.get(sourceCircleRef);
        const targetSnap = await transaction.get(targetCircleRef);
        const regSnap = await transaction.get(regRef);

        if (!sourceSnap.exists) {
          throw new Error(`Source circle '${circleId}' not found.`);
        }
        if (!targetSnap.exists) {
          throw new Error(`Target circle '${targetCircleId}' not found.`);
        }

        const sourceCircle = sourceSnap.data();
        const targetCircle = targetSnap.data();
        const reg = regSnap.exists ? regSnap.data() : null;

        // Member check in source circle
        const memberIndex = sourceCircle.members.findIndex((m) => m.registrationId === registrationId);
        if (memberIndex === -1) {
          throw new Error("Attendee is not currently in source circle.");
        }
        const member = sourceCircle.members[memberIndex];

        // Switch limits and cooldowns from registration
        const switchHistory = reg?.switchHistory || [];

        // Rule 1: Max 3 switches per night
        if (switchHistory.length >= SWITCH_CIRCLE_MAX_PER_NIGHT) {
          throw new Error(
            `Maximum of ${SWITCH_CIRCLE_MAX_PER_NIGHT} circle switches reached for tonight.`
          );
        }

        // Rule 2: Lock-in for first 5 minutes after joining
        const joinedAt = member.joinedAt || sourceCircle.createdAt || now;
        const minutesSinceJoin = (now - joinedAt) / 60000;
        if (minutesSinceJoin < SWITCH_CIRCLE_LOCK_MINUTES) {
          const waitMinutes = Math.ceil(SWITCH_CIRCLE_LOCK_MINUTES - minutesSinceJoin);
          throw new Error(
            `New circle members cannot switch for the first ${SWITCH_CIRCLE_LOCK_MINUTES} minutes. Please wait ${waitMinutes} minute(s).`
          );
        }

        // Rule 3: 20-minute cooldown between subsequent switches
        if (switchHistory.length > 0) {
          const lastSwitchAt = switchHistory[switchHistory.length - 1].timestamp;
          const minutesSinceLastSwitch = (now - lastSwitchAt) / 60000;
          if (minutesSinceLastSwitch < SWITCH_CIRCLE_COOLDOWN_MINUTES) {
            const waitMinutes = Math.ceil(SWITCH_CIRCLE_COOLDOWN_MINUTES - minutesSinceLastSwitch);
            throw new Error(
              `Cooldown active. You must wait ${SWITCH_CIRCLE_COOLDOWN_MINUTES} minutes between switches. ${waitMinutes} minute(s) remaining.`
            );
          }
        }

        // Target circle validation
        if (targetCircle.isLocked || targetCircle.status === 'locked' || targetCircle.status === 'closed') {
          throw new Error("Target circle is currently locked to new members.");
        }

        if (targetCircle.totalCount >= (targetCircle.maxSpots || SOFT_MAX_GROUP)) {
          throw new Error("Target circle has reached capacity.");
        }

        // Gender cap evaluation on target circle
        const genderViolated = checkGenderCap(
          { male: targetCircle.maleCount, female: targetCircle.femaleCount },
          member.gender,
          targetCircle.isAllWomen
        );
        if (genderViolated) {
          throw new Error("Target circle has reached the gender balance limit for this group.");
        }

        // Execute transfer: remove from source
        sourceCircle.members.splice(memberIndex, 1);
        sourceCircle.totalCount = sourceCircle.members.length;
        if (member.gender === 'male') sourceCircle.maleCount = Math.max(0, (sourceCircle.maleCount || 1) - 1);
        else if (member.gender === 'female') sourceCircle.femaleCount = Math.max(0, (sourceCircle.femaleCount || 1) - 1);
        else sourceCircle.otherCount = Math.max(0, (sourceCircle.otherCount || 1) - 1);

        if (sourceCircle.captainId === registrationId) {
          const rep = sourceCircle.members.find((m) => m.captainOptIn) || sourceCircle.members[0];
          sourceCircle.captainId = rep ? rep.registrationId : null;
          sourceCircle.captainName = rep ? rep.name : null;
          if (rep) rep.isCaptain = true;
        }
        sourceCircle.updatedAt = now;

        // Add to target
        const transferredMember = {
          ...member,
          isCaptain: false,
          joinedAt: now,
        };
        targetCircle.members.push(transferredMember);
        targetCircle.totalCount = targetCircle.members.length;
        if (member.gender === 'male') targetCircle.maleCount = (targetCircle.maleCount || 0) + 1;
        else if (member.gender === 'female') targetCircle.femaleCount = (targetCircle.femaleCount || 0) + 1;
        else targetCircle.otherCount = (targetCircle.otherCount || 0) + 1;
        targetCircle.updatedAt = now;

        // Update switch history
        switchHistory.push({
          fromCircleId: circleId,
          toCircleId: targetCircleId,
          timestamp: now,
        });

        // Atomic writes — all three documents updated together
        transaction.set(sourceCircleRef, sourceCircle, { merge: true });
        transaction.set(targetCircleRef, targetCircle, { merge: true });

        if (reg) {
          transaction.set(regRef, {
            ...reg,
            circleId: targetCircleId,
            switchHistory,
            updatedAt: now,
          }, { merge: true });
        }

        return {
          switchesRemaining: SWITCH_CIRCLE_MAX_PER_NIGHT - switchHistory.length,
        };
      });

      return successResponse({
        message: `Successfully switched from ${circleId} to ${targetCircleId}.`,
        newCircleId: targetCircleId,
        switchesRemaining: result.switchesRemaining,
      });
    }

    return errorResponse(`Unknown circle action '${action}'.`, 400);
  } catch (error) {
    console.error('[circle-actions fatal error]', error);
    return errorResponse(
      error.message || 'Internal server error during circle action execution.',
      500
    );
  }
};
