// System announcements: the app writing to your mailbox.
//
// Every Request Center event — a request going up for approval, and every
// approval or rejection coming back — is mirrored into the email system as an
// AssignmentMessage flagged `isSystemAnnouncement`. They surface in the inbox's
// "System Announcements" tab and are deliberately kept out of Primary and Team
// Box, so a person's own mail is never buried under machine-written notices.
//
// The one entry point is announceRequestEvent(), called from
// requestNotificationService — the single place every request event already
// passes through, so nothing in the Request Center can be missed.
//
// Fire-and-safe: a failure is logged and swallowed. Approving a leave request
// must never fail because its announcement could not be written.
const mongoose = require("mongoose");

const isObjId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Colour and label the outcome the way the Request Center does, so the mail
// reads at a glance without opening the request. Keys are the `action` values
// the request controllers actually pass — the leave flow alone uses ten of them.
const APPROVED = {
  label: "Approved",
  color: "#0b6b3a",
  background: "#e6f4ea",
  border: "#a8d5b9",
  icon: "✓",
};
const REJECTED = {
  label: "Rejected",
  color: "#b3261e",
  background: "#fce8e6",
  border: "#f0b4b0",
  icon: "✕",
};
const WAITING = {
  label: "Awaiting approval",
  color: "#8a5300",
  background: "#fef7e0",
  border: "#f0ddaa",
  // A text glyph, not an emoji: it takes the badge's colour and stays crisp,
  // like the ✓ and ✕ beside it.
  icon: "⋯",
};
const NEUTRAL = {
  label: "Update",
  color: "#1a56c4",
  background: "#e8f0fe",
  border: "#b9cdf5",
  icon: "•",
};

const ACTION_STYLES = {
  approved: APPROVED,
  system_approved: APPROVED,
  finalized: APPROVED,
  rejected: REJECTED,
  submitted: WAITING,
  approval_required: { ...WAITING, label: "Awaiting your approval" },
  approval_progress: { ...WAITING, label: "Partly approved" },
  cancelled: {
    label: "Cancelled",
    color: "#5f6368",
    background: "#f1f3f4",
    border: "#dadce0",
    icon: "—",
  },
  updated: { ...NEUTRAL, label: "Updated" },
  assigned: { ...NEUTRAL, label: "Assigned" },
  moved: { ...NEUTRAL, label: "Moved" },
};

