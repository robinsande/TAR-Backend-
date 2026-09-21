require("dotenv").config();

const mongoose = require("mongoose");
const env = require("../src/config/env");
const { connectDatabase, disconnectDatabase } = require("../src/config/database");
const TravelRequest = require("../src/models/TravelRequest");
const { resendTravelRequestNotifications } = require("../src/services/notificationService");

async function main() {
  await connectDatabase(env.mongodbUri);

  const requests = await TravelRequest.find({ status: { $in: ["pending", "approved"] } })
    .populate("requestedBy", "name email")
    .sort({ createdAt: 1 });
  const summary = { requests: 0, approvalEmails: 0, flightBookingEmails: 0 };

  for (const request of requests) {
    const result = await resendTravelRequestNotifications(request);
    summary.requests += 1;
    summary.approvalEmails += result.approvalCount;
    summary.flightBookingEmails += result.flightBookingCount;
  }

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await disconnectDatabase();
    }
  });