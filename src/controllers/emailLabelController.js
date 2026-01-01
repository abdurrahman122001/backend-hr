const EmailLabel = require("../models/EmailLabel");
const AssignmentMessage = require("../models/AssignmentMessage");
const mongoose = require("mongoose");

// Helper to validate ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// GET /api/labels - Get all labels for current employee
exports.getLabels = async (req, res) => {
  try {
    const employeeId = req.employee?._id;
    if (!isValidObjectId(employeeId)) {
      return res.status(400).json({ error: "Invalid employee ID" });
    }

    const labels = await EmailLabel.find({ employee: employeeId })
      .sort({ order: 1, createdAt: -1 })
      .populate("createdBy", "_id name companyEmail")
      .lean();

    // Format labels for frontend
    const formattedLabels = labels.map((label) => ({
      id: label._id,
      name: label.name,
      color: label.color,
      textColor: label.textColor,
      displayInSidebar: label.displayInSidebar,
      showIfUnread: label.showIfUnread,
      showInMessageList: label.showInMessageList,
      messageCount: label.messageCount || 0,
      unreadCount: label.unreadCount || 0,
      isSystem: label.isSystem || false,
      createdAt: label.createdAt,
    }));

    res.json({
      success: true,
      labels: formattedLabels,
    });
  } catch (error) {
    console.error("❌ Error fetching labels:", error);
    res.status(500).json({ error: "Failed to fetch labels" });
  }
};

// POST /api/labels - Create a new label
exports.createLabel = async (req, res) => {
  try {
    const { name, color = "#60a5fa", textColor = "#ffffff" } = req.body;
    const employeeId = req.employee?._id;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: "Label name is required" });
    }

    if (!isValidObjectId(employeeId)) {
      return res.status(400).json({ error: "Invalid employee ID" });
    }

    // Check if label with same name already exists for this employee
    const existingLabel = await EmailLabel.findOne({
      name: name.trim(),
      employee: employeeId,
    });

    if (existingLabel) {
      return res
        .status(400)
        .json({ error: "Label with this name already exists" });
    }

    // Get the highest order to place new label at the end
    const lastLabel = await EmailLabel.findOne({ employee: employeeId }).sort({ order: -1 });
    const order = lastLabel ? lastLabel.order + 1 : 0;

    const label = await EmailLabel.create({
      name: name.trim(),
      color,
      textColor,
      employee: employeeId,
      createdBy: employeeId,
      order,
    });

    const populatedLabel = await EmailLabel.findById(label._id)
      .populate("createdBy", "_id name companyEmail")
      .lean();

    res.status(201).json({
      success: true,
      message: `Label "${label.name}" created successfully`,
      label: {
        id: populatedLabel._id,
        name: populatedLabel.name,
        color: populatedLabel.color,
        textColor: populatedLabel.textColor,
        displayInSidebar: populatedLabel.displayInSidebar,
        showIfUnread: populatedLabel.showIfUnread,
        showInMessageList: populatedLabel.showInMessageList,
        messageCount: 0,
        unreadCount: 0,
        isSystem: false,
        createdAt: populatedLabel.createdAt,
      },
    });
  } catch (error) {
    console.error("❌ Error creating label:", error);
    if (error.code === 11000) {
      return res
        .status(400)
        .json({ error: "Label with this name already exists" });
    }
    res.status(500).json({ error: "Failed to create label" });
  }
};

