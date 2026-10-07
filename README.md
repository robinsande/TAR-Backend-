# CARE Travel Request Backend

Express and MongoDB backend for the CARE Kenya travel authority request workflow.

## Features
- JWT authentication with role-based access control for `user`, `admin`, and `superadmin`.
- Account activation flow: imported users must set a password before logging in.
- Approver selection via `selected_approver_id` (eligible admins), enforced on the server.
- Travel request lifecycle support for create, approve, reject, and rejected-request resubmit.
- Reimbursements with sequential Supervisor → TAR Line Manager → Finance Admin approvals, approval history, expense support documents, a one-page Payment Voucher Form PDF with daily TER totals and descriptions based on the approved TAR destination, and merged PDF export.
- Read-only Auditor access to organization-wide TARs, reimbursements, and supporting documents.
- In-app notifications plus Brevo email notifications.
- Audit logging for request and reimbursement lifecycle events.
- Spreadsheet import via CLI or superadmin upload endpoint.
- Request filtering, list scopes (`mine` / `team` / `all`), and pagination.

## Pending approval reminders

Pending TARs receive automatic reminders to their primary selected approver after 22 hours, then approximately every 24 hours while they remain pending. The scheduler checks every 4 hours during configured working hours in production. Set `PENDING_REMINDER_INTERVAL_HOURS`, `PENDING_REMINDER_MIN_AGE_HOURS`, `PENDING_REMINDER_COOLDOWN_HOURS`, `PENDING_REMINDER_WORK_START_HOUR`, and `PENDING_REMINDER_WORK_END_HOUR` to override the defaults. Failed email sends do not advance the reminder timestamp, so the scheduler can retry.

## Tech Stack
- Node.js
- Express
- MongoDB with Mongoose
- JWT authentication
- Brevo API or SMTP for email delivery
- Jest and Supertest for tests

## Getting Started
1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and update the values.
3. Start MongoDB locally or point `MONGODB_URI` at your database.
4. Run the server:
   ```bash
   npm run dev
   ```

## Environment Variables
- `PORT`: HTTP port for the API.
- `MONGODB_URI`: MongoDB connection string.
- `JWT_SECRET`: Secret used to sign JWTs (required strong value in production).
- `JWT_EXPIRES_IN`: Token lifetime, for example `7d`.
- `BREVO_SMTP_USER`: Brevo SMTP login.
- `BREVO_SMTP_KEY`: Brevo SMTP key/password from Brevo SMTP settings.
- `BREVO_API_KEY`: Brevo API key. Preferred on Render because it uses HTTPS instead of an SMTP socket.
- `EMAIL_FROM`: Sender address shown to recipients.
- `FRONTEND_URL`: Base URL used in account activation links (must match where you serve `care-travel-request-frontend`, e.g. `http://localhost:5500`).
- `NODE_ENV`: `development` | `test` | `production`.

### Brevo invitation email setup

1. In Brevo, open **Transactional > Settings > SMTP & API** and copy the SMTP login and SMTP key.
2. Set these backend variables locally without committing the key:
  ```env
  BREVO_API_KEY=your-brevo-api-key
  BREVO_SMTP_USER=your-brevo-smtp-login
  BREVO_SMTP_KEY=your-brevo-smtp-key
  EMAIL_FROM=verified-sender@care.org
  ```
3. Restart the backend after changing `.env`.
4. In Render, add the same three values under the `tar-backend` service environment variables and redeploy.

The sender address must be verified in Brevo. The SMTP fallback uses Brevo port `2525` to avoid common hosting restrictions on port `587`. Do not put the SMTP key in source control or send it through chat.

Transactional TAR emails include both HTML and plain-text content. Inbox placement is determined by recipient mail systems and cannot be guaranteed by the application. For reliable delivery, verify the sender domain in Brevo and configure its SPF and DKIM DNS records; publish a DMARC policy for the same domain. Check Brevo delivery logs and the recipient's spam/quarantine folders if an email is missing.

