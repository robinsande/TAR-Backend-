const TravelRequest = require("../models/TravelRequest");
const { notifyTravelRequestApprover } = require("./notificationService");

const env = require("../config/env");

const DEFAULT_JOB_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_MIN_REQUEST_AGE_MS = 22 * 60 * 60 * 1000;
const DEFAULT_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WORK_START_HOUR = 7;
const DEFAULT_WORK_END_HOUR = 19;

let schedulerTimer = null;
let isRunning = false;

function getJobIntervalMs() {
  const configured = Number(process.env.PENDING_REMINDER_INTERVAL_HOURS);
  if (configured && configured > 0) {
    return configured * 60 * 60 * 1000;
  }
  return DEFAULT_JOB_INTERVAL_MS;
}

function getMinRequestAgeMs() {
  const configured = Number(process.env.PENDING_REMINDER_MIN_AGE_HOURS);
  if (configured && configured > 0) {
    return configured * 60 * 60 * 1000;
  }
  return DEFAULT_MIN_REQUEST_AGE_MS;
}

function getReminderCooldownMs() {
  const configured = Number(process.env.PENDING_REMINDER_COOLDOWN_HOURS);
  if (configured && configured > 0) {
    return configured * 60 * 60 * 1000;
  }
  return DEFAULT_REMINDER_COOLDOWN_MS;
}

function isWithinWorkingHours() {
  if (env.nodeEnv === "development") return true;
  const hour = new Date().getHours();
  const start = Number(process.env.PENDING_REMINDER_WORK_START_HOUR) || DEFAULT_WORK_START_HOUR;
  const end = Number(process.env.PENDING_REMINDER_WORK_END_HOUR) || DEFAULT_WORK_END_HOUR;
  return hour >= start && hour < end;
}

async function runPendingApprovalReminders({ force = false } = {}) {
  if (isRunning) {
    console.log("[pending-reminders] Skipping run: previous job still active");
    return { skipped: true, reason: "already_running" };
  }

  if (!force && !isWithinWorkingHours()) {
    console.log("[pending-reminders] Skipping run: outside configured working hours");
    return { skipped: true, reason: "outside_working_hours" };
  }

  isRunning = true;
  const runStartedAt = new Date();
  const summary = {
    startedAt: runStartedAt.toISOString(),
    candidateRequests: 0,
    processedRequests: 0,
    approverEmailsSent: 0,
    failedRequests: 0,
  };

  try {
    const minAgeMs = getMinRequestAgeMs();
    const cooldownMs = getReminderCooldownMs();
    const now = Date.now();
    const minSubmittedAt = new Date(now - minAgeMs);
    const minLastReminderAt = new Date(now - cooldownMs);

    const pendingQuery = {
      status: "pending",
      submittedAt: { $lte: minSubmittedAt },
      $or: [
        { lastApprovalReminderAt: null },
        { lastApprovalReminderAt: { $lte: minLastReminderAt } },
      ],
    };

    const pendingRequests = await TravelRequest.find(pendingQuery)
      .populate("requestedBy", "name email")
      .sort({ submittedAt: 1 });

    summary.candidateRequests = pendingRequests.length;
    console.log(`[pending-reminders] Found ${pendingRequests.length} pending TAR(s) eligible for reminder`);

    for (const requestDocument of pendingRequests) {
      try {
        const requester = requestDocument.requestedBy;
        const notifications = await notifyTravelRequestApprover(
          requestDocument,
          "approval_reminder",
          requester
        );

        const sentCount = Array.isArray(notifications)
          ? notifications.filter(Boolean).length
          : Number(Boolean(notifications));

        if (sentCount > 0) {
          requestDocument.lastApprovalReminderAt = new Date();
          await requestDocument.save();
          summary.approverEmailsSent += sentCount;
        }

        summary.processedRequests += 1;
      } catch (requestError) {
        summary.failedRequests += 1;
        console.error(
          `[pending-reminders] Failed to send reminder for TAR ${requestDocument._id}:`,
          requestError.message
        );
      }
    }

    summary.endedAt = new Date().toISOString();
    summary.durationMs = Date.now() - runStartedAt.getTime();
    console.log(`[pending-reminders] Run complete: ${JSON.stringify(summary)}`);
    return summary;
  } catch (error) {
    console.error("[pending-reminders] Job failed:", error.message);
    throw error;
  } finally {
    isRunning = false;
  }
}

function startPendingApprovalReminderScheduler() {
  if (env.nodeEnv === "test") {
    console.log("[pending-reminders] Scheduler disabled in test environment");
    return;
  }

  if (schedulerTimer) {
    console.log("[pending-reminders] Scheduler already running");
    return;
  }

  const intervalMs = getJobIntervalMs();
  console.log(
    `[pending-reminders] Starting scheduler: interval=${Math.round(intervalMs / 3600000)}h ` +
    `minAge=${Math.round(getMinRequestAgeMs() / 3600000)}h ` +
    `cooldown=${Math.round(getReminderCooldownMs() / 3600000)}h`
  );

  const firstRunDelay = env.nodeEnv === "development" ? 15_000 : 60_000;
  setTimeout(() => {
    runPendingApprovalReminders().catch((error) => {
      console.error("[pending-reminders] Initial scheduled run failed:", error.message);
    });
  }, firstRunDelay);

  schedulerTimer = setInterval(() => {
    runPendingApprovalReminders().catch((error) => {
      console.error("[pending-reminders] Scheduled run failed:", error.message);
    });
  }, intervalMs);
}

function stopPendingApprovalReminderScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log("[pending-reminders] Scheduler stopped");
  }
}

module.exports = {
  startPendingApprovalReminderScheduler,
  stopPendingApprovalReminderScheduler,
  runPendingApprovalReminders,
};
