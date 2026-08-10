const OnboardingEvent = require("../models/OnboardingEvent");
const Employee = require("../models/Employees");
const User = require("../models/Users");

/**
 * Who is acting, for a request that came through anyPayrollAuth.
 *
 * That middleware normalises `req.user._id` to the COMPANY OWNER for every
 * caller and keeps the real person in `employeeId` — so an isAdmin employee
 * sending an offer letter would otherwise be logged as the company owner.
 * Best-effort: a name we cannot resolve is not worth failing a send over.
 */
async function resolveActor(reqUser) {
  try {
    if (!reqUser) return { actor: null, actorName: "" };
    if (reqUser.employeeId) {
      const emp = await Employee.findById(reqUser.employeeId)
        .select("name")
        .lean();
      return { actor: reqUser.employeeId, actorName: emp?.name || "" };
    }
    const user = await User.findById(reqUser._id).select("name email").lean();
    return { actor: null, actorName: user?.name || user?.email || "" };
  } catch (err) {
    console.error("onboarding log actor lookup failed:", err.message);
    return { actor: null, actorName: "" };
  }
}

/**
 * Append one line to a candidate's onboarding log.
 *
 * Deliberately swallows its own errors: this is a record of what happened, and
 * failing to write it must never be the reason an offer letter or a document
 * request fails. Callers therefore never need to await it for correctness —
 * they await only so the row is there by the time they answer the request.
 */
async function recordOnboardingEvent({
  owner,
  employee,
  type,
  status,
  title,
  detail = "",
  recipient = "",
  actor = null,
  actorName = "",
  at,
}) {
  try {
    if (!owner || !employee || !type || !status || !title) return null;
    return await OnboardingEvent.create({
      owner,
      employee,
      type,
      status,
      title,
      detail: detail ? String(detail).slice(0, 2000) : "",
      recipient,
      actor: actor || null,
      actorName: actorName || "",
      at: at || new Date(),
    });
  } catch (err) {
    console.error("onboarding log write failed:", err.message);
    return null;
  }
}

module.exports = { recordOnboardingEvent, resolveActor };
