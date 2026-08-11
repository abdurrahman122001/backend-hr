const RequestNotification = require("../models/RequestNotification");
const Employee = require("../models/Employees");

const normalizeId = (value) => {
  if (!value) return null;
  if (value._id) return String(value._id);
  return String(value);
};

const idsEqual = (a, b) => normalizeId(a) === normalizeId(b);

const buildTarget = ({ requestId, requestType, action, forApproval }) => ({
  path: "request-center",
  query: {
    openRequests: "true",
    requestsTab: forApproval ? "for-approval" : "my-requests",
    requestsSubTab: forApproval
      ? "my-approvals"
      : ["approved", "rejected"].includes(action)
        ? "closed"
        : "active",
    requestId: normalizeId(requestId),
    requestType: requestType || "leave",
  },
});

const serializeNotification = (notification) => ({
  _id: notification._id,
  recipient: notification.recipient,
  actor: notification.actor,
  requestId: notification.requestId,
  requestModel: notification.requestModel,
  requestType: notification.requestType,
  action: notification.action,
  title: notification.title,
  message: notification.message,
  target: notification.target,
  read: notification.read,
  readAt: notification.readAt,
  metadata: notification.metadata,
  createdAt: notification.createdAt,
  updatedAt: notification.updatedAt,
});

async function createRequestNotification({
  req,
  io,
  recipient,
  actor,
  requestId,
  requestType = "leave",
  requestModel = "ApplyLeave",
  action,
  title,
  message,
  forApproval = false,
  metadata,
}) {
  try {
    const recipientId = normalizeId(recipient);
    if (!recipientId || !requestId || !action || !title) return null;

    const notification = await RequestNotification.create({
      recipient: recipientId,
      actor: normalizeId(actor) || undefined,
      requestId,
      requestModel,
      requestType,
      action,
      title,
      message,
      target: buildTarget({ requestId, requestType, action, forApproval }),
      metadata,
    });

    const populated = await RequestNotification.findById(notification._id)
      .populate("actor", "name email employeeId department designation photographUrl")
      .lean();

    const payload = serializeNotification(populated || notification.toObject());
    const socket = io || req?.app?.get?.("io");
    if (socket) {
      socket.to(`employee_${recipientId}`).emit("request_notification", payload);
    }

    // Every Request Center event is also written into the recipient's inbox,
    // under System Announcements. Hooked here rather than in the notify*
    // helpers below because this is the one function EVERY request event goes
    // through — submissions, approvals, rejections and the leave-specific
    // events that call it directly.
    const {
      announceRequestEvent,
    } = require("./systemAnnouncementService");
    await announceRequestEvent({
      recipientId,
      actorId: normalizeId(actor),
      title,
      message,
      requestId,
      requestType,
      requestLabel: requestTypeLabels[requestType] || "Request",
      action,
      target: notification.target,
      io: socket,
    });

    return payload;
  } catch (error) {
    console.error("[RequestNotification] create error:", error);
    return null;
  }
}

async function createManyRequestNotifications({
  recipients = [],
  exclude,
  forApproval,
  ...payload
}) {
  const seen = new Set();
  const excludeId = normalizeId(exclude);
  const tasks = [];

  recipients.forEach((recipient) => {
    const recipientId = normalizeId(recipient);
    if (!recipientId || recipientId === excludeId || seen.has(recipientId)) return;
    seen.add(recipientId);
    tasks.push(
      createRequestNotification({
        ...payload,
        recipient: recipientId,
        forApproval:
          typeof forApproval === "function" ? forApproval(recipientId) : Boolean(forApproval),
      }),
    );
  });

  return Promise.all(tasks);
}

const requestTypeLabels = {
  leave: "Leave request",
  attendance: "Attendance adjustment",
  "advance-salary": "Advance salary request",
  bonus: "Bonus request",
  commission: "Commission request",
  document: "Document request",
  "leave-carry-forward": "Leave carry-forward request",
  "leave-encashment": "Leave encashment request",
  loan: "Loan request",
  overtime: "Overtime request",
  profile: "Profile revision request",
  reimbursement: "Reimbursement request",
  "salary-change": "Salary change request",
  "tax-adjustment": "Tax adjustment request",
  whistleblowing: "Whistleblowing report",
};

async function notifyRequestSubmitted({
  req,
  request,
  requestType,
  requestModel,
  actor,
}) {
  if (!request?._id || request.status !== "pending") return [];

  const applicantId = normalizeId(request.employee?._id || request.employee || actor);
  if (!applicantId) return [];

  const applicant = await Employee.findById(applicantId)
    .select("name owner")
    .lean();
  const ownerId = normalizeId(request.owner || applicant?.owner);
  if (!ownerId) return [];

  const administrators = await Employee.find({
    owner: ownerId,
    isAdmin: true,
    status: "active",
  })
    .select("_id")
    .lean();

  const label = requestTypeLabels[requestType] || "Request";
  return createManyRequestNotifications({
    req,
    recipients: administrators.map((employee) => employee._id),
    exclude: applicantId,
    actor: applicantId,
    requestId: request._id,
    requestType,
    requestModel,
    action: "submitted",
    title: `${label} requires approval`,
    message: `${applicant?.name || "An employee"} submitted a ${label.toLowerCase()}.`,
    forApproval: true,
  });
}

async function notifyRequestDecision({
  req,
  request,
  requestType,
  requestModel,
  status,
  actor,
  reason,
}) {
  const recipient = request?.employee?._id || request?.employee;
  if (!recipient || !request?._id || !["approved", "rejected"].includes(status)) {
    return null;
  }

  const label = requestTypeLabels[requestType] || "Request";
  const actionText = status === "approved" ? "approved" : "rejected";
  return createRequestNotification({
    req,
    recipient,
    actor,
    requestId: request._id,
    requestType,
    requestModel,
    action: status,
    title: `${label} ${actionText}`,
    message: reason
      ? `Your ${label.toLowerCase()} was ${actionText}. ${reason}`
      : `Your ${label.toLowerCase()} was ${actionText}.`,
    forApproval: false,
  });
}

module.exports = {
  createRequestNotification,
  createManyRequestNotifications,
  notifyRequestSubmitted,
  notifyRequestDecision,
  idsEqual,
  normalizeId,
};
