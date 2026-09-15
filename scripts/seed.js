#!/usr/bin/env node
const mongoose = require("mongoose");
const User = require("../src/models/User");
const TravelRequest = require("../src/models/TravelRequest");
const ReimbursementReport = require("../src/models/ReimbursementReport");
const ExpenseLineItem = require("../src/models/ExpenseLineItem");
const Notification = require("../src/models/Notification");
const AuditLog = require("../src/models/AuditLog");
const env = require("../src/config/env");
const { connectDatabase, disconnectDatabase } = require("../src/config/database");
const { hashPassword } = require("../src/services/passwordService");

const DEFAULT_PASSWORD = "Password123!";

// Imported employees activated for local login testing (password only, profile unchanged).
const ACTIVATE_IMPORTED_EMAILS = ["lewis.kanyi@care.org"];

const SEED_USERS = [
  {
    employeeNumber: "1600",
    name: "Manager One",
    email: "manager@example.com",
    position: "Line Manager",
    department: "Programs",
    office: "Nairobi",
    role: "admin",
    managerEmail: null,
  },
  {
    employeeNumber: "1603",
    name: "Manager Two",
    email: "manager2@example.com",
    position: "Program Manager",
    department: "Programs",
    office: "Kisumu",
    role: "admin",
    managerEmail: null,
  },
  {
    employeeNumber: "1601",
    name: "Alice User",
    email: "alice@example.com",
    position: "Officer",
    department: "Programs",
    office: "Nairobi",
    role: "user",
    managerEmail: "manager@example.com",
  },
  {
    employeeNumber: "1604",
    name: "Bob Traveler",
    email: "bob@example.com",
    position: "Field Officer",
    department: "Programs",
    office: "Nairobi",
    role: "user",
    managerEmail: "manager@example.com",
  },
  {
    employeeNumber: "1605",
    name: "Carol Traveler",
    email: "carol@example.com",
    position: "Coordinator",
    department: "Admin",
    office: "Kisumu",
    role: "user",
    managerEmail: "manager2@example.com",
  },
  {
    employeeNumber: "1606",
    name: "Dana Traveler",
    email: "dana@example.com",
    position: "Program Assistant",
    department: "Programs",
    office: "Kisumu",
    role: "user",
    managerEmail: "manager2@example.com",
  },
  {
    employeeNumber: "1602",
    name: "Super Admin",
    email: "super@example.com",
    position: "System Admin",
    department: "Programs",
    office: "Nairobi",
    role: "superadmin",
    managerEmail: "manager@example.com",
  },
];

const PROJECTS = {
  we4r: {
    name: "WE4R",
    businessUnit: "KEN03",
    fundCode: "DEC16",
    projectId: "CDEUKE3014",
    departmentId: "KE0201",
    activityId: "3",
  },
  she: {
    name: "SHE Thrives",
    businessUnit: "KEN03",
    fundCode: "PQL22",
    projectId: "CDEUKE3020",
    departmentId: "KE0202",
    activityId: "1",
  },
  food: {
    name: "Food Systems",
    businessUnit: "KEN01",
    fundCode: "FNS08",
    projectId: "CDEUKE3011",
    departmentId: "KE0101",
    activityId: "5",
  },
};

function daysAgo(days, hour = 10) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

function dateOnlyDaysAgo(days) {
  const date = daysAgo(days, 0);
  return date;
}

function passengerFor(user) {
  return {
    user: user._id,
    employeeNumber: user.employeeNumber,
    name: user.name,
  };
}

function money(value) {
  return mongoose.Types.Decimal128.fromString(Number(value).toFixed(2));
}

async function clearDatabase() {
  await Promise.all([
    ExpenseLineItem.deleteMany({}),
    ReimbursementReport.deleteMany({}),
    Notification.deleteMany({}),
    AuditLog.deleteMany({}),
    TravelRequest.deleteMany({}),
    User.deleteMany({}),
  ]);
}

async function upsertActivatedUser(userData, passwordHash) {
  const { managerEmail, ...profile } = userData;

  return User.findOneAndUpdate(
    { email: profile.email },
    {
      $set: {
        ...profile,
        managerEmail,
        isActive: true,
        mustSetPassword: false,
        passwordHash,
        inviteToken: null,
        inviteTokenExpires: null,
      },
    },
    { upsert: true, returnDocument: "after", runValidators: true }
  );
}

async function linkManager(user, managerEmail) {
  if (!managerEmail) {
    user.managerId = null;
    await user.save();
    return user;
  }

  const manager = await User.findOne({ email: managerEmail });

  if (!manager) {
    throw new Error(`Manager not found for ${user.email}: ${managerEmail}`);
  }

  user.managerId = manager._id;
  await user.save();
  return user;
}

