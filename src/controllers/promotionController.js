const Employee = require("../models/Employees");
const Salaries = require("../models/Salaries");
const SalaryStructure = require("../models/SalaryStructure");
const { decrypt, encrypt } = require("../utils/encryption");

// Helper function to get effective owner ID
function getEffectiveOwnerId(user) {
    if (user.role === "admin" && user.createdBy) {
        return user.createdBy;
    }
    return user._id;
}

// Helper to safely parse numbers
const toNum = (v) => {
    if (v === null || v === undefined) return 0;
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    const n = Number(String(v).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
};

// Helper to decrypt salary value
const decryptValue = async (encryptedValue) => {
    if (!encryptedValue || encryptedValue === "") return 0;
    try {
        const decrypted = await decrypt(encryptedValue);
        return toNum(decrypted);
    } catch (err) {
        console.error("Decryption error:", err);
        return 0;
    }
};

// Helper to encrypt salary value
const encryptValue = async (value) => {
    try {
        const encrypted = await encrypt(String(Math.round(value)));
        return encrypted;
    } catch (err) {
        console.error("Encryption error:", err);
        return "";
    }
};

/**
 * Get all employees for promotion selection
 */
exports.getAllEmployeesForPromotion = async (req, res) => {
    try {
        const ownerId = getEffectiveOwnerId(req.user);

        const employees = await Employee.find({
            owner: { $in: [ownerId] },
            status: "active",
            isTrashed: false,
        })
            .select("_id name email designation department joiningDate")
            .sort({ name: 1 })
            .lean();

        res.json({
            status: "success",
            data: employees,
        });
    } catch (err) {
        console.error("Error fetching employees for promotion:", err);
        res.status(500).json({
            status: "error",
            message: err.message,
        });
    }
};

/**
 * Get employee current salary details
 */
exports.getEmployeeSalaryDetails = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const ownerId = req.user.owner || getEffectiveOwnerId(req.user);

        const employee = await Employee.findOne({
            _id: employeeId,
            owner: { $in: [ownerId] },
        })
            .select("_id name email designation department compensation")
            .lean();

        if (!employee) {
            return res.status(404).json({
                status: "error",
                message: "Employee not found",
            });
        }

        const salary = await Salaries.findOne({
            employee: employeeId,
            owner: ownerId,
        }).lean();

        if (!salary) {
            return res.json({
                status: "success",
                data: {
                    employee,
                    salary: null,
                },
            });
        }

        // Decrypt salary fields
        const salaryFields = [
            "basic",
            "dearnessAllowance",
            "houseRentAllowance",
            "conveyanceAllowance",
            "medicalAllowance",
            "utilityAllowance",
            "overtimeCompensation",
            "dislocationAllowance",
            "leaveEncashment",
            "bonus",
            "arrears",
            "autoAllowance",
            "incentive",
            "fuelAllowance",
            "othersAllowances",
            "grossSalary",
        ];

        const decryptedSalary = { ...salary };
        for (const field of salaryFields) {
            if (salary[field]) {
                decryptedSalary[field] = await decryptValue(salary[field]);
            } else {
                decryptedSalary[field] = 0;
            }
        }

        res.json({
            status: "success",
            data: {
                employee,
                salary: decryptedSalary,
            },
        });
    } catch (err) {
        console.error("Error fetching employee salary details:", err);
        res.status(500).json({
            status: "error",
            message: err.message,
        });
    }
};

/**
 * Process employee promotion
 */