## Frontend integration

This API is designed to work with the static frontend at `care-travel-request-frontend`:

1. Set `FRONTEND_URL` in `.env` to your frontend origin (Live Server is usually `http://localhost:5500`).
2. Start the API on port **5000**: `npm start`
3. Serve the frontend on a **different** port and open `frontend/login.html`.
4. The frontend calls `http://127.0.0.1:5000/api` by default.

For local testing without email:

```bash
npm run seed
```

Test logins (password `Password123!`):
- `manager@example.com` / `manager2@example.com` (admin)
- `alice@example.com` / `bob@example.com` (user, under manager)
- `carol@example.com` / `dana@example.com` (user, under manager2)
- `super@example.com` (superadmin)

`npm run seed` clears the database, then seeds users plus demo travel requests, reimbursements, notifications, and audit history.

## Available Scripts
- `npm run dev`: Start the API with `nodemon`.
- `npm start`: Start the API with Node.
- `npm test`: Run the Jest test suite.
- `npm run seed`: Create test users with passwords for local login.

## API Overview

### Auth (public; rate-limited)
- `POST /api/auth/login`
- `POST /api/auth/activate`
- `POST /api/auth/set-password`

### Health
- `GET /api/health`

### Users (JWT)
- `GET /api/users/me`
- `GET /api/users/approvers`
- `GET /api/users/supervisors` (active users with the `supervisor` workflow role)
- `GET /api/users/passengers`
- `GET /api/users` (superadmin)
- `PATCH /api/users/:id/roles` (superadmin; assign or remove `supervisor`, `finance_admin`, and `auditor`)

