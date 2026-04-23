const jwt = require("jsonwebtoken");
const User = require("../models/Users");
const Employee = require("../models/Employees");
const PayrollAccess = require("../models/PayrollAccess");

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * anyPayrollAuth
 * Allows both Admin/HR users AND Employees with delegated PayrollAccess.
 */
module.exports = async function anyPayrollAuth(req, res, next) {
    const authHeader = req.headers.authorization || "";
    let token = authHeader.startsWith("Bearer ")
        ? authHeader.substring(7)
        : null;

    if (!token || token === "undefined" || token === "null") {
        return res.status(401).json({ message: "No valid token provided" });
    }

    try {
        const JWT_SECRET = process.env.JWT_SECRET;
        if (!JWT_SECRET) {
            console.error("❌ [AnyPayrollAuth] JWT_SECRET is not defined in environment variables");
            return res.status(500).json({ message: "Server configuration error" });
        }

        const payload = jwt.verify(token, JWT_SECRET);
        // Compatibility: handle both id and _id in payload
        const userId = payload.id || payload._id || payload.userId;
        if (!userId) {
            console.error("[AnyPayrollAuth] No user ID found in token payload");
            return res.status(401).json({ message: "Invalid token: No user ID" });
        }

        // 1. Check if it's an Admin/HR User
        const user = await User.findById(userId).select(
            "_id role owner createdBy tokenVersion name email companyEmail"
        );

        if (user) {
            // Standard admin auth logic
            const effectiveOwner = user.owner || user.createdBy || user._id;
            const finalOwnerId = Array.isArray(effectiveOwner) ? effectiveOwner[0] : effectiveOwner;

            req.user = {
                _id: finalOwnerId,
                role: user.role,
                owner: finalOwnerId,
                isAdmin: true,
                isEmployee: false
            };
            return next();
        }

        // 2. Check if it's an Employee
        const employee = await Employee.findById(userId).select(
            "_id role owner name companyEmail"
        );

        if (employee) {
            // Fix: Handle owner as array if necessary
            const finalOwner = Array.isArray(employee.owner) ? employee.owner[0] : employee.owner;
            if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
                // GET requests are allowed for all employees - they're just viewing attendance/payroll config
                req.user = {
                    _id: finalOwner,
                    employeeId: employee._id,
                    owner: finalOwner,
                    role: "employee",
                    isAdmin: false,
                    isEmployee: true,
                    isDelegated: false,
                    isPayrollDelegated: false,
                    accessType: "view", // Read-only for non-delegated employees
                    payrollScope: [],
                };
                return next();
            }

            // For write operations (POST, PATCH, PUT, DELETE), check PayrollAccess
            const grant = await PayrollAccess.findOne({
                owner: finalOwner,
                grantedTo: employee._id,
                active: true,
            });

            if (!grant) {
                console.warn(`[AnyPayrollAuth] No active PayrollAccess grant found for employee: ${employee._id}`);
                // 🔥 CRITICAL FIX: Allow write operations if user is HR/Admin-delegated without PayrollAccess
                // Check if employee has HR role - they might have direct permissions
                if (employee.role && (employee.role.toLowerCase().includes("hr") || employee.role.toLowerCase().includes("admin"))) {
                    req.user = {
                        _id: finalOwner,
                        employeeId: employee._id,
                        owner: finalOwner,
                        role: employee.role,
                        isAdmin: true,
                        isEmployee: true,
                        isDelegated: false,
                        isPayrollDelegated: false,
                        accessType: "edit",
                        payrollScope: [],
                    };
                    return next();
                }
                return res.status(403).json({ message: "No payroll access granted" });
            }

            // Check if method requires 'edit' access
            if (
                ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) &&
                grant.accessType === "view"
            ) {
                console.warn(`[AnyPayrollAuth] Insufficient permissions: ${req.method} requested but grant is view-only`);
                return res.status(403).json({ message: "Insufficient permissions (View Only)" });
            }

            // Allow access as a delegated employee
            req.user = {
                _id: finalOwner, // Crucial for controllers to use this as company ID
                employeeId: employee._id,
                owner: finalOwner,
                role: "delegated-employee",
                isAdmin: false,
                isEmployee: true,
                isDelegated: true,
                isPayrollDelegated: true,
                accessType: grant.accessType,
                payrollScope: grant.scope || [], // [] = ALL
            };
            return next();
        }

        console.error(`[AnyPayrollAuth] Subject ID ${userId} not found in User or Employee collections`);
        return res.status(401).json({ message: "User not found" });
    } catch (err) {
        console.error("🔐 [AnyPayrollAuth] Error:", err.name, err.message);
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ message: "Token expired.", expiredAt: err.expiredAt });
        }
        return res.status(401).json({ 
            message: "Invalid or expired token.",
            error: err.name === "JsonWebTokenError" ? "malformed" : "error"
        });
    }
};
