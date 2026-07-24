const crypto = require("crypto");
const Whiteboard = require("../models/Whiteboard");

/* Resolve the tenant scope + author identity from the authed employee. */
function scope(req) {
  const emp = req.employee || {};
  const owner = emp.owner || emp._id;
  const me = {
    id: String(emp._id),
    name: emp.name || emp.companyEmail || "You",
    email: emp.companyEmail || "",
    avatar: "",
  };
  return { owner, me };
}

/* Boards the requesting employee is allowed to see: ones they created or ones
 * explicitly shared with them (a grant). Combined with the tenant `owner` scope,
 * this stops normal employees from seeing every board in the workspace — they
 * only get their own boards plus anything shared via the ShareDialog. The board
 * creator always holds a "full" grant (set on create/seed/duplicate), so this
 * also covers authorship. */
function accessCond(req) {
  const emp = req.employee || {};
  return {
    $or: [{ createdByEmployee: emp._id }, { "grants.userId": String(emp._id) }],
  };
}

function token() {
  return crypto.randomBytes(9).toString("hex");
}

/* GET /whiteboards — active boards for the tenant (newest first). */
exports.list = async (req, res) => {
  try {
    const { owner } = scope(req);
    const boards = await Whiteboard.find({
      owner,
      deletedAt: null,
      ...accessCond(req),
    }).sort({
      updatedAt: -1,
    });
    res.json({ whiteboards: boards.map((b) => b.toClient()) });
  } catch (err) {
    console.error("[whiteboards.list]", err);
    res.status(500).json({ error: "Failed to load whiteboards" });
  }
};

/* GET /whiteboards/trash — soft-deleted boards (30-day retention window). */
exports.trash = async (req, res) => {
  try {
    const { owner } = scope(req);
    const boards = await Whiteboard.find({
      owner,
      deletedAt: { $ne: null },
      ...accessCond(req),
    }).sort({
      deletedAt: -1,
    });
    res.json({ whiteboards: boards.map((b) => b.toClient()) });
  } catch (err) {
    console.error("[whiteboards.trash]", err);
    res.status(500).json({ error: "Failed to load trash" });
  }
};

/* GET /whiteboards/:id */
exports.getOne = async (req, res) => {
  try {
    const { owner } = scope(req);
    const board = await Whiteboard.findOne({
      _id: req.params.id,
      owner,
      ...accessCond(req),
    });
    if (!board) return res.status(404).json({ error: "Whiteboard not found" });
    res.json({ whiteboard: board.toClient() });
  } catch (err) {
    console.error("[whiteboards.getOne]", err);
    res.status(500).json({ error: "Failed to load whiteboard" });
  }
};

/* POST /whiteboards — create. Accepts name/location/visibility/items/color/iconKey. */
exports.create = async (req, res) => {
  try {
    const { owner, me } = scope(req);
    const {
      name,
      locationId,
      locationName,
      visibility,
      items,
      color,
      iconKey,
      preferences,
    } = req.body || {};

    const board = await Whiteboard.create({
      owner,
      name: (name || "Untitled Whiteboard").trim(),
      locationId: locationId || null,
      locationName: locationName || "Workspace",
      visibility: visibility === "private" ? "private" : "public",
      items: Array.isArray(items) ? items : [],
      createdBy: me,
      createdByEmployee: req.employee._id,
      favoriteUserIds: [],
      grants: [{ userId: me.id, name: me.name, email: me.email, avatar: me.avatar, level: "full" }],
      publicLink: { enabled: false, level: "view", token: token(), expiration: "never" },
      preferences: preferences || undefined,
      color: color || "#8b5cf6",
      iconKey: iconKey || "flow",
    });
    res.status(201).json({ whiteboard: board.toClient() });
  } catch (err) {
    console.error("[whiteboards.create]", err);
    res.status(500).json({ error: "Failed to create whiteboard" });
  }
};

/* Bulk seed (used once when a tenant has no boards yet). Body: { boards: [...] } */
exports.seed = async (req, res) => {
  try {
    const { owner, me } = scope(req);
    // Seed is per-employee: only skip (and return the employee's OWN boards) when
    // THIS employee already has accessible boards. A workspace full of other
    // people's boards must not suppress this employee's starter set or leak into
    // their Hub.
    const existing = await Whiteboard.countDocuments({ owner, ...accessCond(req) });
    if (existing > 0) {
      const boards = await Whiteboard.find({
        owner,
        deletedAt: null,
        ...accessCond(req),
      }).sort({ updatedAt: -1 });
      return res.json({ whiteboards: boards.map((b) => b.toClient()), seeded: false });
    }
    const incoming = Array.isArray(req.body?.boards) ? req.body.boards : [];
    const docs = incoming.map((b) => ({
      owner,
      name: b.name || "Untitled Whiteboard",
      locationId: b.locationId || null,
      locationName: b.locationName || "Workspace",
      visibility: b.visibility === "private" ? "private" : "public",
      items: Array.isArray(b.items) ? b.items : [],
      createdBy: b.createdBy && b.createdBy.id ? b.createdBy : me,
      createdByEmployee: req.employee._id,
      favoriteUserIds: Array.isArray(b.favoriteUserIds) ? b.favoriteUserIds : [],
      grants:
        Array.isArray(b.grants) && b.grants.length
          ? b.grants
          : [{ userId: me.id, name: me.name, email: me.email, avatar: me.avatar, level: "full" }],
      publicLink: { enabled: false, level: "view", token: token(), expiration: "never" },
      color: b.color || "#8b5cf6",
      iconKey: b.iconKey || "flow",
      createdAt: b.createdAt ? new Date(b.createdAt) : undefined,
      updatedAt: b.updatedAt ? new Date(b.updatedAt) : undefined,
    }));
    const created = await Whiteboard.insertMany(docs);
    res.status(201).json({ whiteboards: created.map((b) => b.toClient()), seeded: true });
  } catch (err) {
    console.error("[whiteboards.seed]", err);
    res.status(500).json({ error: "Failed to seed whiteboards" });
  }
};

