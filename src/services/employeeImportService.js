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
  const existingUsers = await User.find({}).select("_id name email role passwordHash mustSetPassword");
  const usersByName = new Map(existingUsers.map((user) => [normalizeName(user.name), user]));
  const summary = {
    created: 0,
    updated: 0,
    skipped: 0,
    invitesSent: 0,
    errors: [],
  };

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
      const existingUser = await User.findOne({ email: payload.email });
      const inviteToken = generateInviteToken();
      const inviteTokenExpires = getInviteTokenExpiry();

      if (!existingUser) {
        await User.create({
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
        summary.created += 1;

        if (sendInvites) {
          const createdUser = await User.findOne({ email: payload.email });
          const sent = await sendActivationEmail(createdUser, inviteToken);
          if (sent) {
            summary.invitesSent += 1;
          }
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
          const sent = await sendActivationEmail(existingUser, inviteToken);
          if (sent) {
            summary.invitesSent += 1;
          }
        }
      }

      await User.updateOne({ _id: existingUser._id }, { $set: profileUpdate });
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

    const user = await User.findOne({ email });

    if (!user) {
      continue;
    }

    const manager = managerEmail
      ? await User.findOne({ email: managerEmail })
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
    const user = email ? await User.findOne({ email }) : null;

    if (!user || !user.managerId) {
      continue;
    }

    const manager = await User.findById(user.managerId).select("managerId");
    const alternateManager = manager?.managerId
      ? await User.findById(manager.managerId).select("_id name email")
      : null;

    user.alternateManagers = alternateManager
      ? [{ name: alternateManager.name, email: alternateManager.email }]
      : [];
    user.alternateApproverIds = alternateManager ? [alternateManager._id] : [];
    await user.save();
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