const formatWhen = (date) => {
  try {
    return new Date(date).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch (e) {
    return "";
  }
};

// NOTE: emitted as ONE LINE on purpose. The mail body is rendered into a
// container styled `whitespace-pre-wrap` (EmailDetail), which turns any
// newline or indentation between tags into visible blank space — a pretty
// template renders as a ragged one. The wrapper also resets white-space for
// its own subtree so the card is laid out by CSS, not by source formatting.
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const detailRow = (label, valueHtml, isLast = false) =>
  `<tr>` +
  // Fixed label column so every announcement lines up the same way, whatever
  // the longest value happens to be.
  `<td style="width:104px;padding:10px 16px 10px 0;vertical-align:top;white-space:nowrap;font-size:12px;color:#80868b;${
    isLast ? "" : "border-bottom:1px solid #edeff2;"
  }">${escapeHtml(label)}</td>` +
  `<td style="padding:10px 0;vertical-align:top;font-size:13px;color:#202124;font-weight:500;${
    isLast ? "" : "border-bottom:1px solid #edeff2;"
  }">${valueHtml}</td>` +
  `</tr>`;

const buildAnnouncementHtml = ({
  title,
  message,
  action,
  actorName,
  requestLabel,
  occurredAt,
}) => {
  const style = ACTION_STYLES[action] || {
    ...NEUTRAL,
    // An unmapped action still has to read like English, not like a key.
    label: action
      ? String(action).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
      : "Update",
  };

  const pill =
    `<span style="display:inline-block;padding:3px 12px;border-radius:999px;` +
    `border:1px solid ${style.border};background:${style.background};color:${style.color};` +
    `font-size:12px;font-weight:600;line-height:18px;">${escapeHtml(style.label)}</span>`;

  const when = formatWhen(occurredAt || new Date());

  const rows =
    detailRow("Status", pill) +
    detailRow("Request", escapeHtml(requestLabel || "Request")) +
    (actorName ? detailRow("Actioned by", escapeHtml(actorName)) : "") +
    (when ? detailRow("When", escapeHtml(when), true) : "");

  return (
    // white-space:normal undoes the pre-wrap container; the card owns its layout.
    `<div style="white-space:normal;font-family:${FONT};color:#202124;">` +
      `<div style="max-width:560px;border:1px solid #e3e6ea;border-radius:14px;overflow:hidden;background:#ffffff;box-shadow:0 1px 2px rgba(60,64,67,.08);">` +
        // Accent bar carries the outcome's colour across the top of the card.
        `<div style="height:4px;background:${style.color};"></div>` +
        `<div style="padding:20px 22px 4px;">` +
          `<table style="border-collapse:collapse;width:100%;"><tr>` +
            `<td style="width:38px;vertical-align:top;padding:0;">` +
              `<span style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;border-radius:50%;` +
              `background:${style.background};color:${style.color};font-size:15px;font-weight:700;">${style.icon}</span>` +
            `</td>` +
            `<td style="vertical-align:top;padding:0 0 0 12px;">` +
              `<div style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#80868b;font-weight:600;">Request Center</div>` +
              `<div style="margin-top:3px;font-size:17px;line-height:24px;font-weight:600;color:#202124;">${escapeHtml(title)}</div>` +
            `</td>` +
          `</tr></table>` +
          (message
            ? `<p style="margin:14px 0 0;font-size:14px;line-height:22px;color:#3c4043;">${escapeHtml(message)}</p>`
            : "") +
          `<table style="border-collapse:collapse;width:100%;margin:18px 0 0;">${rows}</table>` +
        `</div>` +
        `<div style="margin-top:16px;padding:12px 22px;background:#f7f9fc;border-top:1px solid #edeff2;font-size:12px;line-height:18px;color:#80868b;">` +
          `Sent automatically by the Request Center — open it from the sidebar to see the full request${
            action === "approval_required" || action === "submitted"
              ? " and act on it"
              : ""
          }.` +
        `</div>` +
      `</div>` +
    `</div>`
  );
};

/**
 * An announcement has to come FROM somebody — AssignmentMessage.sender is
 * required. The person who caused the event is the honest answer; failing that
 * an admin, and only then the recipient themselves.
 */
async function resolveSender({ actorId, recipientId, ownerId }) {
  if (isObjId(actorId) && String(actorId) !== String(recipientId)) return actorId;

  const Employee = require("../models/Employees");
  const admin = await Employee.findOne({
    owner: ownerId,
    isAdmin: true,
    status: "active",
    _id: { $ne: recipientId },
  })
    .select("_id")
    .lean();

  return admin?._id || actorId || recipientId;
}

/**
 * Mirror one Request Center event into the recipient's System Announcements
 * tab. Called once per notification, so each person gets exactly the notices
 * that concern them and read state stays per-user.
 */
async function announceRequestEvent({
  recipientId,
  actorId,
  title,
  message,
  requestId,
  requestType,
  requestLabel,
  action,
  target,
  // Set by the backfill so a historic event is dated when it happened.
  occurredAt,
  io,
}) {
  try {
    if (!isObjId(recipientId) || !title) return null;

    const Employee = require("../models/Employees");
    const AssignmentMessage = require("../models/AssignmentMessage");

    const recipient = await Employee.findById(recipientId)
      .select("_id owner status")
      .lean();
    if (!recipient) return null;
    // Someone who has left keeps their old mail but is sent nothing new.
    if (String(recipient.status || "").toLowerCase() !== "active") return null;

    const ownerId = Array.isArray(recipient.owner)
      ? recipient.owner[0]
      : recipient.owner;
    if (!isObjId(ownerId)) return null;

    const sender = await resolveSender({ actorId, recipientId, ownerId });
    const actor = isObjId(actorId)
      ? await Employee.findById(actorId).select("name").lean()
      : null;

    const announcement = await AssignmentMessage.create({
      owner: ownerId,
      sender,
      senderType: "employee",
      receiver: [recipientId],
      subject: title,
      note: buildAnnouncementHtml({
        title,
        message,
        action,
        actorName: actor?.name,
        requestLabel,
        occurredAt: occurredAt || new Date(),
      }),
      // Internal system mail is outside the client approval flow — null, not
      // "approved", or the UI renders a green badge for an approval that never
      // happened (same reasoning as the HR policy delivery).
      approvalStatus: null,
      status: "sent",
      sentAt: new Date(),
      source: "system",
      isSystemMessage: true,
      isSystemAnnouncement: true,
      systemAnnouncement: {
        category: "request",
        requestType,
        requestId: isObjId(requestId) ? requestId : undefined,
        action,
        target,
      },
    });

    // Same event the mail views already listen on, so an open inbox picks the
    // announcement up without a reload.
    if (io) {
      io.to(`employee_${recipientId}`).emit("system_announcement", {
        _id: String(announcement._id),
        subject: title,
        action,
        requestType,
        createdAt: announcement.createdAt,
      });
    }

    return announcement;
  } catch (error) {
    console.error(
      "announceRequestEvent error (request unaffected):",
      error.message
    );
    return null;
  }
}

module.exports = { announceRequestEvent };
