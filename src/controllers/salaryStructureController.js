const SalaryStructure = require("../models/SalaryStructure");

// Helper function to get effective owner ID
function getEffectiveOwnerId(user) {
    if (user.role === "admin" && user.createdBy) {
        return user.createdBy;
    }
    return user._id;
}

/**
 * Get all salary structures for the owner
 */
exports.getAllStructures = async (req, res) => {
    try {
        const ownerId = getEffectiveOwnerId(req.user);

        const structures = await SalaryStructure.find({ owner: ownerId })
            .sort({ isDefault: -1, createdAt: -1 })
            .lean();

        res.json({
            status: "success",
            data: structures,
        });
    } catch (err) {
        console.error("Error fetching salary structures:", err);
        res.status(500).json({
            status: "error",
            message: err.message,
        });
    }
};

/**
 * Get default salary structure
 */
exports.getDefaultStructure = async (req, res) => {
    try {
        const ownerId = getEffectiveOwnerId(req.user);

        let structure = await SalaryStructure.findOne({
            owner: ownerId,
            isDefault: true,
            isActive: true,
        }).lean();

        // If no default, get the first active one
        if (!structure) {
            structure = await SalaryStructure.findOne({
                owner: ownerId,
                isActive: true,
            })
                .sort({ createdAt: -1 })
                .lean();
        }

        // If still no structure, create a default one
        if (!structure) {
            structure = await SalaryStructure.create({
                owner: ownerId,
                name: "Default Salary Structure",
                isDefault: true,
                basicPercentage: 50,
                houseRentAllowancePercentage: 20,
                medicalAllowancePercentage: 10,
                conveyanceAllowancePercentage: 10,
                utilityAllowancePercentage: 10,
            });
        }

        res.json({
            status: "success",
            data: structure,
        });
    } catch (err) {
        console.error("Error fetching default salary structure:", err);
        res.status(500).json({
            status: "error",
            message: err.message,
        });
    }
};

/**
 * Get single salary structure by ID
 */
exports.getStructureById = async (req, res) => {
    try {
        const { id } = req.params;
        const ownerId = getEffectiveOwnerId(req.user);

        const structure = await SalaryStructure.findOne({
            _id: id,
            owner: ownerId,
        }).lean();

        if (!structure) {
            return res.status(404).json({
                status: "error",
                message: "Salary structure not found",
            });
        }

        res.json({
            status: "success",
            data: structure,
        });
    } catch (err) {
        console.error("Error fetching salary structure:", err);
        res.status(500).json({
            status: "error",
            message: err.message,
        });
    }
};

/**
 * Create or update salary structure
 */
exports.upsertStructure = async (req, res) => {
    try {
        const ownerId = getEffectiveOwnerId(req.user);
        const { id, ...structureData } = req.body;

        // Validate that percentages don't exceed 100%
        const percentageFields = [
            "basicPercentage",
            "dearnessAllowancePercentage",
            "houseRentAllowancePercentage",
            "conveyanceAllowancePercentage",
            "medicalAllowancePercentage",
            "utilityAllowancePercentage",
            "overtimeCompensationPercentage",
            "dislocationAllowancePercentage",
            "leaveEncashmentPercentage",
            "bonusPercentage",
            "arrearsPercentage",
            "autoAllowancePercentage",
            "incentivePercentage",
            "fuelAllowancePercentage",
            "othersAllowancesPercentage",
        ];

        let totalPercentage = 0;
        percentageFields.forEach((field) => {
            const value = parseFloat(structureData[field]) || 0;
            totalPercentage += value;
        });

        if (totalPercentage > 100) {
            return res.status(400).json({
                status: "error",
                message: `Total percentage cannot exceed 100%. Current total: ${totalPercentage.toFixed(2)}%`,
            });
        }

        // If setting as default, unset other defaults
        if (structureData.isDefault === true) {
            await SalaryStructure.updateMany(
                { owner: ownerId },
                { $set: { isDefault: false } }
            );
        }

        let structure;
        if (id) {
            // Update existing
            structure = await SalaryStructure.findOneAndUpdate(
                { _id: id, owner: ownerId },
                { $set: { ...structureData, owner: ownerId } },
                { new: true, runValidators: true }
            );

            if (!structure) {
                return res.status(404).json({
                    status: "error",
                    message: "Salary structure not found",
                });
            }
        } else {
            // Create new
            structure = await SalaryStructure.create({
                ...structureData,
                owner: ownerId,
            });
        }

        res.json({
            status: "success",
            message: id ? "Salary structure updated successfully" : "Salary structure created successfully",
            data: structure,
        });
    } catch (err) {
        console.error("Error upserting salary structure:", err);
        res.status(500).json({
            status: "error",
            message: err.message,
        });
    }
};

/**
 * Delete salary structure
 */
exports.deleteStructure = async (req, res) => {
    try {
        const { id } = req.params;
        const ownerId = getEffectiveOwnerId(req.user);

        const structure = await SalaryStructure.findOneAndDelete({
            _id: id,
            owner: ownerId,
        });

        if (!structure) {
            return res.status(404).json({
                status: "error",
                message: "Salary structure not found",
            });
        }

        res.json({
            status: "success",
            message: "Salary structure deleted successfully",
        });
    } catch (err) {
        console.error("Error deleting salary structure:", err);
        res.status(500).json({
            status: "error",
            message: err.message,
        });
    }
};

/**
 * Calculate salary breakdown from gross salary
 */
exports.calculateBreakdown = async (req, res) => {
    try {
        const { grossSalary, structureId } = req.body;
        const ownerId = getEffectiveOwnerId(req.user);

        if (!grossSalary || isNaN(grossSalary)) {
            return res.status(400).json({
                status: "error",
                message: "Valid gross salary is required",
            });
        }

        let structure;
        if (structureId) {
            structure = await SalaryStructure.findOne({
                _id: structureId,
                owner: ownerId,
            });
        } else {
            // Get default structure
            structure = await SalaryStructure.findOne({
                owner: ownerId,
                isDefault: true,
                isActive: true,
            });

            if (!structure) {
                structure = await SalaryStructure.findOne({
                    owner: ownerId,
                    isActive: true,
                }).sort({ createdAt: -1 });
            }
        }

        if (!structure) {
            return res.status(404).json({
                status: "error",
                message: "No active salary structure found",
            });
        }

        const breakdown = structure.calculateBreakdown(grossSalary);

        res.json({
            status: "success",
            data: {
                structure: {
                    id: structure._id,
                    name: structure.name,
                },
                breakdown,
            },
        });
    } catch (err) {
        console.error("Error calculating breakdown:", err);
        res.status(500).json({
            status: "error",
            message: err.message,
        });
    }
};