// PUT /api/labels/:id - Update label
exports.updateLabel = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      color,
      textColor,
      displayInSidebar,
      showIfUnread,
      showInMessageList,
    } = req.body;
    const employeeId = req.employee?._id;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid label ID" });
    }

    // Find label and check ownership
    const label = await EmailLabel.findOne({
      _id: id,
      employee: employeeId,
      isSystem: false, // Prevent editing system labels
    });

    if (!label) {
      return res.status(404).json({ error: "Label not found" });
    }

    // Update fields if provided
    const updates = {};
    if (name !== undefined && name.trim() !== label.name) {
      // Check for duplicate name
      const existingLabel = await EmailLabel.findOne({
        name: name.trim(),
        employee: employeeId,
        _id: { $ne: id },
      });

      if (existingLabel) {
        return res
          .status(400)
          .json({ error: "Label with this name already exists" });
      }
      updates.name = name.trim();
    }

    if (color !== undefined) updates.color = color;
    if (textColor !== undefined) updates.textColor = textColor;
    if (displayInSidebar !== undefined)
      updates.displayInSidebar = displayInSidebar;
    if (showIfUnread !== undefined) updates.showIfUnread = showIfUnread;
    if (showInMessageList !== undefined)
      updates.showInMessageList = showInMessageList;

    // Apply updates
    Object.keys(updates).forEach((key) => {
      label[key] = updates[key];
    });

    await label.save();

    res.json({
      success: true,
      message: `Label "${label.name}" updated successfully`,
      label: {
        id: label._id,
        name: label.name,
        color: label.color,
        textColor: label.textColor,
        displayInSidebar: label.displayInSidebar,
        showIfUnread: label.showIfUnread,
        showInMessageList: label.showInMessageList,
        messageCount: label.messageCount,
        unreadCount: label.unreadCount,
        isSystem: label.isSystem,
        createdAt: label.createdAt,
      },
    });
  } catch (error) {
    console.error("❌ Error updating label:", error);
    if (error.code === 11000) {
      return res
        .status(400)
        .json({ error: "Label with this name already exists" });
    }
    res.status(500).json({ error: "Failed to update label" });
  }
};

// DELETE /api/labels/:id - Delete label
exports.deleteLabel = async (req, res) => {
  try {
    const { id } = req.params;
    const employeeId = req.employee?._id;
    const owner = req.employee?.owner; // Still need owner for message queries

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid label ID" });
    }

    // Find label and check ownership
    const label = await EmailLabel.findOne({
      _id: id,
      employee: employeeId,
      isSystem: false, // Prevent deleting system labels
    });

    if (!label) {
      return res
        .status(404)
        .json({ error: "Label not found or cannot be deleted" });
    }

    // First, remove this label from all messages that belong to the owner
    await AssignmentMessage.updateMany(
      {
        "labels.label": id,
        owner, // Messages still belong to owner
      },
      {
        $pull: {
          labels: { label: id },
        },
      }
    );

    // Delete the label
    await EmailLabel.findByIdAndDelete(id);

    res.json({
      success: true,
      message: `Label "${label.name}" deleted successfully`,
    });
  } catch (error) {
    console.error("❌ Error deleting label:", error);
    res.status(500).json({ error: "Failed to delete label" });
  }
};

// PATCH /api/labels/:id/color - Update label color
exports.updateLabelColor = async (req, res) => {
  try {
    const { id } = req.params;
    const { color, textColor } = req.body;
    const employeeId = req.employee?._id;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid label ID" });
    }

    const label = await EmailLabel.findOne({ _id: id, employee: employeeId });
    if (!label) {
      return res.status(404).json({ error: "Label not found" });
    }

    const updates = {};
    if (color !== undefined) updates.color = color;
    if (textColor !== undefined) updates.textColor = textColor;

    Object.keys(updates).forEach((key) => {
      label[key] = updates[key];
    });

    await label.save();

    res.json({
      success: true,
      message: "Label color updated successfully",
      label: {
        id: label._id,
        name: label.name,
        color: label.color,
        textColor: label.textColor,
      },
    });
  } catch (error) {
    console.error("❌ Error updating label color:", error);
    res.status(500).json({ error: "Failed to update label color" });
  }
};