/* PATCH /whiteboards/:id — update meta (name/location/visibility/grants/publicLink/preferences/color/iconKey). */
exports.update = async (req, res) => {
  try {
    const { owner } = scope(req);
    const board = await Whiteboard.findOne({
      _id: req.params.id,
      owner,
      ...accessCond(req),
    });
    if (!board) return res.status(404).json({ error: "Whiteboard not found" });

    const allowed = [
      "name",
      "locationId",
      "locationName",
      "visibility",
      "grants",
      "publicLink",
      "preferences",
      "color",
      "iconKey",
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) board[key] = req.body[key];
    }
    await board.save();
    res.json({ whiteboard: board.toClient() });
  } catch (err) {
    console.error("[whiteboards.update]", err);
    res.status(500).json({ error: "Failed to update whiteboard" });
  }
};

/* PUT /whiteboards/:id/items — replace the canvas items (autosave). */
exports.updateItems = async (req, res) => {
  try {
    const { owner } = scope(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const board = await Whiteboard.findOneAndUpdate(
      { _id: req.params.id, owner, ...accessCond(req) },
      { $set: { items, viewedAt: new Date() } },
      { new: true }
    );
    if (!board) return res.status(404).json({ error: "Whiteboard not found" });
    res.json({ ok: true, updatedAt: board.updatedAt });
  } catch (err) {
    console.error("[whiteboards.updateItems]", err);
    res.status(500).json({ error: "Failed to save whiteboard" });
  }
};

/* POST /whiteboards/:id/favorite — toggle favorite for the current employee. */
exports.toggleFavorite = async (req, res) => {
  try {
    const { owner, me } = scope(req);
    const board = await Whiteboard.findOne({
      _id: req.params.id,
      owner,
      ...accessCond(req),
    });
    if (!board) return res.status(404).json({ error: "Whiteboard not found" });
    const has = board.favoriteUserIds.includes(me.id);
    board.favoriteUserIds = has
      ? board.favoriteUserIds.filter((u) => u !== me.id)
      : [...board.favoriteUserIds, me.id];
    await board.save();
    res.json({ favoriteUserIds: board.favoriteUserIds });
  } catch (err) {
    console.error("[whiteboards.toggleFavorite]", err);
    res.status(500).json({ error: "Failed to favorite" });
  }
};

/* POST /whiteboards/:id/duplicate */
exports.duplicate = async (req, res) => {
  try {
    const { owner, me } = scope(req);
    const src = await Whiteboard.findOne({
      _id: req.params.id,
      owner,
      ...accessCond(req),
    });
    if (!src) return res.status(404).json({ error: "Whiteboard not found" });
    const copy = await Whiteboard.create({
      owner,
      name: `${src.name} (copy)`,
      locationId: src.locationId,
      locationName: src.locationName,
      visibility: src.visibility,
      items: src.items,
      createdBy: me,
      createdByEmployee: req.employee._id,
      favoriteUserIds: [],
      preferences: src.preferences,
      grants: [{ userId: me.id, name: me.name, email: me.email, avatar: me.avatar, level: "full" }],
      publicLink: { enabled: false, level: "view", token: token(), expiration: "never" },
      color: src.color,
      iconKey: src.iconKey,
    });
    res.status(201).json({ whiteboard: copy.toClient() });
  } catch (err) {
    console.error("[whiteboards.duplicate]", err);
    res.status(500).json({ error: "Failed to duplicate" });
  }
};

/* DELETE /whiteboards/:id — soft delete (or ?permanent=true to purge). */
exports.remove = async (req, res) => {
  try {
    const { owner } = scope(req);
    if (req.query.permanent === "true") {
      await Whiteboard.deleteOne({ _id: req.params.id, owner, ...accessCond(req) });
      return res.json({ ok: true, permanent: true });
    }
    const board = await Whiteboard.findOneAndUpdate(
      { _id: req.params.id, owner, ...accessCond(req) },
      { $set: { deletedAt: new Date() } },
      { new: true }
    );
    if (!board) return res.status(404).json({ error: "Whiteboard not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[whiteboards.remove]", err);
    res.status(500).json({ error: "Failed to delete" });
  }
};

/* POST /whiteboards/:id/restore */
exports.restore = async (req, res) => {
  try {
    const { owner } = scope(req);
    const board = await Whiteboard.findOneAndUpdate(
      { _id: req.params.id, owner, ...accessCond(req) },
      { $set: { deletedAt: null } },
      { new: true }
    );
    if (!board) return res.status(404).json({ error: "Whiteboard not found" });
    res.json({ whiteboard: board.toClient() });
  } catch (err) {
    console.error("[whiteboards.restore]", err);
    res.status(500).json({ error: "Failed to restore" });
  }
};
