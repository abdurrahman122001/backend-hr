require("dotenv").config();
const mongoose = require("mongoose");
const Employee = require("./src/models/Employees"); // adjust path if needed

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB");

    const newEmployee = new Employee({
      _id: new mongoose.Types.ObjectId("68ac9e68a45dc85b1f1cefb5"), // fixed ID
      owner: new mongoose.Types.ObjectId("6838b0b708e8629ffab534ee"), // from your env
      name: "Abdur Rahman",
      email: "test.employee@example.com",
      companyEmail: "test.employee@company.com",
      role: "Employee",
      department: "Development",
      designation: "Software Engineer",
      phone: "+1-555-234-7890",
      photographUrl: "https://example.com/photos/test-employee.jpg",
      joiningDate: "2025-10-10",
    });

    await newEmployee.save();

    console.log("✅ Employee inserted successfully:");
    console.log(newEmployee.toJSON());
  } catch (error) {
    console.error("❌ Error inserting employee:", error.message);
  } finally {
    mongoose.connection.close();
  }
})();
