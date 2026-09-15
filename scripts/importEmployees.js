#!/usr/bin/env node
const path = require("path");
const env = require("../src/config/env");
const { connectDatabase, disconnectDatabase } = require("../src/config/database");
const { importEmployeesFromFile } = require("../src/services/employeeImportService");

async function run() {
  const fileArg = process.argv[2];

  if (!fileArg) {
    throw new Error("Usage: node scripts/importEmployees.js <path-to-xlsx>");
  }

  const resolvedPath = path.resolve(process.cwd(), fileArg);

  await connectDatabase(env.mongodbUri);
  const summary = await importEmployeesFromFile(resolvedPath, { sendInvites: true });
  await disconnectDatabase();

  console.log(`Imported employees from ${resolvedPath}`);
  console.log(summary);
}

if (require.main === module) {
  run().catch(async (error) => {
    console.error("Employee import failed:", error.message);
    await disconnectDatabase();
    process.exit(1);
  });
}

module.exports = {
  importEmployees: importEmployeesFromFile,
};
