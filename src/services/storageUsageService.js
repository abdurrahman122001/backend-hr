const fsp = require("fs/promises");
const path = require("path");
const mongoose = require("mongoose");
const Employee = require("../models/Employees");

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();

const uploadRoots = [
  path.resolve(__dirname, "..", "uploads"),
  path.resolve(__dirname, "..", "..", "uploads"),
];

const FILE_KEY_PATTERN =
  /(attachment|certificate|cnic|contract|cv|document|file|image|logo|nda|path|photo|receipt|resume|signature|url)/i;

const EMPLOYEE_ID_KEYS = [
  "uploadedBy",
  "reportedBy",
  "employee",
  "employeeId",
  "sender",
  "senderId",
  "requestedBy",
  "createdBy",
  "author",
  "user",
];

const MODEL_SPECS = [
  {
    name: "EmployeeDocument",
    filter: (_ownerId, employeeIds) => ({
      employee: { $in: employeeIds },
    }),
    projection: "employee cnicFrontUrl cnicBackUrl resumeUrl",
  },
  {
    name: "Certificate",
    filter: (_ownerId, employeeIds) => ({
      employee: { $in: employeeIds },
    }),
    projection: "employee fileUrl",
  },
  {
    name: "ChatThread",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner sender attachments",
  },
  {
    name: "ThreadChatMessage",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner sender attachments",
  },
  {
    name: "AssignmentMessage",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner sender attachments comments",
  },
  {
    name: "WhatsAppMessage",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner sender attachments comments",
  },
  {
    name: "ReimbursementRequest",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner employee receiptUrl",
  },
  {
    name: "TaxAdjustmentRequest",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner employee attachmentUrl",
  },
  {
    name: "WhistleblowingReport",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner employee attachmentUrl",
  },
  {
    name: "AttendanceChallenge",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner employee challengeAttachment",
  },
  {
    name: "ProfileRevision",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner employee changes",
  },
  {
    name: "Bug",
    filter: (_ownerId, employeeIds) => ({
      reportedBy: { $in: employeeIds },
    }),
    projection: "reportedBy images",
  },
  {
    name: "Task",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner createdBy attachments",
  },
  {
    name: "CompanyProfile",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner logo",
    shared: true,
  },
  {
    name: "Signature",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner signatureImage",
    shared: true,
  },
  {
    name: "ClientInfo",
    filter: (ownerId) => ({ owner: ownerId }),
    projection: "owner photographUrl companyEmployees businesses",
    shared: true,
  },
];

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

async function listFiles(root) {
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) return;
        if (entry.isDirectory()) {
          await visit(absolutePath);
          return;
        }
        if (!entry.isFile()) return;

        const stat = await fsp.stat(absolutePath);
        files.push({
          absolutePath,
          relativePath: normalizePath(path.relative(root, absolutePath)),
          basename: entry.name.toLowerCase(),
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }),
    );
  }

  await visit(root);
  return files;
}

