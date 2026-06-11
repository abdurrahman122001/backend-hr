const mongoose = require("mongoose");
const { Schema } = mongoose;

const GroupMemberSchema = new Schema(
  {
    memberId: { type: String, required: true }, // ObjectId of Employee, ClientInfo, or client employee sub-doc
    memberType: {
      type: String,
      enum: ["employee", "client", "client_employee"],
      required: true,
    },
    memberName: { type: String, default: "" },
    memberEmail: { type: String, default: "" },
    // For client_employee members
    parentClientId: { type: String, default: null },
    parentClientName: { type: String, default: null },
    addedAt: { type: Date, default: Date.now },
    addedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
  },
  { _id: true }
);

const WhatsAppGroupSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    members: [GroupMemberSchema],
    /**
     * groupType is derived from members:
     *   employees_only       – only Employee members
     *   clients_only         – only Client members
     *   client_employees_only – only ClientEmployee members
     *   mixed                – any combination
     */
    groupType: {
      type: String,
      enum: [
        "employees_only",
        "clients_only",
        "client_employees_only",
        "mixed",
      ],
      default: "mixed",
    },
    avatar: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    /**
     * Per-member WhatsApp flags (whatsappPinned / whatsappFavourite /
     * whatsappMuted / whatsappArchived) keyed by the member's employee id,
     * so archiving a group only affects the member who archived it.
     */
    memberFlags: { type: Map, of: Schema.Types.Mixed, default: {} },
    // Last-message metadata (denormalized for sidebar speed)
    lastMessage: { type: String, default: null },
    lastMessageAt: { type: Date, default: null },
    lastMessageBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
  },
  { timestamps: true }
);

WhatsAppGroupSchema.index({ owner: 1, createdAt: -1 });
WhatsAppGroupSchema.index({ "members.memberId": 1 });
WhatsAppGroupSchema.index({ isActive: 1, owner: 1, updatedAt: -1 });
// getChatList groups query: owner + isActive + my membership, sorted by lastMessageAt
WhatsAppGroupSchema.index({ owner: 1, isActive: 1, "members.memberId": 1, lastMessageAt: -1 });

module.exports = mongoose.model("WhatsAppGroup", WhatsAppGroupSchema);
