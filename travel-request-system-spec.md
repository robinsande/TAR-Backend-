# CARE Kenya — Local Travel Authority Request (TAR) Backend Spec

Stack: Node.js (Express) + MongoDB (Mongoose). JWT-based auth.

---

## 1. Roles

| Role | Can create requests | Can approve | Visibility |
|---|---|---|---|
| `user` | Yes (own requests only) | No | Own requests only |
| `admin` (line manager) | Yes (own requests, approved by *their* manager) | Yes — only for direct reports | Only requests from people they manage (+ their own) |
| `superadmin` | No (read-only) | No | Everything, system-wide |

Key rule baked into the data model: **a request's approver is always the requester's manager**, looked up from your existing employee/manager records — not chosen manually. This avoids people picking their own approver.

---

## 2. Data Models

### 2.1 `User` (synced from your existing employee DB, or referenced directly if it already lives in Mongo)

```js
{
  _id: ObjectId,
  employeeNumber: String,      // e.g. "1600" — unique, matches existing DB
  name: String,
  email: String,               // for login + notifications
  passwordHash: String,
  position: String,            // e.g. "MEAL Coordinator"
  office: String,              // e.g. "Nairobi"
  role: { type: String, enum: ["user", "admin", "superadmin"] },
  managerId: { type: ObjectId, ref: "User", default: null }, // who approves this person's requests
  isActive: Boolean,
  createdAt, updatedAt
}
```

Since your source of truth is an Excel sheet, treat it as a one-time/occasional import rather than a live sync.

Your actual columns are: `No., First Name, Last Name, CARE Email Address, Job Title, Manager's CARE email address, Department`. A few things to note about mapping these in:

- **No `employeeNumber` column.** Your sheet doesn't have the staff ID used on the PDF form (e.g. "1600"). Either source that separately and add it as a column, or use `CARE Email Address` as the unique key instead (simpler — see below).
- **No `role` column** (user/admin/superadmin). The sheet can't tell the importer who's an approver. Two options: (a) add a `Role` column to the sheet so HR/you mark it directly, or (b) derive it in the script — anyone who appears in another row's `Manager's CARE email address` column automatically becomes `admin`, everyone else defaults to `user`, and you manually flip the 1-2 superadmins afterward via a DB update or seed script. Option (b) means zero sheet changes needed.
- **Manager linkage** uses email instead of an ID, which is actually simpler — just match `Manager's CARE email address` against another row's `CARE Email Address`.
- `office` (Nairobi, etc.) isn't in your columns either — if you need it on the form, either add a column or drop it from the `User` model and pull it from `Department` if that's close enough.

Updated `User` field mapping:

```js
{
  employeeNumber: row["No."],                 // or swap to email as the unique key — see above
  name: `${row["First Name"]} ${row["Last Name"]}`,
  email: row["CARE Email Address"],
  position: row["Job Title"],
  department: row["Department"],
  managerEmail: row["Manager's CARE email address"]  // resolved to managerId in a second pass
}
```

Build a small script (`scripts/importEmployees.js`) using `xlsx` (or `exceljs`/`csv-parse` if you keep it as `.csv`) that:
1. Reads all rows first and upserts every `User` by `email` (skip `managerId` for now — manager might not be imported yet).
2. Does a second pass: for each row, look up the `User` whose `email === row["Manager's CARE email address"]`, and set that as `managerId`.
3. Derives `role` as described above, unless you've added a `Role` column.

Run it manually whenever HR updates the sheet (re-running is safe since it upserts on `email`), or expose it as a superadmin-only `POST /api/admin/import-employees` endpoint that accepts an uploaded file, so the superadmin can re-sync without touching the server directly.

First-time import: since the sheet won't have passwords, generate a temp password or invite token per user and require a password set on first login.

### 2.2 `TravelRequest`

Mirrors the PDF form fields directly:

```js
{
  _id: ObjectId,
  requestedBy: { type: ObjectId, ref: "User", required: true },
  approver: { type: ObjectId, ref: "User", required: true }, // snapshot of requestedBy.managerId at creation time

  project: {
    name: String,          // e.g. "WE4R"
    businessUnit: String,  // e.g. "KEN03"
    fundCode: String,      // e.g. "DEC16"
    projectId: String,     // e.g. "CDEUKE3014"
    departmentId: String,  // e.g. "KE0201"
    activityId: String     // e.g. "3"
  },

  assignedAreaOfOperation: String,  // e.g. "Kisumu and Siaya"
  purposeOfTrip: String,

  modeOfTravel: {
    careVehicle: Boolean,
    publicTransport: Boolean,
    aircraft: Boolean
  },

  itinerary: {
    dateFrom: Date,
    dateTo: Date,
    destination: String,
    accommodationNeeded: Boolean
  },

  passengers: [{
    user: { type: ObjectId, ref: "User" },
    employeeNumber: String,
    name: String
  }],
  // Supports multi-passenger trips like the sample PDF (4 staff travelling together)

  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending"
  },
  decision: {
    decidedBy: { type: ObjectId, ref: "User" },
    decidedAt: Date,
    comment: String
  },

  version: { type: Number, default: 1 },        // increments on each resubmission
  history: [{                                     // snapshot of prior versions, for audit trail
    snapshot: Object,   // full copy of the editable fields before this edit
    status: String,     // status it had at time of edit (will be "rejected")
    decision: Object,
    editedAt: Date
  }],

  submittedAt: Date,
  createdAt, updatedAt
}
```

**Rejected → edit → resubmit flow:** when a request is `rejected`, the original requester (and only them) can `PATCH /api/requests/:id` to edit the editable fields (project info, itinerary, passengers, mode of travel, purpose). On save, the system pushes the current state into `history`, increments `version`, resets `status` to `pending`, clears `decision`, and re-notifies the approver. This keeps one request record per trip rather than spawning duplicates, while preserving the rejection trail for the superadmin's audit view.

