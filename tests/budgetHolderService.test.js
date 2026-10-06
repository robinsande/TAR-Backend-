const xlsx = require("xlsx");
const mongoose = require("mongoose");
const BudgetHolder = require("../src/models/BudgetHolder");
const User = require("../src/models/User");
const {
  parseBudgetHolderRows,
  importBudgetHoldersFromBuffer,
  listBudgetHolders,
} = require("../src/services/budgetHolderService");
const { hashPassword } = require("../src/services/passwordService");
const { startTestDatabase, stopTestDatabase } = require("./testDatabase");

beforeAll(async () => {
  await startTestDatabase();
});

afterEach(async () => {
  await Promise.all([BudgetHolder.deleteMany({}), User.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await stopTestDatabase();
});

function workbookBuffer(rows) {
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(rows), "Budget Holders");
  return xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
}

describe("budget holder imports", () => {
  it("parses name and email columns, ignores fund-code columns, and skips duplicate emails", () => {
    expect(parseBudgetHolderRows([
      { "Budget Holder Name": "Alex Holder", "Budget Holder Email": "ALEX@example.com", "Fund Code ID": "DEC16" },
      { Name: "Alex Holder", Email: "alex@example.com", "Fund Code": "OTHER" },
    ])).toEqual([
      { name: "Alex Holder", email: "alex@example.com" },
    ]);
  });

  it("requires a valid name and email but does not require a fund code", () => {
    expect(parseBudgetHolderRows([
      { Name: "Valid Holder", Email: "holder@example.com" },
    ])).toEqual([{ name: "Valid Holder", email: "holder@example.com" }]);
    expect(() => parseBudgetHolderRows([
      { Name: "Missing Email" },
    ])).toThrow(/valid name and email/i);
  });

  it("imports active account mappings and lists holders without fund codes", async () => {
    const user = await User.create({
      name: "Alex Holder",
      email: "alex@example.com",
      role: "approver_budget_holder",
      isActive: true,
      mustSetPassword: false,
      passwordHash: await hashPassword("Password123!"),
    });
    const buffer = workbookBuffer([
      { "Budget Holder Name": "Alex Holder", "Budget Holder Email": user.email },
    ]);

    const result = await importBudgetHoldersFromBuffer(buffer);
    expect(result).toMatchObject({ received: 1, created: 1, updated: 0 });
    const holders = await listBudgetHolders();
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({
      name: "Alex Holder",
      email: user.email,
    });
    expect(holders[0]).not.toHaveProperty("fundCode");
  });

  it("makes active accounts with the combined role available without a spreadsheet import", async () => {
    const user = await User.create({
      name: "Approver and Budget Holder",
      email: "staff@example.com",
      role: "approver_budget_holder",
      isActive: true,
    });

    const holders = await listBudgetHolders();

    expect(holders).toContainEqual(expect.objectContaining({
      name: user.name,
      email: user.email,
    }));
    const directoryEntry = await BudgetHolder.findOne({ user: user._id });
    expect(directoryEntry).not.toBeNull();
  });

  it("only lists combined approver and budget holder accounts", async () => {
    const users = await User.create([
      { name: "Line Manager", email: "manager@example.com", role: "admin", isActive: true },
      { name: "Staff User", email: "staff-only@example.com", role: "user", isActive: true },
      { name: "Inactive Combined Role", email: "inactive@example.com", role: "approver_budget_holder", isActive: false },
      { name: "Superadmin", email: "superadmin@example.com", role: "superadmin", isActive: true },
      { name: "Read Only", email: "readonly@example.com", role: "super_superadmin", isActive: true },
    ]);
    await BudgetHolder.create([
      { name: "Line Manager", email: users[0].email, user: users[0]._id },
      { name: "Staff User", email: users[1].email, user: users[1]._id },
    ]);

    expect(await listBudgetHolders()).toEqual([]);
  });

  it("rejects imports for users who do not have the combined role", async () => {
    const user = await User.create({
      name: "Line Manager",
      email: "manager@example.com",
      role: "admin",
      isActive: true,
    });
    const buffer = workbookBuffer([
      { Name: user.name, Email: user.email },
    ]);

    await expect(importBudgetHoldersFromBuffer(buffer))
      .rejects.toThrow(/Approver.*Budget Holder role/);
  });

  it("does not list inactive combined role accounts", async () => {
    await User.create([
      { name: "Inactive Staff", email: "inactive@example.com", role: "approver_budget_holder", isActive: false },
    ]);

    expect(await listBudgetHolders()).toEqual([]);
  });
});
