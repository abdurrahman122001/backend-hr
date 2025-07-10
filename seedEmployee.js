const mongoose = require("mongoose");
mongoose.connect("mongodb+srv://abdullahahmedqureshint:2zrm6dbPHMaVqwpL@cluster0.lcln8dt.mongodb.net/test?retryWrites=true&w=majority&appName=Cluster0"); // <-- your DB here

const employeeSchema = new mongoose.Schema({
  owner: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  // ...other fields...
});
const Employee = mongoose.model("employee", employeeSchema);

async function migrateOwnerToArray() {
  const docs = await Employee.find({ owner: { $type: "objectId" } });
  for (const doc of docs) {
    doc.owner = [doc.owner];
    await doc.save();
    console.log("Updated", doc._id);
  }
  mongoose.disconnect();
}
migrateOwnerToArray();