### 2.3 `AuditLog` (optional but recommended — superadmin will want this)

```js
{
  _id: ObjectId,
  action: String,        // "request_created" | "request_approved" | "request_rejected"
  performedBy: ObjectId,
  targetRequest: ObjectId,
  metadata: Object,
  timestamp: Date
}
```

---

## 3. Approval Logic (the core rule)

- When a `user` or `admin` submits a request, the system looks up `requestedBy.managerId` and sets it as `approver`. This is fixed at submission time (a snapshot), so later org-chart changes don't retroactively alter who should have approved a past request.
- If an `admin` is the requester, their own manager (also an `admin`, presumably) approves — same mechanism, no special-casing needed.
- Only the `approver` field's user can act on a request — checked server-side, not just hidden in the UI.
- `superadmin` never appears as anyone's `approver` and has no approve/reject endpoints available to them at all (enforce at the route/middleware level, not just in the UI).

---

## 4. API Endpoints

Auth: `POST /api/auth/login` → JWT containing `{ userId, role }`.

### Requests
| Method | Route | Role | Behavior |
|---|---|---|---|
| POST | `/api/requests` | user, admin | Create request; `approver` auto-set from manager lookup |
| GET | `/api/requests` | user, admin, superadmin | Scoped: user → own only; admin → own + direct reports'; superadmin → all |
| GET | `/api/requests/:id` | user, admin, superadmin | Same scoping rules, 403 if out of scope |
| PATCH | `/api/requests/:id/approve` | admin | Only if `req.user.id === request.approver` |
| PATCH | `/api/requests/:id/reject` | admin | Same check, requires `comment` |
| PATCH | `/api/requests/:id` | user, admin | Edit + resubmit — only allowed if `status === "rejected"` and `req.user.id === request.requestedBy`; resets to `pending` |
| GET | `/api/requests/pending-my-approval` | admin | Convenience endpoint — requests where `approver === req.user.id` |

### Users (mostly superadmin/admin read access)
| Method | Route | Role | Behavior |
|---|---|---|---|
| GET | `/api/users/me` | all | Own profile |
| GET | `/api/users` | superadmin | Full list |
| GET | `/api/users/approvers` | all | Eligible approvers for selection |
| GET | `/api/users/passengers` | all | Eligible passengers for travel requests |
| GET | `/api/requests?scope=team` | admin | Team-scoped travel request list (direct reports + related trips) |

---

## 5. Access Control Middleware (the part to get right)

Two middleware layers:

1. **`requireRole(...roles)`** — gates whole routes (e.g., approve/reject is `requireRole("admin")`).
2. **`scopeRequestQuery`** — for list/read routes, builds the Mongo query based on role rather than trusting any client-supplied filter:
   - `user` → `{ requestedBy: req.user.id }`
   - `admin` → `{ $or: [{ requestedBy: req.user.id }, { approver: req.user.id }] }` (covers their own requests + their team's)
   - `superadmin` → `{}` (no filter)

For single-document GET/PATCH, re-check ownership/approver match against the fetched document — don't rely on the list-scoping logic alone, since someone could guess an ID.

---

## 6. Notifications

Two channels, triggered from the same event points (request created, approved, rejected, resubmitted):

**In-app:** a `Notification` collection, simplest possible shape:

```js
{
  _id: ObjectId,
  recipient: { type: ObjectId, ref: "User" },
  type: { type: String, enum: ["new_request", "approved", "rejected", "resubmitted"] },
  request: { type: ObjectId, ref: "TravelRequest" },
  message: String,
  read: { type: Boolean, default: false },
  createdAt: Date
}
```
Exposed via `GET /api/notifications` (own only) and `PATCH /api/notifications/:id/read`. Frontend can poll this or, later, upgrade to WebSockets/SSE — polling every 30–60s is plenty for a tool like this.

**Email:** use [Resend](https://resend.com) — sign up, verify a sending domain (or use their test domain while developing), grab an API key. Install with `npm install resend`. The helper is a few lines:

```js
import { Resend } from "resend";
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail(to, subject, html) {
  try {
    await resend.emails.send({ from: "travel@yourdomain.org", to, subject, html });
  } catch (err) {
    console.error("Email failed:", err); // never let this block the actual request action
  }
}
```

Call this from the same `notify(user, type, request)` helper that writes the in-app `Notification` row, so both channels fire together and can't drift out of sync.

Trigger map:
| Event | In-app + email to |
|---|---|
| Request created | the `approver` |
| Approved | the `requestedBy` |
| Rejected | the `requestedBy` |
| Resubmitted | the `approver` |

---

## 7. Suggested Build Order (for Cursor)

1. Mongoose models (`User`, `TravelRequest`, `Notification`, `AuditLog`)
2. Excel import script for employees/managers
3. Auth (login + JWT middleware + `requireRole`)
4. Request creation endpoint (with auto-approver lookup)
5. Scoped list/get endpoints
6. Approve/reject endpoints with ownership check
7. Edit + resubmit endpoint for rejected requests
8. Notification helper (in-app row + email) wired into the four trigger points
9. Audit logging hook on create/approve/reject/resubmit
10. (Later, if wanted) simple admin UI

---

## 8. One Thing to Confirm Before You Start

Sign up at resend.com, get an API key, and add it as `RESEND_API_KEY` in your `.env`. For sending, you can either verify your organization's domain (so emails come from `travel@careinternational.org`-style addresses — recommended, takes a few minutes via DNS records) or use Resend's shared test domain while developing.
