// backend/src/middleware/attendanceAuth.js
const jwt = require("jsonwebtoken");
const User = require("../models/Users");
const Employee = require("../models/Employees");
const AttendanceAccess = require("../models/AttendanceAccess");

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * attendanceAuth
 * Allows ONLY employees with delegated AttendanceAccess
 * Admin/HR users are blocked and shown "oops we didn't find anything"
 */
module.exports = async function attendanceAuth(req, res, next) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
        ? authHeader.substring(7)
        : null;

    if (!token) {
        return res.status(404).json({ message: "oops we didn't find anything" });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        const userId = payload.id || payload._id;

        if (!userId) {
            return res.status(404).json({ message: "oops we didn't find anything" });
        }

        // ─── 1. CHECK ADMIN/HR USER ──────────────────────────────────────────
        const user = await User.findById(userId).select(
            "_id role owner createdBy tokenVersion name email companyEmail"
        );

        if (user) {
            // Admin/HR users are blocked - only employees with access can view
            return res.status(404).json({ message: "oops we didn't find anything" });
        }

        // ─── 2. CHECK EMPLOYEE WITH DELEGATION ───────────────────────────────
        const employee = await Employee.findById(userId).select(
            "_id role owner name companyEmail"
        );

        if (employee) {
            const grant = await AttendanceAccess.findOne({
                owner: employee.owner,
                grantedTo: employee._id,
                active: true,
            });

            if (!grant) {
                return res.status(404).json({ message: "oops we didn't find anything" });
            }

            // Check if method requires 'edit' access
            if (
                ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) &&
                grant.accessType === "view"
            ) {
                return res.status(404).json({ message: "oops we didn't find anything" });
            }

            // Allow access
            req.user = {
                _id: employee.owner, // Use owner ID so controllers fetch company data
                employeeId: employee._id,
                owner: employee.owner,
                role: "delegated-employee",
                isAdmin: false,
                isDelegated: true,
                accessType: grant.accessType,
                attendanceScope: grant.scope || [], // [] = ALL
            };
            return next();
        }

        return res.status(404).json({ message: "oops we didn't find anything" });
    } catch (err) {
        console.error("🔐 [AttendanceAuth] Error:", err.message);
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ message: "Token expired." });
        }
        return res.status(401).json({ message: "Invalid token." });
    }
};