async function scanUploadRoots() {
  const existingRoots = [];
  const seenRoots = new Set();

  for (const root of uploadRoots) {
    try {
      const realRoot = await fsp.realpath(root);
      const key = normalizePath(realRoot);
      if (!seenRoots.has(key)) {
        existingRoots.push({ root, realRoot });
        seenRoots.add(key);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const nestedFiles = await Promise.all(
    existingRoots.map(async ({ root, realRoot }) => {
      const files = await listFiles(realRoot);
      return files.map((file) => ({
        ...file,
        root,
        rootKey: normalizePath(realRoot),
      }));
    }),
  );

  return {
    roots: existingRoots.map(({ realRoot }) => realRoot),
    files: nestedFiles.flat(),
  };
}

function makeFileResolver(files) {
  const exact = new Map();
  const basenames = new Map();

  function addExact(key, file) {
    const normalized = normalizePath(key);
    if (normalized && !exact.has(normalized)) exact.set(normalized, file);
  }

  for (const file of files) {
    const relative = file.relativePath;
    addExact(file.absolutePath, file);
    addExact(relative, file);
    addExact(`/uploads/${relative}`, file);
    addExact(`uploads/${relative}`, file);
    addExact(`/upload/${relative}`, file);
    addExact(`upload/${relative}`, file);

    const matches = basenames.get(file.basename) || [];
    matches.push(file);
    basenames.set(file.basename, matches);
  }

  function resolve(rawValue) {
    if (typeof rawValue !== "string" || !rawValue.trim()) return null;

    let value = rawValue.trim();
    try {
      if (/^https?:\/\//i.test(value)) value = new URL(value).pathname;
      value = decodeURIComponent(value);
    } catch (_) {
      // Malformed legacy URLs still get a basic path match below.
    }

    value = value.split("?")[0].split("#")[0];
    const normalized = normalizePath(value);
    const direct = exact.get(normalized);
    if (direct) return direct;

    const uploadsIndex = normalized.lastIndexOf("/uploads/");
    if (uploadsIndex >= 0) {
      const match = exact.get(normalized.slice(uploadsIndex));
      if (match) return match;
    }

    const uploadIndex = normalized.lastIndexOf("/upload/");
    if (uploadIndex >= 0) {
      const match = exact.get(normalized.slice(uploadIndex));
      if (match) return match;
    }

    const basename = path.posix.basename(normalized);
    const basenameMatches = basenames.get(basename) || [];
    return basenameMatches.length === 1 ? basenameMatches[0] : null;
  }

  return { resolve };
}

function toEmployeeId(value, employeeIds) {
  if (!value) return null;

  const candidates = Array.isArray(value)
    ? value
    : typeof value === "object" && value._id
      ? [value._id]
      : [value];

  for (const candidate of candidates) {
    const id = String(candidate?._id || candidate || "");
    if (employeeIds.has(id)) return id;
  }
  return null;
}

function employeeFromObject(value, employeeIds, inheritedEmployeeId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return inheritedEmployeeId;
  }

  for (const key of EMPLOYEE_ID_KEYS) {
    const id = toEmployeeId(value[key], employeeIds);
    if (id) return id;
  }
  return inheritedEmployeeId;
}

function fileCategory(file) {
  const value = file.relativePath;
  if (value.includes("chat-attachments")) return "chat";
  if (value.startsWith("assignments/") || value.startsWith("tasks/")) {
    return "tasks";
  }
  if (value.startsWith("documents/")) return "generatedDocuments";
  if (/^(photos|cv|cnic|certificates|employee|employees)\//.test(value)) {
    return "employeeDocuments";
  }
  if (value.startsWith("signatures/")) return "company";
  return "other";
}

function makeAssignmentStore(files, employees, ownerId) {
  const assignments = new Map();
  const employeeIds = new Set(
    employees.map((employee) => String(employee._id)),
  );

  function assign(file, employeeId, priority = 2) {
    if (!file) return;
    const key = normalizePath(file.absolutePath);
    const existing = assignments.get(key);
    if (existing && existing.priority > priority) return;
    if (
      existing &&
      existing.priority === priority &&
      existing.employeeId &&
      !employeeId
    ) {
      return;
    }

    assignments.set(key, {
      file,
      employeeId: employeeId || null,
      priority,
      category: fileCategory(file),
    });
  }

  for (const file of files) {
    const segments = file.relativePath.split("/");
    const folder = segments[0];
    const possibleEmployeeId = segments[1];

    if (
      ["certificate", "certificates", "employee", "employees"].includes(
        folder,
      ) &&
      employeeIds.has(possibleEmployeeId)
    ) {
      assign(file, possibleEmployeeId, 4);
      continue;
    }

    if (
      folder === "documents" &&
      segments[1] === String(ownerId).toLowerCase()
    ) {
      const documentEmployeeId = (
        file.basename.match(/[a-f0-9]{24}/g) || []
      ).find((candidateId) => employeeIds.has(candidateId));

      assign(
        file,
        documentEmployeeId || null,
        documentEmployeeId ? 4 : 1,
      );
    }
  }

  return { assignments, assign, employeeIds };
}

function collectReferences(
  value,
  resolver,
  assignmentStore,
  inheritedEmployeeId = null,
  keyName = "",
  allowIdentity = true,
) {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    if (FILE_KEY_PATTERN.test(keyName) || /(^|\/)uploads?\//i.test(value)) {
      const file = resolver.resolve(value);
      assignmentStore.assign(
        file,
        inheritedEmployeeId,
        inheritedEmployeeId ? 3 : 1,
      );
    }
    return;
  }

  if (
    typeof value !== "object" ||
    Buffer.isBuffer(value) ||
    value instanceof Date
  ) {
    return;
  }

  if (value._bsontype === "ObjectId" || value._bsontype === "ObjectID") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferences(
        item,
        resolver,
        assignmentStore,
        inheritedEmployeeId,
        keyName,
        allowIdentity,
      );
    }
    return;
  }

  const localEmployeeId = allowIdentity
    ? employeeFromObject(
        value,
        assignmentStore.employeeIds,
        inheritedEmployeeId,
      )
    : null;

  for (const [key, child] of Object.entries(value)) {
    collectReferences(
      child,
      resolver,
      assignmentStore,
      localEmployeeId,
      key,
      allowIdentity,
    );
  }
}

