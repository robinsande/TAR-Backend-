jest.mock("../src/services/emailService", () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  sendActivationEmail: jest.fn().mockResolvedValue(true),
  buildActivationEmail: jest.fn(),
}));

const fs = require("fs");
const os = require("os");
const path = require("path");
const xlsx = require("xlsx");
const mongoose = require("mongoose");
const User = require("../src/models/User");
const {
  buildUserPayload,
  deriveManagerEmails,
  importEmployeesFromFile,
} = require("../src/services/employeeImportService");
const { hashPassword } = require("../src/services/passwordService");
const { startTestDatabase, stopTestDatabase } = require("./testDatabase");

function createWorkbookFile(rows) {
  const workbook = xlsx.utils.book_new();
  const sheet = xlsx.utils.json_to_sheet(rows);
  xlsx.utils.book_append_sheet(workbook, sheet, "Employees");

  const filePath = path.join(
    os.tmpdir(),
    `employees-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`
  );
  xlsx.writeFile(workbook, filePath);
  return filePath;
}

beforeAll(async () => {
  await startTestDatabase();
});

afterEach(async () => {
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await stopTestDatabase();
});

describe("employee import helpers", () => {
  it("maps spreadsheet rows into the user payload shape", () => {
    const payload = buildUserPayload({
      "No.": 1600,
      "First Name": "Alice",
      "Last Name": "Wanjiku",
      "CARE Email Address": "Alice@example.com",
      "Job Title": "Coordinator",
      Department: "Programs",
      "Manager's CARE email address": "manager@example.com",
    });

    expect(payload).toEqual({
      employeeNumber: "1600",
      name: "Alice Wanjiku",
      email: "alice@example.com",
      position: "Coordinator",
      department: "Programs",
      managerEmail: "manager@example.com",
    });
  });

  it("maps the accurate staff roster format without changing the workbook name", () => {
    const payload = buildUserPayload({
      __EMPTY: 1,
      "Staff Name ": "Phoebe Achieng Otiende",
      Designation: "Executive Assistant",
      "Projects/Department": "Executive",
      "Line Manager": "Getrude Misango",
    });

    expect(payload).toEqual({
      employeeNumber: "1",
      name: "Phoebe Achieng Otiende",
      position: "Executive Assistant",
      department: "Executive",
      managerName: "Getrude Misango",
    });
  });

  it("derives admin candidates from manager email references", () => {
    const managerEmails = deriveManagerEmails([
      { "Manager's CARE email address": "manager@example.com" },
      { "Manager's CARE email address": "manager@example.com" },
      { "Manager's CARE email address": "director@example.com" },
    ]);

    expect(Array.from(managerEmails).sort()).toEqual([
      "director@example.com",
      "manager@example.com",
    ]);
  });
});

describe("employee import integration", () => {
  it("imports employees, sets manager links, and derives admin roles", async () => {
    const filePath = createWorkbookFile([
      {
        "No.": 1600,
        "First Name": "Manager",
        "Last Name": "One",
        "CARE Email Address": "manager@example.com",
        "Job Title": "Line Manager",
        Department: "Programs",
        "Manager's CARE email address": "",
      },
      {
        "No.": 1601,
        "First Name": "Alice",
        "Last Name": "User",
        "CARE Email Address": "alice@example.com",
        "Job Title": "Officer",
        Department: "Programs",
        "Manager's CARE email address": "manager@example.com",
      },
    ]);

    try {
      await importEmployeesFromFile(filePath, { sendInvites: false });
    } finally {
      fs.unlinkSync(filePath);
    }

    const manager = await User.findOne({ email: "manager@example.com" });
    const employee = await User.findOne({ email: "alice@example.com" });

    expect(manager.role).toBe("admin");
    expect(employee.role).toBe("user");
    expect(employee.managerId.toString()).toBe(manager._id.toString());
    expect(employee.mustSetPassword).toBe(true);
    expect(employee.passwordHash).toBeNull();
    expect(employee.inviteToken).toBeTruthy();
  });

  it("preserves activated accounts and superadmin role on re-import", async () => {
    const manager = await User.create({
      name: "Manager One",
      email: "manager@example.com",
      role: "admin",
      isActive: true,
      mustSetPassword: false,
      passwordHash: await hashPassword("ManagerPass123!"),
    });

    await User.create({
      name: "Super Admin",
      email: "super@example.com",
      role: "superadmin",
      isActive: true,
      mustSetPassword: false,
      passwordHash: await hashPassword("SuperPass123!"),
      managerId: manager._id,
    });

    const filePath = createWorkbookFile([
      {
        "No.": 1600,
        "First Name": "Manager",
        "Last Name": "One",
        "CARE Email Address": "manager@example.com",
        "Job Title": "Line Manager",
        Department: "Programs",
        "Manager's CARE email address": "",
      },
      {
        "No.": 1602,
        "First Name": "Super",
        "Last Name": "Admin",
        "CARE Email Address": "super@example.com",
        "Job Title": "System Admin",
        Department: "Programs",
        "Manager's CARE email address": "manager@example.com",
      },
    ]);

    try {
      await importEmployeesFromFile(filePath, { sendInvites: false });
    } finally {
      fs.unlinkSync(filePath);
    }

    const superAdmin = await User.findOne({ email: "super@example.com" });
    const managerAfter = await User.findOne({ email: "manager@example.com" });

    expect(superAdmin.role).toBe("superadmin");
    expect(superAdmin.mustSetPassword).toBe(false);
    expect(managerAfter.mustSetPassword).toBe(false);
  });

  it("sets the designated manager's manager as an alternate approver", async () => {
    const filePath = createWorkbookFile([
      {
        __EMPTY: 1,
        "Staff Name ": "Director",
        Designation: "Director",
        "Projects/Department": "Executive",
        "Line Manager": "",
      },
      {
        __EMPTY: 2,
        "Staff Name ": "Manager",
        Designation: "Manager",
        "Projects/Department": "Programs",
        "Line Manager": "Director",
      },
      {
        __EMPTY: 3,
        "Staff Name ": "Staff Member",
        Designation: "Officer",
        "Projects/Department": "Programs",
        "Line Manager": "Manager",
      },
    ]);

    await User.create([
      { name: "Director", email: "director@example.com", role: "admin" },
      { name: "Manager", email: "manager@example.com", role: "admin" },
      { name: "Staff Member", email: "staff@example.com", role: "user" },
    ]);

    try {
      await importEmployeesFromFile(filePath, { sendInvites: false });
    } finally {
      fs.unlinkSync(filePath);
    }

    const staff = await User.findOne({ email: "staff@example.com" });
    expect(staff.managerName).toBe("Manager");
    expect(staff.alternateManagers.map((manager) => manager.toObject())).toEqual([
      { _id: expect.anything(), name: "Director", email: "director@example.com" },
    ]);
    expect(staff.alternateApproverIds).toHaveLength(1);
  });
});