### Travel requests (JWT)
- `GET /api/requests/my-signature` (requester's signature from their latest approved TAR; falls back to their saved profile signature)
- `POST /api/requests` (staff roles, including superadmin and super-superadmin accounts)
- `GET /api/requests` — query: `scope=mine|team|all`, `status`, `destination`, `dateFrom`, `dateTo`, `requestedByEmail`, `search`, `page`, `limit`
- Auditor and superadmin read access is organization-wide; auditors cannot create, edit, approve, or reject TARs.
- A superadmin or super-superadmin may use `scope=mine` to access their own TARs for staff workflows; their organization-wide review views remain available.
- `GET /api/requests/pending-my-approval` (admin)
- `GET /api/requests/:id`
- `PATCH /api/requests/:id/approve` (admin, assigned approver)
- `PATCH /api/requests/:id/reject` (admin, assigned approver)
- `PATCH /api/requests/:id` (resubmit rejected; user | admin owner)
- `GET /api/travel-requests/:id/pdf`

### Reimbursements (JWT)
- `GET /api/reimbursements/expense-categories`
- `GET /api/reimbursements/template/ter.pdf` (blank landscape Travel Expense Report template)
- `GET /api/reimbursements/my-requests` (own reports by default; auditor and superadmin may pass `scope=all`)
- `GET /api/reimbursements/team` (role-scoped team/approval queue; auditor and superadmin see all)
- `GET /api/reimbursements/pending-approvals` (assigned Supervisor, TAR Line Manager, or Finance Admin)
- `POST /api/reimbursements` (staff roles, including superadmin and super-superadmin accounts)
- `GET /api/reimbursements/:id`
- `PATCH /api/reimbursements/:id` (owner, declined only; resubmission restarts the assigned Supervisor stage or goes directly to the TAR Line Manager when no Supervisor is assigned)
- `PATCH /api/reimbursements/:id/status` (`review_started`, `approved`, `rejected`, or `completed`; backend checks the assigned reviewer and current stage)
- `POST /api/reimbursements/:id/attachments` and `GET /api/reimbursements/:id/attachments/:attachmentId` (server-enforced audience access)
- `GET /api/reimbursements/:id/payment-voucher.pdf` (single-page landscape Payment Voucher Form)
- `GET /api/reimbursements/:id/pdf`

### Reimbursement approval and document access

Reimbursement approvers are existing users assigned workflow roles by a superadmin. A submitter may select an active Supervisor from the eligible-user list; arbitrary names and email addresses are not accepted. Supervisor selection is optional when no separate Supervisor is assigned. The Supervisor must differ from the Line Manager taken from the already-approved TAR, which cannot be changed on the reimbursement.

When a separate Supervisor is selected, approvals proceed in order: `SUBMITTED_TO_SUPERVISOR` → `SUPERVISOR_REVIEW` → Supervisor decision → `SUBMITTED_TO_LINE_MANAGER` → `LINE_MANAGER_REVIEW` → Line Manager decision → `SUBMITTED_TO_FINANCE` → `FINANCE_REVIEW` → Finance decision → `PAYMENT_PROCESSING` → `COMPLETED`. When no separate Supervisor is assigned, the request goes directly to the TAR Line Manager. Reviewers explicitly start review before they can decide. The API derives the next state from the authenticated user, assigned reviewer, and current status; client-supplied final statuses cannot skip a stage. Declines require a reason, and decisions are appended to the immutable approval history.

The Line Manager cannot be assigned to the Supervisor role on the same reimbursement. Each approval stage must be completed by its own assigned approver. A separate Finance Admin may optionally be copied when the report reaches Finance; that copy recipient gets read-only access to the financial package and cannot approve or complete payment.

The merged PDF contains the payment request, landscape Travel Expense Report pages (six expense days per page, up to 30 distinct days), and the approved TAR. On the Payment Request, the requester is shown under “Prepared by,” Finance under “Reviewed by,” and the TAR Line Manager under “Approved by”; each designation is read from the approver’s profile position. New reimbursement requests use M-PESA only and collect the requester’s M-PESA mobile number; other payment and bank fields remain blank template fields. The PeopleSoft account classification is read from the selected approved TAR. Requesters may save a PNG signature to their own account; it is returned only by their authenticated `/users/me` endpoint and may be removed there. Finance Admins and Finance copy recipients can access only financial attachments; Line Managers can access financial and line-manager attachments; Supervisors can access supervisor and financial attachments. Auditors and superadmins have read-only access to all reimbursement records and documents. Back-to-Office Reports and TORs should be uploaded with the Line Manager audience, not the financial audience.

### Notifications (JWT)
- `GET /api/notifications`
- `PATCH /api/notifications/:id/read`
- `PATCH /api/notifications/mark-all-read`

### Admin (JWT)
- `POST /api/admin/import-employees` (superadmin, multipart file upload)

## Account Activation Flow
1. Import employees from Excel.
2. Each new user gets an activation email with a token and link.
3. User calls `POST /api/auth/activate` with `email`, `token`, and `newPassword`.
4. Only after activation can the user log in.

## Employee Import
CLI import:

```bash
node scripts/importEmployees.js path/to/employees.xlsx
```

Superadmin upload:

```bash
POST /api/admin/import-employees
Authorization: Bearer <superadmin-token>
Content-Type: multipart/form-data
file: employees.xlsx
```

Re-import is safe for activated users:
- HR fields like name, department, and manager links are updated.
- Activated passwords, `superadmin` role, and completed activations are preserved.

## Request Filtering
Admins and superadmins can filter list results. Any authenticated user may pass `scope=mine` to list only requests they raised or travel on.

```
GET /api/requests?scope=mine
GET /api/requests?scope=team
GET /api/requests?status=pending&search=Kisumu&page=1&limit=20
GET /api/requests?destination=Nairobi&dateFrom=2026-07-01&dateTo=2026-07-31
GET /api/requests?requestedByEmail=alice@care.org
```

List responses are paginated:

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0
  }
}
```

## Dev Password Shortcut
For local testing without email:

```bash
node scripts/setPassword.js someone@care.org YourPassword123!
```

## Testing
Run:

```bash
npm test
```