async function queryModelDocuments(ownerId, employeeIds) {
  const results = [];

  await Promise.all(
    MODEL_SPECS.map(async (spec) => {
      const Model = mongoose.models[spec.name];
      if (!Model) return;

      const documents = await Model.find(spec.filter(ownerId, employeeIds))
        .select(spec.projection)
        .lean()
        .maxTimeMS(15000);

      for (const document of documents) {
        results.push({ document, shared: Boolean(spec.shared) });
      }
    }),
  );

  const Space = mongoose.models.Space;
  const Message = mongoose.models.Message;
  if (Message && employeeIds.length) {
    let spaceIds = [];

    if (Space) {
      const spaces = await Space.find({
        $or: [
          { createdBy: { $in: employeeIds } },
          { "members.employee": { $in: employeeIds } },
        ],
      })
        .select("_id createdBy avatar image icon")
        .lean()
        .maxTimeMS(15000);

      spaceIds = spaces.map((space) => space._id);
      spaces.forEach((document) =>
        results.push({ document, shared: false }),
      );
    }

    const messageFilter = [{ sender: { $in: employeeIds } }];
    if (spaceIds.length) messageFilter.push({ space: { $in: spaceIds } });

    const messages = await Message.find({ $or: messageFilter })
      .select("sender attachments")
      .lean()
      .maxTimeMS(15000);
    messages.forEach((document) =>
      results.push({ document, shared: false }),
    );
  }

  return results;
}

async function getDiskStats(roots) {
  const target = roots[0] || path.resolve(__dirname, "..");
  if (typeof fsp.statfs !== "function") return null;

  try {
    const stats = await fsp.statfs(target);
    const blockSize = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    const freeBytes = Number(stats.bfree) * blockSize;
    const availableBytes = Number(stats.bavail) * blockSize;
    return {
      totalBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      freeBytes,
      availableBytes,
      usedPercentage: totalBytes
        ? Number((((totalBytes - freeBytes) / totalBytes) * 100).toFixed(1))
        : 0,
    };
  } catch (_) {
    return null;
  }
}

function emptyBreakdown() {
  return {
    employeeDocuments: 0,
    chat: 0,
    tasks: 0,
    generatedDocuments: 0,
    company: 0,
    other: 0,
  };
}

function addAssignmentToRow(row, assignment) {
  row.bytes += assignment.file.bytes;
  row.fileCount += 1;
  row.breakdown[assignment.category] += assignment.file.bytes;
  row.files.push({
    name: path.basename(assignment.file.absolutePath),
    path: assignment.file.relativePath,
    bytes: assignment.file.bytes,
    category: assignment.category,
    modifiedAt: assignment.file.modifiedAt,
  });
  if (
    !row.lastModifiedAt ||
    assignment.file.modifiedAt > row.lastModifiedAt
  ) {
    row.lastModifiedAt = assignment.file.modifiedAt;
  }
}

