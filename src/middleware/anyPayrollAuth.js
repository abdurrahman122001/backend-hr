const jwt = require("jsonwebtoken");
const User = require("../models/Users");
const Employee = require("../models/Employees");
const PayrollAccess = require("../models/PayrollAccess");
const AttendanceAccess = require("../models/AttendanceAccess");

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
            let effectiveOwner = user.owner;
            if (!effectiveOwner) {
                if (user.role === "admin") {
                    effectiveOwner = user._id;
                } else {
                    effectiveOwner = user.createdBy || user._id;
                }
            }
            const finalOwnerId = Array.isArray(effectiveOwner) ? effectiveOwner[0] : effectiveOwner;

            req.user = {
                _id: finalOwnerId,
                role: user.role,
                owner: finalOwnerId,
                isAdmin: true,
                isEmployee: false
            };
            return next();
        }        // 2. Check if it's an Employee
        const employee = await Employee.findById(userId).select(
            "_id role owner name companyEmail"
        );

        if (employee) {
            const finalOwner = Array.isArray(employee.owner) ? employee.owner[0] : employee.owner;
            
            // Allow GET for all employees (viewing basic context)
            if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
                req.user = {
                    _id: finalOwner,
                    employeeId: employee._id,
                    owner: finalOwner,
                    role: "employee",
                    isAdmin: false,
                    isEmployee: true,
                    accessType: "view",
                };
                return next();
            }

            // For write operations, check BOTH Payroll and Attendance access
            const [payrollGrant, attendanceGrant] = await Promise.all([
                PayrollAccess.findOne({ owner: finalOwner, grantedTo: employee._id, active: true }),
                AttendanceAccess.findOne({ owner: finalOwner, grantedTo: employee._id, active: true })
            ]);

            const hasPayrollEdit = payrollGrant?.accessType === "edit";
            const hasAttendanceEdit = attendanceGrant?.accessType === "edit";
            
            // If it's an attendance-related route, AttendanceAccess is sufficient
            const isAttendanceRoute = req.originalUrl.includes("attendance") || req.originalUrl.includes("non-working-days");
            
            let canEdit = false;
            if (isAttendanceRoute) {
                canEdit = hasAttendanceEdit || hasPayrollEdit;
            } else {
                canEdit = hasPayrollEdit;
            }

            if (!canEdit && ["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) {
                // If they have a grant but it's view-only
                if (payrollGrant || attendanceGrant) {
                    console.warn(`[AnyPayrollAuth] Insufficient permissions for ${employee.companyEmail} on ${req.originalUrl}`);
                    return res.status(403).json({ message: "Insufficient permissions (View Only)" });
                }
                return res.status(403).json({ message: "No delegated access granted" });
            }

            // Allow access as a delegated employee
            req.user = {
                _id: finalOwner,
                employeeId: employee._id,
                owner: finalOwner,
                role: "delegated-employee",
                isAdmin: false,
                isEmployee: true,
                isDelegated: true,
                accessType: canEdit ? "edit" : "view",
                payrollScope: payrollGrant?.scope || [],
                attendanceScope: attendanceGrant?.scope || [],
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