async function activateImportedUser(email, passwordHash) {
  const user = await User.findOne({ email: email.toLowerCase() });

  if (!user) {
    return null;
  }

  user.passwordHash = passwordHash;
  user.mustSetPassword = false;
  user.inviteToken = null;
  user.inviteTokenExpires = null;
  await user.save();
  return user;
}

async function seedUsers({ password = DEFAULT_PASSWORD } = {}) {
  const passwordHash = await hashPassword(password);
  const seeded = [];

  for (const userData of SEED_USERS) {
    const user = await upsertActivatedUser(userData, passwordHash);
    seeded.push(user);
  }

  for (const userData of SEED_USERS) {
    const user = await User.findOne({ email: userData.email });
    await linkManager(user, userData.managerEmail);
  }

  for (const email of ACTIVATE_IMPORTED_EMAILS) {
    const user = await activateImportedUser(email, passwordHash);
    if (user) {
      seeded.push(user);
    }
  }

  const byEmail = {};
  for (const user of await User.find({
    email: { $in: SEED_USERS.map((u) => u.email) },
  })) {
    byEmail[user.email] = user;
  }

  return { seeded, byEmail };
}

async function createTravelRequest(data) {
  const submittedAt = data.submittedAt || new Date();
  const request = await TravelRequest.create({
    requestedBy: data.requestedBy._id,
    selected_approver_id: data.approver._id,
    project: data.project,
    assignedAreaOfOperation: data.area,
    purposeOfTrip: data.purpose,
    modeOfTravel: data.modeOfTravel || {
      careVehicle: true,
      publicTransport: false,
      aircraft: false,
    },
    itinerary: {
      dateFrom: data.dateFrom,
      dateTo: data.dateTo,
      destination: data.destination,
      accommodationNeeded: data.accommodationNeeded ?? true,
    },
    passengers: data.passengers,
    status: data.status,
    decision: data.decision || {},
    version: data.version || 1,
    history: data.history || [],
    submittedAt,
    createdAt: submittedAt,
    updatedAt: data.updatedAt || submittedAt,
  });

  await AuditLog.create({
    action: "request_created",
    performedBy: data.requestedBy._id,
    targetRequest: request._id,
    metadata: { destination: data.destination, purpose: data.purpose },
    timestamp: submittedAt,
  });

  if (data.status === "approved" || data.status === "rejected") {
    await AuditLog.create({
      action: data.status === "approved" ? "request_approved" : "request_rejected",
      performedBy: data.approver._id,
      targetRequest: request._id,
      metadata: { comment: data.decision?.comment || null },
      timestamp: data.decision?.decidedAt || submittedAt,
    });
  }

  await Notification.create({
    recipient: data.approver._id,
    type: "new_request",
    request: request._id,
    message: `${data.requestedBy.name} submitted a travel request to ${data.destination}.`,
    read: data.status !== "pending",
    createdAt: submittedAt,
  });

  if (data.status === "approved") {
    await Notification.create({
      recipient: data.requestedBy._id,
      type: "approved",
      request: request._id,
      message: `Your travel request to ${data.destination} was approved.`,
      read: Boolean(data.requesterNotifRead),
      createdAt: data.decision?.decidedAt || submittedAt,
    });
  }

  if (data.status === "rejected") {
    await Notification.create({
      recipient: data.requestedBy._id,
      type: "rejected",
      request: request._id,
      message: `Your travel request to ${data.destination} was rejected.`,
      read: Boolean(data.requesterNotifRead),
      createdAt: data.decision?.decidedAt || submittedAt,
    });
  }

  for (const passenger of data.passengers || []) {
    if (passenger.user && String(passenger.user) !== String(data.requestedBy._id)) {
      await Notification.create({
        recipient: passenger.user,
        type: "passenger_added",
        request: request._id,
        message: `You were added as a passenger on a trip to ${data.destination}.`,
        read: data.status !== "pending",
        createdAt: submittedAt,
      });
    }
  }

  return request;
}

