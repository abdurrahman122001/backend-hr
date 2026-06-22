// backend/src/middleware/crmAuth.js
const jwt = require("jsonwebtoken");
const User = require("../models/Users");
const Employee = require("../models/Employees");
const { hasCrmAccess, isRootManager } = require("../utils/crmAccess");

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * crmAuth
 * Allows ONLY employees who have CRM access (an active CRMAccess grant OR
 * the rootManager). Admin/HR users and employees without access are blocked
 * with "oops we didn't find anything".
 *
 * Follows the same pattern as payrollAuth / attendanceAuth.
 */
module.exports = async function crmAuth(req, res, next) {
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

        // Admin/HR users do not use the CRM app — block.
        const user = await User.findById(userId).select("_id role owner");
        if (user) {
            return res.status(404).json({ message: "oops we didn't find anything" });
        }

        const employee = await Employee.findById(userId).select(
            "_id role owner name companyEmail department"
        );
        if (!employee) {
            return res.status(404).json({ message: "oops we didn't find anything" });
        }

        const allowed = await hasCrmAccess(employee);
        if (!allowed) {
            return res.status(404).json({ message: "oops we didn't find anything" });
        }

        const rootManager = await isRootManager(employee.owner, employee._id);

        req.employee = {
            _id: employee._id,
            role: employee.role,
            owner: employee.owner,
            name: employee.name,
            companyEmail: employee.companyEmail,
            department: employee.department,
        };
        req.crm = { isRootManager: rootManager };
        return next();
    } catch (err) {
        console.error("🔐 [CrmAuth] Error:", err.message);
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ message: "Token expired." });
        }
        return res.status(401).json({ message: "Invalid token." });
    }
};
