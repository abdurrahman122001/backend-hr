// Flowboard — Whiteboards. A board owns a heterogeneous list of canvas items
// (shapes, sticky notes, text, connectors, frames, images, freehand drawings).
// Item shapes are owned by the frontend schema, so `items` is stored as a
// flexible Mixed array and versioned via `schemaVersion` for migrations.
const mongoose = require("mongoose");

const WBUserSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    avatar: { type: String, default: "" },
  },
  { _id: false }
);

const GrantSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    avatar: { type: String, default: "" },
    level: {
      type: String,
      enum: ["view", "comment", "edit", "full"],
      default: "edit",
    },
  },
  { _id: false }
);

const PublicLinkSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    level: {
      type: String,
      enum: ["view", "comment", "edit", "full"],
      default: "view",
    },
    token: { type: String, default: "" },
    expiration: {
      type: String,
      enum: ["never", "1d", "7d", "30d"],
      default: "never",
    },
    taskPropertiesVisible: { type: Boolean, default: true },
    embeddedTasksOpen: { type: Boolean, default: true },
  },
  { _id: false }
);

const PreferencesSchema = new mongoose.Schema(
  {
    dotGrid: { type: Boolean, default: true },
    alignmentGuides: { type: Boolean, default: true },
    edgeScrolling: { type: Boolean, default: true },
    reduceMotion: { type: Boolean, default: false },
  },
  { _id: false }
);

const whiteboardSchema = new mongoose.Schema(
  {
    // Tenant scope — everyone under the same owner shares the board space.
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      required: true,
    },
    name: { type: String, required: true, trim: true, default: "Untitled Whiteboard" },
    locationId: { type: String, default: null },
    locationName: { type: String, default: "Workspace" },
    visibility: { type: String, enum: ["public", "private"], default: "public" },

    // Employee ids (as strings) who favorited the board.
    favoriteUserIds: { type: [String], default: [] },

    // Heterogeneous canvas items. Item internal shape is validated client-side.
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },

    // Denormalized author for quick rendering + the owning Employee ref.
    createdBy: { type: WBUserSchema, required: true },
    createdByEmployee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      index: true,
    },

    preferences: { type: PreferencesSchema, default: () => ({}) },
    grants: { type: [GrantSchema], default: [] },
    publicLink: { type: PublicLinkSchema, default: () => ({}) },

    color: { type: String, default: "#8b5cf6" },
    iconKey: { type: String, default: "flow" },

    viewedAt: { type: Date },
    schemaVersion: { type: Number, default: 1 },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, minimize: false }
);

whiteboardSchema.index({ owner: 1, deletedAt: 1, updatedAt: -1 });

// Serialize to the shape the frontend `Whiteboard` type expects.
whiteboardSchema.methods.toClient = function toClient() {
  return {
    id: String(this._id),
    name: this.name,
    locationId: this.locationId,
    locationName: this.locationName,
    visibility: this.visibility,
    favoriteUserIds: this.favoriteUserIds || [],
    items: this.items || [],
    createdBy: this.createdBy,
    createdAt: this.createdAt ? this.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: this.updatedAt ? this.updatedAt.toISOString() : new Date().toISOString(),
    viewedAt: this.viewedAt ? this.viewedAt.toISOString() : undefined,
    preferences: this.preferences,
    grants: this.grants || [],
    publicLink: this.publicLink,
    color: this.color,
    iconKey: this.iconKey,
    schemaVersion: this.schemaVersion || 1,
    deletedAt: this.deletedAt ? this.deletedAt.toISOString() : undefined,
  };
};

module.exports =
  mongoose.models.Whiteboard || mongoose.model("Whiteboard", whiteboardSchema);