async function calculateStorageUsage(ownerId, requesterRole) {
  const employees = await Employee.find({ owner: ownerId })
    .select(
      "_id name companyEmail email employeeId department status isTrashed photographUrl cvUrl ndaPath contractPath",
    )
    .sort({ name: 1 })
    .lean();

  const employeeIds = employees.map((employee) => employee._id);
  const scan = await scanUploadRoots();
  const resolver = makeFileResolver(scan.files);
  const assignmentStore = makeAssignmentStore(
    scan.files,
    employees,
    ownerId,
  );

  for (const employee of employees) {
    collectReferences(
      employee,
      resolver,
      assignmentStore,
      String(employee._id),
    );
  }

  const modelDocuments = await queryModelDocuments(ownerId, employeeIds);
  for (const { document, shared } of modelDocuments) {
    collectReferences(
      document,
      resolver,
      assignmentStore,
      null,
      "",
      !shared,
    );
  }

  if (String(requesterRole || "").toLowerCase() === "super-admin") {
    for (const file of scan.files) {
      const key = normalizePath(file.absolutePath);
      if (!assignmentStore.assignments.has(key)) {
        assignmentStore.assign(file, null, 0);
      }
    }
  }

  const rows = new Map();
  for (const employee of employees) {
    rows.set(String(employee._id), {
      id: String(employee._id),
      type: "employee",
      name: employee.name || "Unnamed user",
      email: employee.companyEmail || employee.email || "",
      photographUrl: employee.photographUrl || "",
      employeeId: employee.employeeId || "",
      department: employee.department || "",
      status: employee.isTrashed ? "trashed" : employee.status || "active",
      bytes: 0,
      fileCount: 0,
      lastModifiedAt: null,
      breakdown: emptyBreakdown(),
      files: [],
    });
  }

  const sharedRow = {
    id: "shared",
    type: "shared",
    name: "Company & shared files",
    email: "Files not owned by one employee",
    employeeId: "",
    department: "Shared",
    status: "active",
    bytes: 0,
    fileCount: 0,
    lastModifiedAt: null,
    breakdown: emptyBreakdown(),
    files: [],
  };

  for (const assignment of assignmentStore.assignments.values()) {
    const row = assignment.employeeId
      ? rows.get(assignment.employeeId)
      : sharedRow;
    if (row) addAssignmentToRow(row, assignment);
  }

  for (const row of [...rows.values(), sharedRow]) {
    row.files.sort(
      (left, right) =>
        right.bytes - left.bytes || left.name.localeCompare(right.name),
    );
  }

  const userRows = [...rows.values(), sharedRow].sort(
    (left, right) =>
      right.bytes - left.bytes || left.name.localeCompare(right.name),
  );
  const trackedBytes = userRows.reduce((sum, row) => sum + row.bytes, 0);
  const trackedFiles = userRows.reduce(
    (sum, row) => sum + row.fileCount,
    0,
  );
  const disk = await getDiskStats(scan.roots);

  for (const row of userRows) {
    row.percentage = trackedBytes
      ? Number(((row.bytes / trackedBytes) * 100).toFixed(1))
      : 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    environment:
      process.env.NODE_ENV === "production"
        ? "VPS / production server"
        : "Local PC",
    storageSource: "backend-filesystem",
    totals: {
      bytes: trackedBytes,
      fileCount: trackedFiles,
      scannedBytes: scan.files.reduce((sum, file) => sum + file.bytes, 0),
      scannedFileCount: scan.files.length,
      userCount: employees.length,
    },
    disk,
    users: userRows,
  };
}

async function getStorageUsage(
  ownerId,
  requesterRole,
  forceRefresh = false,
) {
  const cacheKey = `${ownerId}:${requesterRole}`;
  const existing = cache.get(cacheKey);

  if (
    !forceRefresh &&
    existing &&
    Date.now() - existing.createdAt < CACHE_TTL_MS
  ) {
    return existing.value;
  }

  const value = await calculateStorageUsage(ownerId, requesterRole);
  cache.set(cacheKey, { createdAt: Date.now(), value });
  return value;
}

module.exports = {
  getStorageUsage,
  uploadRoots,
};