async function createReimbursement(data) {
  const submittedAt = data.submittedAt || new Date();
  const lineItems = data.lineItems || [];
  const total = lineItems.reduce((sum, item) => sum + Number(item.amount), 0);

  const report = await ReimbursementReport.create({
    travelRequest: data.travelRequest._id,
    submittedBy: data.submittedBy._id,
    selected_approver_id: data.approver._id,
    employeeNumber: data.submittedBy.employeeNumber,
    department: data.submittedBy.department || "Programs",
    position: data.submittedBy.position || "Officer",
    baseLocation: data.submittedBy.office || "Nairobi",
    status: data.status,
    totalAmountKsh: money(total),
    decision: data.decision || {},
    version: data.version || 1,
    history: data.history || [],
    submittedAt,
    approvedAt: data.approvedAt || null,
    createdAt: submittedAt,
    updatedAt: data.updatedAt || submittedAt,
  });

  if (lineItems.length) {
    await ExpenseLineItem.insertMany(
      lineItems.map((item) => ({
        report: report._id,
        expenseDate: item.expenseDate,
        location: item.location,
        category: item.category,
        description: item.description,
        amount: money(item.amount),
      }))
    );
  }

  await AuditLog.create({
    action: "reimbursement_created",
    performedBy: data.submittedBy._id,
    targetRequest: data.travelRequest._id,
    targetReimbursement: report._id,
    metadata: { totalAmountKsh: total },
    timestamp: submittedAt,
  });

  await Notification.create({
    recipient: data.approver._id,
    type: "reimbursement_submitted",
    request: data.travelRequest._id,
    reimbursement: report._id,
    message: `${data.submittedBy.name} submitted a reimbursement report (KES ${total.toFixed(2)}).`,
    read: data.status !== "pending",
    createdAt: submittedAt,
  });

  if (data.status === "approved") {
    await AuditLog.create({
      action: "reimbursement_approved",
      performedBy: data.approver._id,
      targetRequest: data.travelRequest._id,
      targetReimbursement: report._id,
      metadata: { comment: data.decision?.comment || null },
      timestamp: data.approvedAt || submittedAt,
    });

    await Notification.create({
      recipient: data.submittedBy._id,
      type: "reimbursement_approved",
      request: data.travelRequest._id,
      reimbursement: report._id,
      message: `Your reimbursement report was approved (KES ${total.toFixed(2)}).`,
      read: Boolean(data.submitterNotifRead),
      createdAt: data.approvedAt || submittedAt,
    });
  }

  if (data.status === "rejected") {
    await AuditLog.create({
      action: "reimbursement_rejected",
      performedBy: data.approver._id,
      targetRequest: data.travelRequest._id,
      targetReimbursement: report._id,
      metadata: { comment: data.decision?.comment || null },
      timestamp: data.decision?.decidedAt || submittedAt,
    });

    await Notification.create({
      recipient: data.submittedBy._id,
      type: "reimbursement_rejected",
      request: data.travelRequest._id,
      reimbursement: report._id,
      message: `Your reimbursement report was rejected.`,
      read: Boolean(data.submitterNotifRead),
      createdAt: data.decision?.decidedAt || submittedAt,
    });
  }

  return report;
}

