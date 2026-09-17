const xlsx = require("xlsx");
const User = require("../models/User");
const {
  generateInviteToken,
  getInviteTokenExpiry,
} = require("./inviteTokenService");
const { sendActivationEmail } = require("./emailService");

function getCellValue(row, key) {
  const requestedKey = String(key).trim().toLowerCase();
  const actualKey = Object.keys(row).find(
    (rowKey) => String(rowKey).trim().toLowerCase() === requestedKey
  );
  const value = actualKey === undefined ? undefined : row[actualKey];
  return typeof value === "string" ? value.trim() : value;
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function getStaffName(row) {
  const staffName = getCellValue(row, "Staff Name");
  if (staffName) {
    return String(staffName).trim().replace(/\s+/g, " ");
  }

  const firstName = getCellValue(row, "First Name") || "";
  const lastName = getCellValue(row, "Last Name") || "";
  return `${firstName} ${lastName}`.trim().replace(/\s+/g, " ");
}

function isEmployeeRow(row) {
  const name = getStaffName(row);
  const position = getCellValue(row, "Job Title") || getCellValue(row, "Designation");
  const department = getCellValue(row, "Department") || getCellValue(row, "Projects/Department");
  return Boolean(name && (position || department));
}

function getManagerName(row) {
  return String(getCellValue(row, "Line Manager") || "").trim().replace(/\s+/g, " ");
}

function getEmployeeEmail(row) {
  return String(
    getCellValue(row, "CARE Email Address") ||
    getCellValue(row, "Email Address") ||
    getCellValue(row, "Email") ||
    ""
  ).trim().toLowerCase();
}

function buildUserPayload(row) {
  const name = getStaffName(row);
  const email = getEmployeeEmail(row);

  const payload = {
    employeeNumber: getCellValue(row, "No.") || getCellValue(row, "__EMPTY")
      ? String(getCellValue(row, "No.") || getCellValue(row, "__EMPTY"))
      : null,
    name,
    position: getCellValue(row, "Job Title") || getCellValue(row, "Designation") || null,
    department: getCellValue(row, "Department") || getCellValue(row, "Projects/Department") || null,
  };

  if (email) {
    payload.email = email;
  }

  const managerEmail = String(
    getCellValue(row, "Manager's CARE email address") || ""
  ).toLowerCase();
  if (managerEmail) {
    payload.managerEmail = managerEmail;
  }
  const managerName = getManagerName(row);
  if (managerName) {
    payload.managerName = managerName;
  }

  return payload;
}

function deriveManagerEmails(rows) {
  return new Set(
    rows
      .map((row) => String(getCellValue(row, "Manager's CARE email address") || "").toLowerCase())
      .filter(Boolean)
  );
}

function deriveRoleForEmail(email, managerEmails, existingRole) {
  if (existingRole === "superadmin") {
    return "superadmin";
  }

  if (managerEmails.has(email)) {
    return "admin";
  }

  return existingRole || "user";
}

function rowsFromWorkbookBuffer(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  return xlsx.utils.sheet_to_json(firstSheet, { defval: "" });
}

function rowsFromWorkbookFile(filePath) {
  const workbook = xlsx.readFile(filePath);
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  return xlsx.utils.sheet_to_json(firstSheet, { defval: "" });
}

async function importEmployeeRows(rows, { sendInvites = true } = {}) {
  const employeeRows = rows.filter(isEmployeeRow);

  if (!employeeRows.length) {
    throw new Error("No employee rows found in the provided spreadsheet.");
  }

  const managerEmails = deriveManagerEmails(employeeRows);
  const managerNames = new Set(
    employeeRows.map((row) => normalizeName(getManagerName(row))).filter(Boolean)
  );
  const existingUsers = await User.find({}).select("_id name email role passwordHash mustSetPassword managerId");
  const usersByName = new Map(existingUsers.map((user) => [normalizeName(user.name), user]));
  const usersByEmail = new Map(existingUsers.map((user) => [user.email.toLowerCase(), user]));
  const usersById = new Map(existingUsers.map((user) => [String(user._id), user]));
  const summary = {
    created: 0,
    updated: 0,
    skipped: 0,
    invitesSent: 0,
    errors: [],
  };
  const inviteTasks = [];

  for (const row of employeeRows) {
    const payload = buildUserPayload(row);
    const matchedUser = usersByName.get(normalizeName(payload.name));

    if (!payload.email && matchedUser) {
      payload.email = matchedUser.email;
    }

    if (!payload.email || !payload.name) {
      summary.skipped += 1;
      if (payload.name && !payload.email) {
        summary.errors.push({
          name: payload.name,
          message: "Missing CARE email address; add an email column before importing this new employee.",
        });
      }
      continue;
    }

    try {
      const existingUser = usersByEmail.get(payload.email);
      const inviteToken = generateInviteToken();
      const inviteTokenExpires = getInviteTokenExpiry();

      if (!existingUser) {
        const createdUser = await User.create({
          ...payload,
          role: deriveRoleForEmail(
            payload.email,
            managerEmails,
            matchedUser?.role === "superadmin"
              ? "superadmin"
              : managerNames.has(normalizeName(payload.name))
                ? "admin"
                : matchedUser?.role
          ),
          isActive: true,
          mustSetPassword: true,
          passwordHash: null,
          inviteToken,
          inviteTokenExpires,
        });
        usersByEmail.set(payload.email, createdUser);
        usersByName.set(normalizeName(createdUser.name), createdUser);
        usersById.set(String(createdUser._id), createdUser);
        summary.created += 1;

        if (sendInvites) {
          inviteTasks.push(() => sendActivationEmail(createdUser, inviteToken));
        }

        continue;
      }

      const profileUpdate = {
        employeeNumber: payload.employeeNumber,
        name: payload.name,
        position: payload.position,
        department: payload.department,
        managerEmail: payload.managerEmail,
        managerName: payload.managerName,
        isActive: true,
      };

      if (existingUser.role !== "superadmin") {
        profileUpdate.role = deriveRoleForEmail(
          payload.email,
          managerEmails,
          existingUser.role === "superadmin"
            ? "superadmin"
            : managerNames.has(normalizeName(payload.name))
              ? "admin"
              : existingUser.role
        );
      }

      if (!existingUser.passwordHash || existingUser.mustSetPassword) {
        profileUpdate.mustSetPassword = true;
        profileUpdate.inviteToken = inviteToken;
        profileUpdate.inviteTokenExpires = inviteTokenExpires;
        profileUpdate.passwordHash = null;

        if (sendInvites) {
          inviteTasks.push(() => sendActivationEmail(existingUser, inviteToken));
        }
      }

      await User.updateOne({ _id: existingUser._id }, { $set: profileUpdate });
      Object.assign(existingUser, profileUpdate);
      summary.updated += 1;
    } catch (error) {
      summary.errors.push({ email: payload.email, message: error.message });
    }
  }

  for (const row of employeeRows) {
    const payload = buildUserPayload(row);
    const matchedUser = usersByName.get(normalizeName(payload.name));
    const email = String(payload.email || matchedUser?.email || "").toLowerCase();
    const managerEmail = String(
      getCellValue(row, "Manager's CARE email address") || ""
    ).toLowerCase();
    const managerName = getManagerName(row);

    if (!email) {
      continue;
    }

    const user = usersByEmail.get(email);

    if (!user) {
      continue;
    }

    const manager = managerEmail
      ? usersByEmail.get(managerEmail)
      : usersByName.get(normalizeName(managerName));

    if (!manager) {
      user.managerId = null;
      user.managerEmail = managerEmail || null;
      user.managerName = managerName || null;
      user.alternateManagers = [];
      user.alternateApproverIds = [];
      await user.save();
      continue;
    }

    user.managerId = manager._id;
    user.managerEmail = manager.email;
    user.managerName = manager.name;

    await user.save();
  }

  for (const row of employeeRows) {
    const payload = buildUserPayload(row);
    const matchedUser = usersByName.get(normalizeName(payload.name));
    const email = String(payload.email || matchedUser?.email || "").toLowerCase();
    const user = email ? usersByEmail.get(email) : null;

    if (!user || !user.managerId) {
      continue;
    }

    const manager = usersById.get(String(user.managerId));
    const alternateManager = manager?.managerId
      ? usersById.get(String(manager.managerId))
      : null;

    user.alternateManagers = alternateManager
      ? [{ name: alternateManager.name, email: alternateManager.email }]
      : [];
    user.alternateApproverIds = alternateManager ? [alternateManager._id] : [];
    await user.save();
  }

  if (sendInvites && inviteTasks.length) {
    const inviteResults = await Promise.allSettled(inviteTasks.map((task) => task()));
    for (const result of inviteResults) {
      if (result.status === "fulfilled" && result.value) {
        summary.invitesSent += 1;
      } else if (result.status === "rejected") {
        summary.errors.push({ message: result.reason?.message || "Activation email failed." });
      }
    }
  }

  return summary;
}

async function importEmployeesFromFile(filePath, options = {}) {
  const rows = rowsFromWorkbookFile(filePath);
  return importEmployeeRows(rows, options);
}

async function importEmployeesFromBuffer(buffer, options = {}) {
  const rows = rowsFromWorkbookBuffer(buffer);
  return importEmployeeRows(rows, options);
}

module.exports = {
  buildUserPayload,
  deriveManagerEmails,
  deriveRoleForEmail,
  normalizeName,
  importEmployeeRows,
  importEmployeesFromFile,
  importEmployeesFromBuffer,
};