exports.promoteEmployee = async (req, res) => {
    try {
        const { employeeId, newDesignation, incrementPercentage } = req.body;
        const ownerId = req.user.owner || getEffectiveOwnerId(req.user);

        // Validate input
        if (!employeeId || !newDesignation || incrementPercentage === undefined) {
            return res.status(400).json({
                status: "error",
                message: "employeeId, newDesignation, and incrementPercentage are required for promotion.",
            });
        }

        const increment = parseFloat(incrementPercentage);
        if (isNaN(increment) || increment < 0) {
            return res.status(400).json({
                status: "error",
                message: "Invalid increment percentage. Must be a non-negative number.",
            });
        }

        // Find employee
        const employee = await Employee.findOne({
            _id: employeeId,
            owner: { $in: [ownerId] },
        });

        if (!employee) {
            return res.status(404).json({
                status: "error",
                message: `Employee not found with ID: ${employeeId}`,
            });
        }

        // Find and update salary record (persistent slip-like data)
        let salary = await Salaries.findOne({
            employee: employeeId,
            owner: ownerId,
        });

        // Get current gross salary from either Salaries record or Employee compensation fallback
        let currentGross = 0;
        if (salary && salary.grossSalary) {
            currentGross = await decryptValue(salary.grossSalary);
        } else if (employee.compensation && employee.compensation.grossSalary) {
            currentGross = toNum(employee.compensation.grossSalary);
        }

        if (currentGross === 0) {
            return res.status(400).json({
                status: "error",
                message: "Current gross salary is zero or not set for this employee. Please configure salary details first.",
            });
        }

        // If salary record doesn't exist, create one now (we need a record to store encrypted components)
        if (!salary) {
            salary = new Salaries({
                employee: employeeId,
                owner: ownerId,
                month: (new Date().getMonth() + 1).toString(),
                year: new Date().getFullYear().toString(),
            });
        }

        // Calculate new gross salary with increment
        const incrementMultiplier = 1 + increment / 100;
        const newGrossSalary = Math.round(currentGross * incrementMultiplier);

        // Get salary structure to redistribute the new gross
        let salaryStructure = await SalaryStructure.findOne({
            owner: ownerId,
            isDefault: true,
            isActive: true,
        });

        // Fallback to any active structure if no default is marked
        if (!salaryStructure) {
            salaryStructure = await SalaryStructure.findOne({
                owner: ownerId,
                isActive: true,
            }).sort({ createdAt: -1 });
        }

        if (!salaryStructure) {
            return res.status(404).json({
                status: "error",
                message: "No active salary structure found. Please configure a salary structure in Settings first.",
            });
        }

        // Use salary structure to calculate breakdown of new gross salary
        const breakdown = salaryStructure.calculateBreakdown(newGrossSalary);

        // Map of field names (structure uses different naming)
        const fieldMapping = {
            basic: "basic",
            dearnessAllowance: "dearnessAllowance",
            houseRentAllowance: "houseRentAllowance",
            conveyanceAllowance: "conveyanceAllowance",
            medicalAllowance: "medicalAllowance",
            utilityAllowance: "utilityAllowance",
            overtimeCompensation: "overtimeCompensation",
            dislocationAllowance: "dislocationAllowance",
            leaveEncashment: "leaveEncashment",
            bonus: "bonus",
            arrears: "arrears",
            autoAllowance: "autoAllowance",
            incentive: "incentive",
            fuelAllowance: "fuelAllowance",
            othersAllowances: "othersAllowances",
        };

        // Prepare compensation update for Employee model
        const employeeSet = {
            designation: newDesignation,
            "compensation.grossSalary": newGrossSalary
        };

        // Update salary fields with encrypted breakdown values
        for (const [field, value] of Object.entries(breakdown)) {
            if (field !== "grossSalary" && fieldMapping[field]) {
                const numericValue = value > 0 ? value : 0;

                // Update Salaries model (encrypted)
                salary[fieldMapping[field]] = await encryptValue(numericValue);

                // Update Employee model (raw number if tracked there)
                employeeSet[`compensation.${fieldMapping[field]}`] = numericValue;
            }
        }

        // Update gross salary in Salaries model
        salary.grossSalary = await encryptValue(newGrossSalary);

        // Save updated salary
        await salary.save();

        // Update employee (designation and compensation)
        await Employee.findByIdAndUpdate(employeeId, { $set: employeeSet });

        console.log(`✅ Employee ${employee.name} promoted successfully. New Gross: ${newGrossSalary}`);

        res.json({
            status: "success",
            message: `Employee ${employee.name} promoted to ${newDesignation} with ${increment}% increment (₨${currentGross.toLocaleString()} → ₨${newGrossSalary.toLocaleString()})`,
            data: {
                employeeId: employee._id,
                name: employee.name,
                newDesignation: newDesignation,
                incrementPercentage: increment,
                oldGrossSalary: currentGross,
                newGrossSalary: newGrossSalary,
                salaryStructureUsed: salaryStructure.name,
            },
        });
    } catch (err) {
        console.error("Error promoting employee:", err);
        res.status(500).json({
            status: "error",
            message: err.message,
        });
    }
};

/**
 * Bulk promote employees
 */
