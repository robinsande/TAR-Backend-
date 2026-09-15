const { body } = require("express-validator");

const travelRequestBaseValidators = [
  body("selected_approver_id")
    .isMongoId()
    .withMessage("A valid selected approver ID is required"),
  body("project.name").isString().notEmpty().withMessage("Project name is required"),
  body("project.businessUnit").isString().notEmpty().withMessage("Business unit is required"),
  body("project.fundCode").isString().notEmpty().withMessage("Fund code is required"),
  body("project.projectId").isString().notEmpty().withMessage("Project ID is required"),
  body("project.departmentId").isString().notEmpty().withMessage("Department ID is required"),
  body("project.activityId").isString().notEmpty().withMessage("Activity ID is required"),
  body("assignedAreaOfOperation")
    .isString()
    .notEmpty()
    .withMessage("Assigned area of operation is required"),
  body("employeeOffice").optional().isString().withMessage("Employee office must be text"),
  body("purposeOfTrip").isString().notEmpty().withMessage("Purpose of trip is required"),
  body("requesterSignature").optional().isString().withMessage("Requester signature must be text"),
  body("modeOfTravel")
    .custom((value) => {
      if (!value || typeof value !== "object") {
        throw new Error("At least one mode of travel is required");
      }
      if (!(value.careVehicle || value.publicTransport || value.aircraft)) {
        throw new Error("At least one mode of travel is required");
      }
      return true;
    }),
  body("modeOfTravel.careVehicle").optional().isBoolean(),
  body("modeOfTravel.publicTransport").optional().isBoolean(),
  body("modeOfTravel.aircraft").optional().isBoolean(),
  body("itinerary.dateFrom").isISO8601().withMessage("Start date is required"),
  body("itinerary.dateTo").isISO8601().withMessage("End date is required"),
  body("itinerary.destination").isString().notEmpty().withMessage("Destination is required"),
  body("itinerary.accommodationNeeded").optional().isBoolean(),
  body("passengers")
    .isArray({ min: 1 })
    .withMessage("At least one passenger is required"),
  body("passengers.*.user")
    .isMongoId()
    .withMessage("Each passenger must be a valid employee"),
  body("passengers.*.employeeNumber").optional().isString(),
  body("passengers.*.name").optional().isString(),
];

const createTravelRequestValidator = travelRequestBaseValidators;

const resubmitTravelRequestValidator = travelRequestBaseValidators;

const rejectTravelRequestValidator = [
  body("comment").isString().notEmpty().withMessage("Rejection comment is required"),
];

const approveTravelRequestValidator = [
  body("comment").optional({ values: "falsy" }).isString().withMessage("Comment must be a string"),
  body("signature").isString().notEmpty().withMessage("Approver signature is required"),
];

module.exports = {
  createTravelRequestValidator,
  resubmitTravelRequestValidator,
  rejectTravelRequestValidator,
  approveTravelRequestValidator,
};
