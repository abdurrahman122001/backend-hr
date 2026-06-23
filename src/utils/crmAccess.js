// backend/src/utils/crmAccess.js
const mongoose = require('mongoose');
const CRMAccess = require('../models/CRMAccess');
const EmployeeHierarchy = require('../models/EmployeeHierarchy');

const ObjectId = mongoose.Types.ObjectId;

function toId(v) {
    if (Array.isArray(v)) v = v[0];
    if (!v) return null;
    try {
        return ObjectId.isValid(v) ? new ObjectId(v) : v;
    } catch (e) {
        return v;
    }
}

/**
 * isRootManager
 * The top of the org hierarchy = an employee who is referenced as a
 * `rootManager` in EmployeeHierarchy but never appears as a `junior`
 * (i.e. nobody is above them).
 */
async function isRootManager(ownerId, employeeId) {
    const owner = toId(ownerId);
    const empId = toId(employeeId);
    if (!owner || !empId) return false;

    // If this employee is anyone's junior, they are NOT the top.
    const hasSenior = await EmployeeHierarchy.exists({ owner, junior: empId });
    if (hasSenior) return false;

    // They must be the root of at least one chain to count as top.
    const isRoot = await EmployeeHierarchy.exists({ owner, rootManager: empId });
    return !!isRoot;
}

/**
 * hasCrmAccess
 * True if the employee has an active CRMAccess grant OR is the rootManager.
 * @param {{ _id: any, owner: any }} employee
 */
async function hasCrmAccess(employee) {
    if (!employee || !employee._id) return false;
    const owner = toId(employee.owner);
    const empId = toId(employee._id);
    if (!owner || !empId) return false;

    const grant = await CRMAccess.findOne({ owner, grantedTo: empId, active: true })
        .select('_id')
        .lean();
    if (grant) return true;

    return isRootManager(owner, empId);
}

/**
 * getCrmUserIds
 * Returns the set of employee IDs (as strings) who can act in the CRM for an
 * owner: all active CRMAccess holders PLUS the rootManager(s).
 * Replaces the old role-regex manager lookup (role: /crm|manager/i).
 */
async function getCrmUserIds(ownerId) {
    const owner = toId(ownerId);
    if (!owner) return [];

    const grants = await CRMAccess.find({ owner, active: true }).select('grantedTo').lean();
    const ids = new Set(grants.map((g) => String(g.grantedTo)));

    // Add rootManager(s): referenced as rootManager and never as junior.
    const roots = await EmployeeHierarchy.find({ owner }).distinct('rootManager');
    for (const rootId of roots) {
        const hasSenior = await EmployeeHierarchy.exists({ owner, junior: rootId });
        if (!hasSenior) ids.add(String(rootId));
    }

    return Array.from(ids);
}

module.exports = { hasCrmAccess, isRootManager, getCrmUserIds };