async function seedDemoData(byEmail) {
  const manager = byEmail["manager@example.com"];
  const manager2 = byEmail["manager2@example.com"];
  const alice = byEmail["alice@example.com"];
  const bob = byEmail["bob@example.com"];
  const carol = byEmail["carol@example.com"];
  const dana = byEmail["dana@example.com"];

  // --- ~3 months ago (mid-April): completed trips + reimbursements ---
  const aliceKisumu = await createTravelRequest({
    requestedBy: alice,
    approver: manager,
    project: PROJECTS.we4r,
    area: "Kisumu and Siaya",
    purpose: "Quarterly partner monitoring visit",
    destination: "Kisumu",
    dateFrom: dateOnlyDaysAgo(88),
    dateTo: dateOnlyDaysAgo(85),
    passengers: [passengerFor(alice), passengerFor(bob)],
    status: "approved",
    submittedAt: daysAgo(94, 9),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(93, 14),
      comment: "Approved — covers Q1 monitoring deliverables.",
    },
    requesterNotifRead: true,
  });

  await createReimbursement({
    travelRequest: aliceKisumu,
    submittedBy: alice,
    approver: manager,
    status: "approved",
    submittedAt: daysAgo(83, 11),
    approvedAt: daysAgo(81, 15),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(81, 15),
      comment: "Receipts in order.",
    },
    submitterNotifRead: true,
    lineItems: [
      {
        expenseDate: dateOnlyDaysAgo(87),
        location: "Kisumu",
        category: "PER DIEM (M&I)",
        description: "Per diem — 3 days field visit",
        amount: 10500,
      },
      {
        expenseDate: dateOnlyDaysAgo(87),
        location: "Kisumu",
        category: "HOTEL ROOM & TAXES",
        description: "Hotel stay (2 nights)",
        amount: 16000,
      },
      {
        expenseDate: dateOnlyDaysAgo(88),
        location: "Nairobi–Kisumu",
        category: "VEHICLE FUEL",
        description: "CARE vehicle fuel round trip",
        amount: 8500,
      },
      {
        expenseDate: dateOnlyDaysAgo(86),
        location: "Siaya",
        category: "LUNCH",
        description: "Field lunch with partners",
        amount: 1800,
      },
    ],
  });

  const bobMeru = await createTravelRequest({
    requestedBy: bob,
    approver: manager,
    project: PROJECTS.food,
    area: "Eastern Kenya",
    purpose: "Farmer cooperative outreach — Meru highland value chains",
    destination: "Meru",
    dateFrom: dateOnlyDaysAgo(82),
    dateTo: dateOnlyDaysAgo(80),
    passengers: [passengerFor(bob)],
    status: "approved",
    submittedAt: daysAgo(87, 10),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(86, 11),
      comment: "Approved for co-op meetings.",
    },
    requesterNotifRead: true,
  });

  await createReimbursement({
    travelRequest: bobMeru,
    submittedBy: bob,
    approver: manager,
    status: "approved",
    submittedAt: daysAgo(78, 14),
    approvedAt: daysAgo(76, 9),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(76, 9),
      comment: "Approved.",
    },
    submitterNotifRead: true,
    lineItems: [
      {
        expenseDate: dateOnlyDaysAgo(82),
        location: "Meru",
        category: "PER DIEM (M&I)",
        description: "Per diem — 3 days",
        amount: 10500,
      },
      {
        expenseDate: dateOnlyDaysAgo(81),
        location: "Meru",
        category: "HOTEL ROOM & TAXES",
        description: "Hotel 2 nights",
        amount: 14000,
      },
      {
        expenseDate: dateOnlyDaysAgo(82),
        location: "Nairobi–Meru",
        category: "VEHICLE FUEL",
        description: "Fuel for field vehicle",
        amount: 6200,
      },
      {
        expenseDate: dateOnlyDaysAgo(80),
        location: "Meru",
        category: "BREAKFAST",
        description: "Early departure breakfast",
        amount: 900,
      },
    ],
  });

  const carolSiaya = await createTravelRequest({
    requestedBy: carol,
    approver: manager2,
    project: PROJECTS.we4r,
    area: "Nyanza",
    purpose: "Women economic empowerment group visits",
    destination: "Siaya",
    dateFrom: dateOnlyDaysAgo(79),
    dateTo: dateOnlyDaysAgo(77),
    passengers: [passengerFor(carol)],
    status: "approved",
    modeOfTravel: {
      careVehicle: false,
      publicTransport: true,
      aircraft: false,
    },
    submittedAt: daysAgo(84, 8),
    decision: {
      decidedBy: manager2._id,
      decidedAt: daysAgo(83, 15),
      comment: null,
    },
    requesterNotifRead: true,
  });

  await createReimbursement({
    travelRequest: carolSiaya,
    submittedBy: carol,
    approver: manager2,
    status: "approved",
    submittedAt: daysAgo(74, 10),
    approvedAt: daysAgo(73, 12),
    decision: {
      decidedBy: manager2._id,
      decidedAt: daysAgo(73, 12),
      comment: "Receipts ok.",
    },
    submitterNotifRead: true,
    lineItems: [
      {
        expenseDate: dateOnlyDaysAgo(79),
        location: "Siaya",
        category: "PER DIEM (M&I)",
        description: "Per diem — 3 days",
        amount: 10500,
      },
      {
        expenseDate: dateOnlyDaysAgo(78),
        location: "Siaya",
        category: "HOTEL ROOM & TAXES",
        description: "Guest house 2 nights",
        amount: 9000,
      },
      {
        expenseDate: dateOnlyDaysAgo(79),
        location: "Kisumu–Siaya",
        category: "TAXI/LOCAL TRANSPORTATION",
        description: "Matatu and boda transfers",
        amount: 2800,
      },
    ],
  });

  // --- ~2 months ago (mid-May) ---
  const bobNairobiWorkshop = await createTravelRequest({
    requestedBy: bob,
    approver: manager,
    project: PROJECTS.she,
    area: "Nairobi metropolitan",
    purpose: "Gender programming workshop facilitation",
    destination: "Nairobi",
    dateFrom: dateOnlyDaysAgo(62),
    dateTo: dateOnlyDaysAgo(60),
    passengers: [passengerFor(bob)],
    status: "approved",
    modeOfTravel: {
      careVehicle: false,
      publicTransport: true,
      aircraft: false,
    },
    accommodationNeeded: false,
    submittedAt: daysAgo(68, 8),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(67, 16),
      comment: null,
    },
    requesterNotifRead: true,
  });

  await createReimbursement({
    travelRequest: bobNairobiWorkshop,
    submittedBy: bob,
    approver: manager,
    status: "approved",
    submittedAt: daysAgo(58, 10),
    approvedAt: daysAgo(57, 11),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(57, 11),
      comment: "Approved.",
    },
    submitterNotifRead: true,
    lineItems: [
      {
        expenseDate: dateOnlyDaysAgo(62),
        location: "Nairobi",
        category: "TAXI/LOCAL TRANSPORTATION",
        description: "Venue transfers",
        amount: 3200,
      },
      {
        expenseDate: dateOnlyDaysAgo(61),
        location: "Nairobi",
        category: "LUNCH",
        description: "Workshop lunch (2 days)",
        amount: 2400,
      },
      {
        expenseDate: dateOnlyDaysAgo(61),
        location: "Nairobi",
        category: "INCIDENTALS",
        description: "Printing and stationery",
        amount: 1500,
      },
    ],
  });

  const aliceGarissa = await createTravelRequest({
    requestedBy: alice,
    approver: manager,
    project: PROJECTS.she,
    area: "North Eastern",
    purpose: "Adolescent girls safe spaces assessment",
    destination: "Garissa",
    dateFrom: dateOnlyDaysAgo(55),
    dateTo: dateOnlyDaysAgo(52),
    passengers: [passengerFor(alice)],
    status: "approved",
    modeOfTravel: {
      careVehicle: false,
      publicTransport: false,
      aircraft: true,
    },
    submittedAt: daysAgo(61, 9),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(60, 13),
      comment: "Security briefing completed — approved.",
    },
    requesterNotifRead: true,
  });

  await createReimbursement({
    travelRequest: aliceGarissa,
    submittedBy: alice,
    approver: manager,
    status: "approved",
    submittedAt: daysAgo(50, 15),
    approvedAt: daysAgo(48, 10),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(48, 10),
      comment: "Approved.",
    },
    submitterNotifRead: true,
    lineItems: [
      {
        expenseDate: dateOnlyDaysAgo(55),
        location: "Nairobi–Garissa",
        category: "AIRPORT TAXES & VISA FEES",
        description: "Domestic airport taxes",
        amount: 1200,
      },
      {
        expenseDate: dateOnlyDaysAgo(54),
        location: "Garissa",
        category: "HOTEL ROOM & TAXES",
        description: "Hotel 3 nights",
        amount: 21000,
      },
      {
        expenseDate: dateOnlyDaysAgo(54),
        location: "Garissa",
        category: "PER DIEM (M&I)",
        description: "Per diem — 4 days",
        amount: 14000,
      },
      {
        expenseDate: dateOnlyDaysAgo(53),
        location: "Garissa",
        category: "TAXI/LOCAL TRANSPORTATION",
        description: "Local hire for facility visits",
        amount: 7500,
      },
      {
        expenseDate: dateOnlyDaysAgo(53),
        location: "Garissa",
        category: "DINNER",
        description: "Community facilitator dinner",
        amount: 2800,
      },
    ],
  });

  const danaEldoret = await createTravelRequest({
    requestedBy: dana,
    approver: manager2,
    project: PROJECTS.food,
    area: "Rift Valley",
    purpose: "County food systems coordination meeting",
    destination: "Eldoret",
    dateFrom: dateOnlyDaysAgo(50),
    dateTo: dateOnlyDaysAgo(48),
    passengers: [passengerFor(dana), passengerFor(carol)],
    status: "approved",
    submittedAt: daysAgo(56, 11),
    decision: {
      decidedBy: manager2._id,
      decidedAt: daysAgo(55, 14),
      comment: "Approve joint travel with Carol.",
    },
    requesterNotifRead: true,
  });

  await createReimbursement({
    travelRequest: danaEldoret,
    submittedBy: dana,
    approver: manager2,
    status: "approved",
    submittedAt: daysAgo(46, 9),
    approvedAt: daysAgo(44, 16),
    decision: {
      decidedBy: manager2._id,
      decidedAt: daysAgo(44, 16),
      comment: null,
    },
    submitterNotifRead: true,
    lineItems: [
      {
        expenseDate: dateOnlyDaysAgo(50),
        location: "Eldoret",
        category: "PER DIEM (M&I)",
        description: "Per diem — 3 days",
        amount: 10500,
      },
      {
        expenseDate: dateOnlyDaysAgo(49),
        location: "Eldoret",
        category: "HOTEL ROOM & TAXES",
        description: "Hotel 2 nights",
        amount: 15500,
      },
      {
        expenseDate: dateOnlyDaysAgo(50),
        location: "Kisumu–Eldoret",
        category: "VEHICLE FUEL",
        description: "CARE vehicle fuel",
        amount: 5400,
      },
      {
        expenseDate: dateOnlyDaysAgo(49),
        location: "Eldoret",
        category: "LUNCH",
        description: "Stakeholder lunch",
        amount: 2200,
      },
    ],
  });

  // --- ~1.5 months ago (late May / early June) ---
  const carolTurkana = await createTravelRequest({
    requestedBy: carol,
    approver: manager2,
    project: PROJECTS.food,
    area: "Turkana County",
    purpose: "Food systems baseline assessment",
    destination: "Lodwar",
    dateFrom: dateOnlyDaysAgo(42),
    dateTo: dateOnlyDaysAgo(38),
    passengers: [passengerFor(carol), passengerFor(dana)],
    status: "approved",
    modeOfTravel: {
      careVehicle: false,
      publicTransport: false,
      aircraft: true,
    },
    submittedAt: daysAgo(49, 9),
    decision: {
      decidedBy: manager2._id,
      decidedAt: daysAgo(48, 13),
      comment: "Approve flight itinerary as submitted.",
    },
    requesterNotifRead: true,
  });

  await createReimbursement({
    travelRequest: carolTurkana,
    submittedBy: carol,
    approver: manager2,
    status: "approved",
    submittedAt: daysAgo(35, 14),
    approvedAt: daysAgo(33, 10),
    decision: {
      decidedBy: manager2._id,
      decidedAt: daysAgo(33, 10),
      comment: "Approved.",
    },
    submitterNotifRead: false,
    lineItems: [
      {
        expenseDate: dateOnlyDaysAgo(42),
        location: "Nairobi–Lodwar",
        category: "AIRPORT TAXES & VISA FEES",
        description: "Domestic airport taxes",
        amount: 1200,
      },
      {
        expenseDate: dateOnlyDaysAgo(41),
        location: "Lodwar",
        category: "HOTEL ROOM & TAXES",
        description: "Lodging 4 nights",
        amount: 28000,
      },
      {
        expenseDate: dateOnlyDaysAgo(41),
        location: "Lodwar",
        category: "PER DIEM (M&I)",
        description: "Per diem — 5 days",
        amount: 17500,
      },
      {
        expenseDate: dateOnlyDaysAgo(40),
        location: "Lodwar",
        category: "TAXI/LOCAL TRANSPORTATION",
        description: "Local hire for site visits",
        amount: 9000,
      },
    ],
  });

  // Quiet rejection that stayed rejected (no resubmit)
  await createTravelRequest({
    requestedBy: bob,
    approver: manager,
    project: PROJECTS.we4r,
    area: "Coast region",
    purpose: "Ad-hoc partner courtesy visit",
    destination: "Malindi",
    dateFrom: dateOnlyDaysAgo(40),
    dateTo: dateOnlyDaysAgo(38),
    passengers: [passengerFor(bob)],
    status: "rejected",
    submittedAt: daysAgo(45, 10),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(44, 17),
      comment: "Not aligned with current workplan — defer to next quarter.",
    },
    requesterNotifRead: true,
  });

  // --- ~1 month ago (mid-June) ---
  const danaMombasa = await createTravelRequest({
    requestedBy: dana,
    approver: manager2,
    project: PROJECTS.she,
    area: "Coast region",
    purpose: "Community dialogue sessions — SHE Thrives",
    destination: "Mombasa",
    dateFrom: dateOnlyDaysAgo(28),
    dateTo: dateOnlyDaysAgo(25),
    passengers: [passengerFor(dana)],
    status: "approved",
    submittedAt: daysAgo(35, 10),
    decision: {
      decidedBy: manager2._id,
      decidedAt: daysAgo(34, 12),
      comment: null,
    },
    requesterNotifRead: true,
  });

  await createReimbursement({
    travelRequest: danaMombasa,
    submittedBy: dana,
    approver: manager2,
    status: "pending",
    submittedAt: daysAgo(22, 16),
    lineItems: [
      {
        expenseDate: dateOnlyDaysAgo(28),
        location: "Mombasa",
        category: "HOTEL ROOM & TAXES",
        description: "Hotel 3 nights",
        amount: 19500,
      },
      {
        expenseDate: dateOnlyDaysAgo(27),
        location: "Mombasa",
        category: "PER DIEM (M&I)",
        description: "Per diem — 4 days",
        amount: 14000,
      },
      {
        expenseDate: dateOnlyDaysAgo(26),
        location: "Mombasa",
        category: "DINNER",
        description: "Community facilitator dinner",
        amount: 3500,
      },
    ],
  });

  const aliceMachakos = await createTravelRequest({
    requestedBy: alice,
    approver: manager,
    project: PROJECTS.we4r,
    area: "Eastern Kenya",
    purpose: "Partner capacity assessment — Machakos county office",
    destination: "Machakos",
    dateFrom: dateOnlyDaysAgo(24),
    dateTo: dateOnlyDaysAgo(23),
    passengers: [passengerFor(alice)],
    status: "approved",
    accommodationNeeded: false,
    modeOfTravel: {
      careVehicle: true,
      publicTransport: false,
      aircraft: false,
    },
    submittedAt: daysAgo(28, 8),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(27, 14),
      comment: "Day trips approved.",
    },
    requesterNotifRead: true,
  });

  await createReimbursement({
    travelRequest: aliceMachakos,
    submittedBy: alice,
    approver: manager,
    status: "approved",
    submittedAt: daysAgo(21, 11),
    approvedAt: daysAgo(20, 9),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(20, 9),
      comment: "Approved.",
    },
    submitterNotifRead: true,
    lineItems: [
      {
        expenseDate: dateOnlyDaysAgo(24),
        location: "Nairobi–Machakos",
        category: "VEHICLE FUEL",
        description: "Round-trip fuel",
        amount: 3800,
      },
      {
        expenseDate: dateOnlyDaysAgo(24),
        location: "Machakos",
        category: "LUNCH",
        description: "Field lunch",
        amount: 1200,
      },
      {
        expenseDate: dateOnlyDaysAgo(23),
        location: "Machakos",
        category: "INCIDENTALS",
        description: "Photocopying partner MoUs",
        amount: 650,
      },
    ],
  });

  // --- Rejected then resubmitted (late June) ---
  const aliceRejectedThenApproved = await createTravelRequest({
    requestedBy: alice,
    approver: manager,
    project: PROJECTS.we4r,
    area: "Western Kenya",
    purpose: "County stakeholder review meeting (revised dates)",
    destination: "Kakamega",
    dateFrom: dateOnlyDaysAgo(18),
    dateTo: dateOnlyDaysAgo(16),
    passengers: [passengerFor(alice)],
    status: "approved",
    version: 2,
    submittedAt: daysAgo(20, 9),
    updatedAt: daysAgo(19, 11),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(19, 11),
      comment: "Resubmission looks good — dates clarified.",
    },
    history: [
      {
        snapshot: {
          purposeOfTrip: "County stakeholder review meeting",
          destination: "Kakamega",
        },
        status: "rejected",
        decision: {
          decidedBy: manager._id,
          decidedAt: daysAgo(24, 15),
          comment: "Please clarify overnight accommodation need and revise dates.",
        },
        editedAt: daysAgo(20, 9),
      },
    ],
    requesterNotifRead: true,
  });

  await AuditLog.create({
    action: "request_resubmitted",
    performedBy: alice._id,
    targetRequest: aliceRejectedThenApproved._id,
    metadata: { version: 2 },
    timestamp: daysAgo(20, 9),
  });

  await createReimbursement({
    travelRequest: aliceRejectedThenApproved,
    submittedBy: alice,
    approver: manager,
    status: "approved",
    submittedAt: daysAgo(14, 13),
    approvedAt: daysAgo(12, 10),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(12, 10),
      comment: "All set.",
    },
    submitterNotifRead: true,
    lineItems: [
      {
        expenseDate: dateOnlyDaysAgo(18),
        location: "Kakamega",
        category: "PER DIEM (M&I)",
        description: "Per diem — 3 days",
        amount: 10500,
      },
      {
        expenseDate: dateOnlyDaysAgo(17),
        location: "Kakamega",
        category: "HOTEL ROOM & TAXES",
        description: "Hotel 2 nights",
        amount: 13000,
      },
      {
        expenseDate: dateOnlyDaysAgo(18),
        location: "Nairobi–Kakamega",
        category: "VEHICLE FUEL",
        description: "Fuel round trip",
        amount: 7200,
      },
    ],
  });

  // --- Approved trip with rejected reimbursement (test resubmit TER) ---
  const carolRejectedReimb = await createTravelRequest({
    requestedBy: carol,
    approver: manager2,
    project: PROJECTS.food,
    area: "Nyanza",
    purpose: "County food security forum",
    destination: "Homa Bay",
    dateFrom: dateOnlyDaysAgo(15),
    dateTo: dateOnlyDaysAgo(13),
    passengers: [passengerFor(carol)],
    status: "approved",
    submittedAt: daysAgo(20, 8),
    decision: {
      decidedBy: manager2._id,
      decidedAt: daysAgo(19, 12),
      comment: null,
    },
    requesterNotifRead: true,
  });

  await createReimbursement({
    travelRequest: carolRejectedReimb,
    submittedBy: carol,
    approver: manager2,
    status: "rejected",
    submittedAt: daysAgo(10, 15),
    decision: {
      decidedBy: manager2._id,
      decidedAt: daysAgo(9, 10),
      comment: "Missing hotel receipt — please attach and resubmit.",
    },
    submitterNotifRead: false,
    lineItems: [
      {
        expenseDate: dateOnlyDaysAgo(15),
        location: "Homa Bay",
        category: "PER DIEM (M&I)",
        description: "Per diem — 3 days",
        amount: 10500,
      },
      {
        expenseDate: dateOnlyDaysAgo(14),
        location: "Homa Bay",
        category: "HOTEL ROOM & TAXES",
        description: "Hotel 2 nights (receipt pending)",
        amount: 12000,
      },
      {
        expenseDate: dateOnlyDaysAgo(14),
        location: "Homa Bay",
        category: "OTHER EXPENSES",
        description: "Meeting venue contribution",
        amount: 5000,
      },
    ],
  });

  // --- Approved trip, no reimbursement yet (test create TER) ---
  await createTravelRequest({
    requestedBy: bob,
    approver: manager,
    project: PROJECTS.we4r,
    area: "Eastern Kenya",
    purpose: "Site supervision — Embu partner NGO",
    destination: "Embu",
    dateFrom: dateOnlyDaysAgo(8),
    dateTo: dateOnlyDaysAgo(6),
    passengers: [passengerFor(bob)],
    status: "approved",
    submittedAt: daysAgo(14, 10),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(13, 15),
      comment: "Approved.",
    },
    requesterNotifRead: true,
  });

  // --- Recent activity (this week): pending + rejected ---
  await createTravelRequest({
    requestedBy: bob,
    approver: manager,
    project: PROJECTS.food,
    area: "Rift Valley",
    purpose: "Market systems assessment — Nakuru value chain",
    destination: "Nakuru",
    dateFrom: dateOnlyDaysAgo(-5),
    dateTo: dateOnlyDaysAgo(-3),
    passengers: [passengerFor(bob), passengerFor(alice)],
    status: "pending",
    submittedAt: daysAgo(2, 8),
    accommodationNeeded: true,
  });

  await createTravelRequest({
    requestedBy: carol,
    approver: manager2,
    project: PROJECTS.we4r,
    area: "Nyanza",
    purpose: "Partner capacity building workshop",
    destination: "Kisumu",
    dateFrom: dateOnlyDaysAgo(-10),
    dateTo: dateOnlyDaysAgo(-8),
    passengers: [passengerFor(carol)],
    status: "pending",
    submittedAt: daysAgo(1, 14),
  });

  await createTravelRequest({
    requestedBy: dana,
    approver: manager2,
    project: PROJECTS.she,
    area: "Western Kenya",
    purpose: "School visit for adolescent girls programming",
    destination: "Bungoma",
    dateFrom: dateOnlyDaysAgo(-14),
    dateTo: dateOnlyDaysAgo(-12),
    passengers: [passengerFor(dana)],
    status: "pending",
    submittedAt: daysAgo(0, 9),
  });

  await createTravelRequest({
    requestedBy: alice,
    approver: manager,
    project: PROJECTS.she,
    area: "Central Kenya",
    purpose: "Emergency coordination meeting",
    destination: "Nyeri",
    dateFrom: dateOnlyDaysAgo(-7),
    dateTo: dateOnlyDaysAgo(-6),
    passengers: [passengerFor(alice)],
    status: "rejected",
    submittedAt: daysAgo(3, 11),
    decision: {
      decidedBy: manager._id,
      decidedAt: daysAgo(2, 17),
      comment: "Budget holder not confirmed — please resubmit with fund code owner noted.",
    },
    requesterNotifRead: false,
  });

  await createTravelRequest({
    requestedBy: alice,
    approver: manager,
    project: PROJECTS.food,
    area: "Nairobi metropolitan",
    purpose: "Donor briefing prep — HQ coordination",
    destination: "Nairobi",
    dateFrom: dateOnlyDaysAgo(-2),
    dateTo: dateOnlyDaysAgo(-2),
    passengers: [passengerFor(alice), passengerFor(bob)],
    status: "pending",
    accommodationNeeded: false,
    modeOfTravel: {
      careVehicle: false,
      publicTransport: true,
      aircraft: false,
    },
    submittedAt: daysAgo(0, 15),
  });
}

