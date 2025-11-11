// controllers/eventController.js
const Event = require("../models/Events");
const Employee = require("../models/Employees"); // ✅ Employee model included

// ✅ CREATE EVENT
exports.createEvent = async (req, res) => {
  try {
    const { title, description, date, time } = req.body;

    // Use req.user._id from the auth middleware
    const event = await Event.create({
      owner: req.user._id, // ✅ Changed from req.user.id to req.user._id
      title,
      description,
      date,
      time,
    });

    res.status(201).json({
      success: true,
      message: "Event created successfully",
      event,
    });
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ GET ALL EVENTS (OWNER ONLY)
exports.getAllEvents = async (req, res) => {
  try {
    const events = await Event.find({ owner: req.user._id }).sort({ date: 1 }); // ✅ Use req.user._id

    res.json({
      success: true,
      events,
    });
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ GET ONE EVENT (OWNER ONLY)
exports.getEventById = async (req, res) => {
  try {
    const event = await Event.findOne({
      _id: req.params.id,
      owner: req.user._id, // ✅ Use req.user._id
    });

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found or not owned by you",
      });
    }

    res.json({
      success: true,
      event,
    });
  } catch (error) {
    console.error('Get event by ID error:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ UPDATE EVENT (OWNER ONLY)
exports.updateEvent = async (req, res) => {
  try {
    const event = await Event.findOneAndUpdate(
      {
        _id: req.params.id,
        owner: req.user._id, // ✅ Use req.user._id
      },
      req.body,
      {
        new: true,
        runValidators: true,
      }
    );

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found or not owned by you",
      });
    }

    res.json({
      success: true,
      message: "Event updated",
      event,
    });
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ DELETE EVENT (OWNER ONLY)
exports.deleteEvent = async (req, res) => {
  try {
    const event = await Event.findOneAndDelete({
      _id: req.params.id,
      owner: req.user._id, // ✅ Use req.user._id
    });

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found or not owned by you",
      });
    }

    res.json({
      success: true,
      message: "Event deleted",
    });
  } catch (error) {
    console.error('Delete event error:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
exports.getUpcomingEventsForEmployee = async (req, res) => {
  try {
    const employeeId = req.employee._id;     
    const ownerId = req.employee.owner;

    if (!ownerId) {
      return res.status(400).json({ error: "Owner not found in employee token" });
    }

    // ✅ Fetch the logged-in employee (optional but clean)
    const employee = await Employee.findById(employeeId).select("name email owner");

    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    const today = new Date();

    const next30Days = new Date();
    next30Days.setDate(today.getDate() + 30);

    const events = await Event.find({
      owner: ownerId,
      date: { $gte: today, $lte: next30Days },
    })
      .populate("owner", "name email")
      .sort({ date: 1 });

    return res.json({
      status: "success",
      employee: {
        id: employee._id,
        name: employee.name,
        email: employee.companyEmail,
      },
      upcomingEvents: events,
    });
  } catch (err) {
    console.error("Error fetching employee events:", err);
    res.status(500).json({ error: "Server error while fetching events" });
  }
};