// POST /api/labels/:id/apply - Apply label to messages
exports.applyLabelToMessages = async (req, res) => {
  try {
    const { id: labelId } = req.params;
    const { messageIds, threadIds } = req.body;
    const userId = req.employee?._id;
    const owner = req.employee?.owner;

    if (!isValidObjectId(labelId)) {
      return res.status(400).json({ error: "Invalid label ID" });
    }

    // Verify label exists and belongs to current employee
    const label = await EmailLabel.findOne({
      _id: labelId,
      employee: userId,
    });

    if (!label) {
      return res.status(404).json({ error: "Label not found or you don't have access" });
    }

    let messagesToUpdate = [];

    // Handle thread-based labeling
    if (threadIds && Array.isArray(threadIds) && threadIds.length > 0) {
      // Find all messages in the specified threads that the user has access to
      messagesToUpdate = await AssignmentMessage.find({
        threadId: { $in: threadIds },
        owner, // Messages must belong to the same owner
        $or: [
          { sender: userId },
          { receiver: userId },
          { receiver: { $in: [userId] } },
        ],
      }).lean();
    }
    // Handle individual message labeling
    else if (messageIds && Array.isArray(messageIds) && messageIds.length > 0) {
      messagesToUpdate = await AssignmentMessage.find({
        _id: { $in: messageIds },
        owner, // Messages must belong to the same owner
        $or: [
          { sender: userId },
          { receiver: userId },
          { receiver: { $in: [userId] } },
        ],
      }).lean();
    } else {
      return res
        .status(400)
        .json({ error: "No messages or threads specified" });
    }

    if (messagesToUpdate.length === 0) {
      return res.status(404).json({ error: "No accessible messages found" });
    }

    const updateOperations = [];
    const updatedMessageIds = [];

    for (const message of messagesToUpdate) {
      // Check if label is already applied
      const hasLabel = message.labels?.some(
        (labelItem) => labelItem.label?.toString() === labelId
      );

      if (!hasLabel) {
        updateOperations.push(
          AssignmentMessage.findByIdAndUpdate(
            message._id,
            {
              $push: {
                labels: {
                  label: labelId,
                  appliedAt: new Date(),
                  appliedBy: userId,
                },
              },
            },
            { new: true }
          )
        );
        updatedMessageIds.push(message._id);
      }
    }

    if (updateOperations.length === 0) {
      return res.status(200).json({
        success: true,
        message: "Label already applied to all selected messages",
        count: 0,
      });
    }

    // Execute all updates
    const results = await Promise.all(updateOperations);

    // Update label message count - count messages with this label that belong to the owner
    const newMessageCount = await AssignmentMessage.countDocuments({
      "labels.label": labelId,
      owner,
    });

    // Update label's message count
    await EmailLabel.findByIdAndUpdate(labelId, {
      messageCount: newMessageCount,
    });

    // Emit socket events for real-time updates
    if (req.socket) {
      results.forEach((message) => {
        req.socket.emit("message_labeled", {
          messageId: message._id,
          labelId: labelId,
          action: "applied",
        });
      });
    }

    res.json({
      success: true,
      message: `Label "${label.name}" applied to ${updateOperations.length} message(s)`,
      count: updateOperations.length,
      appliedToThreads: threadIds || [],
      appliedToMessages: updatedMessageIds,
    });
  } catch (error) {
    console.error("❌ Error applying label:", error);
    res.status(500).json({ error: "Failed to apply label to messages" });
  }
};

