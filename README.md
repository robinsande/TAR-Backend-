# CARE Travel Request Backend

Express and MongoDB backend for the CARE Kenya travel authority request workflow.

## Features
- JWT authentication with role-based access control for `user`, `admin`, and `superadmin`.
- Account activation flow: imported users must set a password before logging in.
- Approver selection via `selected_approver_id` (eligible admins), enforced on the server.
- Travel request lifecycle support for create, approve, reject, and rejected-request resubmit.
- Reimbursement reports with approve / reject and PDF download.
- In-app notifications plus Gmail/Nodemailer email notifications.
- Audit logging for request and reimbursement lifecycle events.
- Spreadsheet import via CLI or superadmin upload endpoint.
- Request filtering, list scopes (`mine` / `team` / `all`), and pagination.

## Tech Stack
- Node.js
- Express
- MongoDB with Mongoose
- JWT authentication
- Nodemailer + Gmail for email delivery
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
- `JWT_EXPIRES_IN`: Token lifetime, for example `1d`.
- `GMAIL_USER`: Gmail address used to send mail.
- `GMAIL_APP_PASSWORD`: Gmail app password (not your normal Gmail password).
- `BREVO_SMTP_USER`: Brevo SMTP login, used instead of Gmail when configured.
- `BREVO_SMTP_KEY`: Brevo SMTP key/password from Brevo SMTP settings.
- `EMAIL_FROM`: Sender address shown to recipients.
- `FRONTEND_URL`: Base URL used in account activation links (must match where you serve `care-travel-request-frontend`, e.g. `http://localhost:5500`).
- `NODE_ENV`: `development` | `test` | `production`.

### Brevo invitation email setup

1. In Brevo, open **Transactional > Settings > SMTP & API** and copy the SMTP login and SMTP key.
2. Set these backend variables locally without committing the key:
  ```env
  BREVO_SMTP_USER=your-brevo-smtp-login
  BREVO_SMTP_KEY=your-brevo-smtp-key
  EMAIL_FROM=verified-sender@care.org
  ```
3. Restart the backend after changing `.env`.
4. In Render, add the same three values under the `tar-backend` service environment variables and redeploy.

The sender address must be verified in Brevo. Do not put the SMTP key in source control or send it through chat.

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
- `GET /api/users/passengers`
- `GET /api/users` (superadmin)

### Travel requests (JWT)
- `POST /api/requests` (user | admin)
- `GET /api/requests` — query: `scope=mine|team|all`, `status`, `destination`, `dateFrom`, `dateTo`, `requestedByEmail`, `search`, `page`, `limit`
- `GET /api/requests/pending-my-approval` (admin)
- `GET /api/requests/:id`
- `PATCH /api/requests/:id/approve` (admin, assigned approver)
- `PATCH /api/requests/:id/reject` (admin, assigned approver)
- `PATCH /api/requests/:id` (resubmit rejected; user | admin owner)
- `GET /api/travel-requests/:id/pdf`

### Reimbursements (JWT)
- `GET /api/reimbursements/expense-categories`
- `GET /api/reimbursements/my-requests` (superadmin sees all)
- `GET /api/reimbursements/pending-approvals` (admin)
- `POST /api/reimbursements` (user | admin)
- `GET /api/reimbursements/:id`
- `PATCH /api/reimbursements/:id` (owner, rejected only)
- `PATCH /api/reimbursements/:id/status` (admin — approve/reject)
- `GET /api/reimbursements/:id/pdf`

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