async function run() {
  await connectDatabase(env.mongodbUri);

  console.log("Clearing existing data...");
  await clearDatabase();

  console.log("Seeding users...");
  const { seeded, byEmail } = await seedUsers();

  console.log("Seeding demo travel & reimbursement history...");
  await seedDemoData(byEmail);

  const counts = {
    users: await User.countDocuments(),
    requests: await TravelRequest.countDocuments(),
    reimbursements: await ReimbursementReport.countDocuments(),
    expenses: await ExpenseLineItem.countDocuments(),
    notifications: await Notification.countDocuments(),
    auditLogs: await AuditLog.countDocuments(),
  };

  await disconnectDatabase();

  console.log("");
  console.log("Seed complete. Log in with Password123!");
  console.log("");
  console.log("Accounts:");
  for (const seedUser of SEED_USERS) {
    const user = seeded.find((item) => item.email === seedUser.email);
    if (!user) {
      continue;
    }
    console.log(
      `  ${user.role.padEnd(11)} ${user.email.padEnd(24)} manager: ${seedUser.managerEmail || "—"}`
    );
  }
  console.log("");
  console.log(
    `Data: ${counts.users} users, ${counts.requests} requests, ${counts.reimbursements} reimbursements, ${counts.expenses} expense lines, ${counts.notifications} notifications, ${counts.auditLogs} audit logs`
  );
}

if (require.main === module) {
  run().catch(async (error) => {
    console.error("Seed failed:", error.message);
    console.error(error.stack);
    await disconnectDatabase();
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_PASSWORD,
  SEED_USERS,
  seedUsers,
  clearDatabase,
  seedDemoData,
};