// POST /api/labels/:id/remove - Remove label from messages
exports.removeLabelFromMessages = async (req, res) => {
  try {
    const { id: labelId } = req.params;
    const { messageIds, threadIds } = req.body;
    const userId = req.employee?._id;
    const owner = req.employee?.owner;

    if (!isValidObjectId(labelId)) {
      return res.status(400).json({ error: "Invalid label ID" });
    }

    // Verify label exists and belongs to current employee
    const label = await EmailLabel.findOne({
      _id: labelId,
      employee: userId,
    });

    if (!label) {
      return res.status(404).json({ error: "Label not found" });
    }

    let messagesToUpdate = [];

    // Handle thread-based removal
    if (threadIds && Array.isArray(threadIds) && threadIds.length > 0) {
      messagesToUpdate = await AssignmentMessage.find({
        threadId: { $in: threadIds },
        owner,
        "labels.label": labelId,
        $or: [
          { sender: userId },
          { receiver: userId },
          { receiver: { $in: [userId] } },
        ],
      });
    }
    // Handle individual message removal
    else if (messageIds && Array.isArray(messageIds) && messageIds.length > 0) {
      messagesToUpdate = await AssignmentMessage.find({
        _id: { $in: messageIds },
        owner,
        "labels.label": labelId,
        $or: [
          { sender: userId },
          { receiver: userId },
          { receiver: { $in: [userId] } },
        ],
      });
    } else {
      return res
        .status(400)
        .json({ error: "No messages or threads specified" });
    }

    if (messagesToUpdate.length === 0) {
      return res
        .status(404)
        .json({ error: "No accessible messages with this label found" });
    }

    const updateOperations = messagesToUpdate.map((message) =>
      AssignmentMessage.findByIdAndUpdate(message._id, {
        $pull: {
          labels: { label: labelId },
        },
      })
    );

    await Promise.all(updateOperations);

    // Update label message count
    const newMessageCount = await AssignmentMessage.countDocuments({
      "labels.label": labelId,
      owner,
    });

    // Update label's message count
    await EmailLabel.findByIdAndUpdate(labelId, {
      messageCount: newMessageCount,
    });

    res.json({
      success: true,
      message: `Label "${label.name}" removed from ${updateOperations.length} message(s)`,
      count: updateOperations.length,
    });
  } catch (error) {
    console.error("❌ Error removing label:", error);
    res.status(500).json({ error: "Failed to remove label from messages" });
  }
};

// GET /api/labels/:id/messages - Get messages with specific label
exports.getMessagesByLabel = async (req, res) => {
  try {
    const { id: labelId } = req.params;
    const { page = 1, limit = 50, filter = "all" } = req.query;
    const userId = req.employee?._id;
    const owner = req.employee?.owner;

    if (!isValidObjectId(labelId)) {
      return res.status(400).json({ error: "Invalid label ID" });
    }

    // Verify label exists and employee has access
    const label = await EmailLabel.findOne({
      _id: labelId,
      employee: userId,
    }).lean();

    if (!label) {
      return res.status(404).json({ error: "Label not found or you don't have access" });
    }

    // Build query for messages with this label
    const query = {
      owner,
      "labels.label": labelId,
      $or: [
        { sender: userId },
        { receiver: userId },
        { receiver: { $in: [userId] } },
      ],
      isTrashed: false,
      isSpam: false,
    };

    // Apply filter
    if (filter === "unread") {
      query["readBy.employee"] = { $ne: userId };
    } else if (filter === "starred") {
      query.starredBy = userId;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (pageNum - 1) * lim;

    // Get total count
    const total = await AssignmentMessage.countDocuments(query);

    // Get messages
    const messages = await AssignmentMessage.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .populate([
        { path: "owner", select: "_id name companyEmail" },
        { path: "sender", select: "_id name companyEmail role" },
        { path: "receiver", select: "_id name companyEmail role" },
        { path: "client", select: "_id clientName" },
        { path: "attachments.uploadedBy", select: "_id name companyEmail" },
        { path: "labels.label", select: "_id name color textColor" },
      ])
      .lean();

    // Group messages by thread
    const threadMap = new Map();

    messages.forEach((msg) => {
      const threadId = msg.threadId || `thread_${msg._id}`;
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, {
          threadId,
          messages: [msg],
          latestMessage: msg,
          totalMessages: 1,
          unreadCount: msg.readBy?.some(
            (r) => r.employee.toString() === userId.toString()
          )
            ? 0
            : 1,
          lastActivity: msg.createdAt,
          subject: msg.subject || "No Subject",
          clientId: msg.client?._id || null,
          clientName: msg.client?.clientName || "Direct Message",
          isStarred: msg.starredBy?.includes(userId) || false,
        });
      } else {
        const thread = threadMap.get(threadId);
        thread.totalMessages++;
        thread.messages.push(msg);
        if (
          !msg.readBy?.some((r) => r.employee.toString() === userId.toString())
        ) {
          thread.unreadCount++;
        }
        if (new Date(msg.createdAt) > new Date(thread.lastActivity)) {
          thread.latestMessage = msg;
          thread.lastActivity = msg.createdAt;
        }
        thread.isStarred = thread.isStarred || msg.starredBy?.includes(userId);
      }
    });

    const threads = Array.from(threadMap.values());

    res.json({
      success: true,
      label: {
        id: label._id,
        name: label.name,
        color: label.color,
        textColor: label.textColor,
        messageCount: label.messageCount,
      },
      threads,
      pagination: {
        page: pageNum,
        limit: lim,
        total,
        pages: Math.ceil(total / lim),
      },
    });
  } catch (error) {
    console.error("❌ Error fetching messages by label:", error);
    res.status(500).json({ error: "Failed to fetch messages with label" });
  }
};

