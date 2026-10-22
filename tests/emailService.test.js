jest.mock("nodemailer", () => ({
  createTransport: jest.fn(),
}));

jest.mock("../src/config/env", () => ({
  brevoApiKey: "test-api-key",
  brevoSmtpUser: "",
  brevoSmtpKey: "",
  emailFrom: "travel@example.org",
  emailFromName: "CARE Travel Request",
  frontendUrl: "https://travel.example.org",
}));

const {
  sendEmail,
  buildActivationEmail,
  buildTemporaryPasswordEmail,
} = require("../src/services/emailService");

describe("email delivery", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("provides plain-text alternatives for account emails", () => {
    const activation = buildActivationEmail(
      { name: "Staff Member", email: "staff@example.org" },
      "activation-token"
    );
    const temporaryPassword = buildTemporaryPasswordEmail(
      { name: "Staff Member", email: "staff@example.org" },
      "temporary-password",
      "2026-10-29T00:00:00.000Z"
    );

    expect(activation.text).toContain("activation-token");
    expect(activation.text).toContain("https://");
    expect(temporaryPassword.text).toContain("temporary-password");
    expect(temporaryPassword.text).toContain("staff@example.org");
  });

  it("retries temporary Brevo errors and preserves the message payload", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "Temporarily unavailable",
      })
      .mockResolvedValueOnce({ ok: true, status: 201 });

    await expect(sendEmail("approver@example.org", "TAR approval", "<p>Review</p>", {
      text: "Review",
      replyTo: "requester@example.org",
    })).resolves.toBe(true);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(global.fetch.mock.calls[0][1].body);
    const retryRequest = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(firstRequest).toEqual(retryRequest);
    expect(firstRequest.textContent).toBe("Review");
    expect(firstRequest.sender).toEqual({
      email: "travel@example.org",
      name: "CARE Travel Request",
    });
    expect(firstRequest.replyTo).toEqual({ email: "requester@example.org" });
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("does not retry permanent Brevo errors", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Invalid sender",
    });
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendEmail("approver@example.org", "TAR approval", "<p>Review</p>"))
      .resolves.toBe(false);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith("Brevo API email failed:", "Brevo API 400: Invalid sender");
  });
});