exports.bulkPromoteEmployees = async (req, res) => {
    try {
        const { promotions } = req.body;
        const ownerId = req.user.owner || getEffectiveOwnerId(req.user);

        if (!Array.isArray(promotions) || promotions.length === 0) {
            return res.status(400).json({
                status: "error",
                message: "Promotions array is required and cannot be empty.",
            });
        }

        // Get default salary structure for the owner
        let salaryStructure = await SalaryStructure.findOne({
            owner: ownerId,
            isDefault: true,
            isActive: true,
        });

        // Fallback if no default is marked
        if (!salaryStructure) {
            salaryStructure = await SalaryStructure.findOne({
                owner: ownerId,
                isActive: true,
            }).sort({ createdAt: -1 });
        }

        if (!salaryStructure) {
            return res.status(404).json({
                status: "error",
                message: "No active salary structure found. Please configure a salary structure in Settings before bulk promoting.",
            });
        }

        const fieldMapping = {
            basic: "basic",
            dearnessAllowance: "dearnessAllowance",
            houseRentAllowance: "houseRentAllowance",
            conveyanceAllowance: "conveyanceAllowance",
            medicalAllowance: "medicalAllowance",
            utilityAllowance: "utilityAllowance",
            overtimeCompensation: "overtimeCompensation",
            dislocationAllowance: "dislocationAllowance",
            leaveEncashment: "leaveEncashment",
            bonus: "bonus",
            arrears: "arrears",
            autoAllowance: "autoAllowance",
            incentive: "incentive",
            fuelAllowance: "fuelAllowance",
            othersAllowances: "othersAllowances",
        };

        const results = {
            success: [],
            failed: [],
        };

        for (const promo of promotions) {
            try {
                const { employeeId, newDesignation, incrementPercentage } = promo;

                if (!employeeId || !newDesignation || incrementPercentage === undefined) {
                    results.failed.push({
                        employeeId,
                        reason: "Missing required fields (employeeId, newDesignation, incrementPercentage)",
                    });
                    continue;
                }

                const increment = parseFloat(incrementPercentage);
                if (isNaN(increment) || increment < 0) {
                    results.failed.push({
                        employeeId,
                        reason: "Invalid increment percentage. Must be a non-negative number.",
                    });
                    continue;
                }

                // Find employee
                const employee = await Employee.findOne({
                    _id: employeeId,
                    owner: { $in: [ownerId] },
                });

                if (!employee) {
                    results.failed.push({
                        employeeId,
                        reason: `Employee not found with ID: ${employeeId}`,
                    });
                    continue;
                }

                // Find and update salary record (persistent slip-like data)
                let salary = await Salaries.findOne({
                    employee: employeeId,
                    owner: ownerId,
                });

                // Get current gross salary from either Salaries record or Employee compensation fallback
                let currentGross = 0;
                if (salary && salary.grossSalary) {
                    currentGross = await decryptValue(salary.grossSalary);
                } else if (employee.compensation && employee.compensation.grossSalary) {
                    currentGross = toNum(employee.compensation.grossSalary);
                }

                if (currentGross === 0) {
                    results.failed.push({
                        employeeId,
                        name: employee.name,
                        reason: "Current gross salary is zero or not set for this employee. Cannot apply increment.",
                    });
                    continue;
                }

                // If salary record doesn't exist, create one now
                if (!salary) {
                    salary = new Salaries({
                        employee: employeeId,
                        owner: ownerId,
                        month: (new Date().getMonth() + 1).toString(),
                        year: new Date().getFullYear().toString(),
                    });
                }

                // Calculate new gross salary with increment
                const incrementMultiplier = 1 + increment / 100;
                const newGrossSalary = Math.round(currentGross * incrementMultiplier);

                // Use salary structure to calculate breakdown of new gross salary
                const breakdown = salaryStructure.calculateBreakdown(newGrossSalary);

                // Prepare compensation update for Employee model
                const employeeSet = {
                    designation: newDesignation,
                    "compensation.grossSalary": newGrossSalary
                };

                // Update salary fields with encrypted breakdown values
                for (const [field, value] of Object.entries(breakdown)) {
                    if (field !== "grossSalary" && fieldMapping[field]) {
                        const numericValue = value > 0 ? value : 0;

                        // Update Salaries model (encrypted)
                        salary[fieldMapping[field]] = await encryptValue(numericValue);

                        // Update Employee model (raw number if tracked there)
                        employeeSet[`compensation.${fieldMapping[field]}`] = numericValue;
                    }
                }

                // Update gross salary
                salary.grossSalary = await encryptValue(newGrossSalary);

                // Save updated salary
                await salary.save();

                // Update employee
                await Employee.findByIdAndUpdate(employeeId, { $set: employeeSet });

                results.success.push({
                    employeeId: employee._id,
                    name: employee.name,
                    newDesignation,
                    incrementPercentage: increment,
                    oldGrossSalary: currentGross,
                    newGrossSalary: newGrossSalary,
                });
            } catch (err) {
                results.failed.push({
                    employeeId: promo.employeeId,
                    reason: err.message,
                });
            }
        }

        res.json({
            status: "success",
            message: `Bulk promotion completed. ${results.success.length} succeeded, ${results.failed.length} failed.`,
            data: results,
        });
    } catch (err) {
        console.error("Error bulk promoting employees:", err);
        res.status(500).json({
            status: "error",
            message: err.message,
        });
    }
};