// PATCH /api/labels/reorder - Reorder labels
exports.reorderLabels = async (req, res) => {
  try {
    const { labels } = req.body; // Array of { id, order }
    const employeeId = req.employee?._id;

    if (!Array.isArray(labels) || labels.length === 0) {
      return res.status(400).json({ error: "Labels array is required" });
    }

    // Validate all IDs belong to the employee
    const labelIds = labels.map((l) => l.id);
    const userLabels = await EmailLabel.find({
      _id: { $in: labelIds },
      employee: employeeId,
    });

    if (userLabels.length !== labels.length) {
      return res
        .status(403)
        .json({ error: "Some labels do not belong to you" });
    }

    // Update orders
    const updateOperations = labels.map(({ id, order }) =>
      EmailLabel.findByIdAndUpdate(id, { order }, { new: true })
    );

    await Promise.all(updateOperations);

    res.json({
      success: true,
      message: "Labels reordered successfully",
    });
  } catch (error) {
    console.error("❌ Error reordering labels:", error);
    res.status(500).json({ error: "Failed to reorder labels" });
  }
};

// GET /api/labels/:id/count - Get label statistics
exports.getLabelStatistics = async (req, res) => {
  try {
    const { id: labelId } = req.params;
    const employeeId = req.employee?._id;
    const owner = req.employee?.owner;

    if (!isValidObjectId(labelId)) {
      return res.status(400).json({ error: "Invalid label ID" });
    }

    // Get label info and verify ownership
    const label = await EmailLabel.findOne({
      _id: labelId,
      employee: employeeId,
    }).lean();
    
    if (!label) {
      return res.status(404).json({ error: "Label not found or you don't have access" });
    }

    // Get statistics
    const [totalMessages, unreadMessages, starredMessages] = await Promise.all([
      AssignmentMessage.countDocuments({
        owner,
        "labels.label": labelId,
        $or: [
          { sender: employeeId },
          { receiver: employeeId },
          { receiver: { $in: [employeeId] } },
        ],
        isTrashed: false,
        isSpam: false,
      }),
      AssignmentMessage.countDocuments({
        owner,
        "labels.label": labelId,
        $or: [
          { sender: employeeId },
          { receiver: employeeId },
          { receiver: { $in: [employeeId] } },
        ],
        "readBy.employee": { $ne: employeeId },
        isTrashed: false,
        isSpam: false,
      }),
      AssignmentMessage.countDocuments({
        owner,
        "labels.label": labelId,
        $or: [
          { sender: employeeId },
          { receiver: employeeId },
          { receiver: { $in: [employeeId] } },
        ],
        starredBy: employeeId,
        isTrashed: false,
        isSpam: false,
      }),
    ]);

    res.json({
      success: true,
      statistics: {
        totalMessages,
        unreadMessages,
        starredMessages,
        lastUpdated: new Date(),
      },
    });
  } catch (error) {
    console.error("❌ Error getting label statistics:", error);
    res.status(500).json({ error: "Failed to get label statistics" });
  }
};