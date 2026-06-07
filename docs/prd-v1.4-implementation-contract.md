# PRD v1.4 Implementation Contract

This document is Step 1 only: contracts and verification plan. Do not implement a slice until the contract is reviewed and accepted.

## Current Baseline

- Runtime stack: Vite + React client, Express + TypeScript server, SQLite via `node:sqlite`.
- Existing persisted slices: authenticated account ownership, lists, tasks, subtasks, calendar task blocks, matrix classification, focus sessions, habits, countdowns, settings, desktop widgets, and account-scoped settings/export.
- The client API path is real HTTP only (`/api` with same-origin credentials). There is no localStorage-backed static API fallback in `client/src/api/client.ts`.

## Slice Order

1. Auth foundation and user-scoped data.
2. Task metadata: tags, reminders, recurrence, attachments, filters.
3. Goal module and task-tree auto scheduling.
4. Notification center and reminder execution.
5. Calendar completion: month view, holidays, ICS/system calendar read-only subscriptions.
6. Focus completion: rest cycles, background sounds, reports.
7. Habits completion: target types, reminders, details, archive/grouping.
8. Global search.
9. Import/export and migration preview.
10. Settings center completion: account, notification, focus, shortcuts, widgets, notes.
11. Desktop shell capabilities: widgets, global shortcuts, app lock, tray/startup.

Each slice must include an HTTP-to-SQLite integration test or a curl + database verification path.

## Slice 1: Auth Foundation And User-Scoped Data

### Data Model

```sql
users(
  id TEXT PRIMARY KEY,
  nickname TEXT,
  avatar_url TEXT,
  phone_masked TEXT,
  email_masked TEXT,
  status TEXT NOT NULL DEFAULT 'normal',
  registered_at TEXT NOT NULL,
  last_login_at TEXT,
  delete_requested_at TEXT,
  delete_scheduled_at TEXT
);

auth_identities(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('phone','email')),
  identifier_hash TEXT NOT NULL,
  display_identifier TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  unbound_at TEXT,
  UNIQUE(type, identifier_hash)
);

login_sessions(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT,
  platform TEXT,
  app_version TEXT,
  refresh_token_hash TEXT NOT NULL,
  login_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  refresh_token_expires_at TEXT NOT NULL,
  revoked_at TEXT
);

verification_codes(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('phone','email')),
  identifier_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',
  expires_at TEXT NOT NULL,
  resend_after_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

security_audit_logs(
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
```

Add `user_id TEXT NOT NULL` to:

- `lists`
- `tasks`
- `focus_sessions`
- `habits`
- `habit_checkins`
- `countdowns`
- `settings`
- `desktop_widgets`
- `desktop_shortcuts`
- `desktop_shell_state`
- `ai_generation_logs`
- `sticky_notes`

Change `settings` primary/unique behavior to `(user_id, key)`.

### API Contract

```http
GET /api/auth/session
200 { user, session }
401 { error:{ code:"unauthenticated", message:"请先登录" } }

POST /api/auth/verification-codes
body { type:"email"|"phone", identifier:string, purpose:"login" }
201 { challengeId, maskedIdentifier, expiresAt, resendAfterSec }
400 invalid_identifier
429 rate_limited
501 auth_delivery_not_configured when SMTP email delivery or optional SMS delivery is not configured

POST /api/auth/login
body {
  challengeId:string,
  code:string,
  agreedToTerms:boolean,
  device:{ deviceId:string, deviceName?:string, platform?:string, appVersion?:string }
}
200 { user, session, isNewUser:false }
201 { user, session, isNewUser:true }
400 invalid_code | code_expired | terms_required
423 account_restricted

POST /api/auth/refresh
200 { user, session }
401 invalid_refresh_token

POST /api/auth/logout
204

GET /api/account
200 { user }

PATCH /api/account
body { nickname?:string, avatarUrl?:string|null }
200 { user }

GET /api/account/sessions
200 { sessions:[{ id, deviceName, platform, loginAt, lastActiveAt, isCurrentDevice, revokedAt }] }

DELETE /api/account/sessions/:id
204
404 not_found
```

All existing business endpoints except `/api/health` and `/api/auth/*` require an authenticated session. Every read/write must be scoped by `req.user.id`.

SMTP email delivery is configured with `SMTP_HOST`, `SMTP_FROM`, and optionally `SMTP_PORT`, `SMTP_SECURE`, `SMTP_STARTTLS`, `SMTP_HELO`, `SMTP_USER`, and `SMTP_PASS`. Email verification must send through the configured SMTP provider; if the provider is missing or delivery fails, the inserted `verification_codes` row is removed and the API returns the real delivery error instead of exposing a usable code.

### Verification

Add `npm.cmd run test:auth`.

Expected coverage:

- `GET /api/tasks?view=today` without auth returns 401.
- Requesting a verification code creates a real `verification_codes` row.
- Logging in with a valid code creates `users`, `auth_identities`, and `login_sessions`.
- Startup session restore first checks `/api/auth/session`; if the access cookie is stale it falls back to `/api/auth/refresh` before showing the login screen.
- The client remembers only the last login method (`email` or `phone`) and never stores the full identifier.
- User A creates a task; User B cannot read it.
- `GET /api/settings/export` only exports the current user's rows.
- Logging out invalidates the session.

## Slice 2: Task Metadata

### Data Model

```sql
tags(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  parent_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, name)
);

task_tags(
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, tag_id)
);

task_reminders(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  snoozed_until TEXT,
  created_at TEXT NOT NULL
);

attachments(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Add to `tasks`:

- `recurrence_rule TEXT`
- `source TEXT`
- `manual_progress INTEGER`
- `pinned INTEGER NOT NULL DEFAULT 0`
- `status TEXT NOT NULL DEFAULT 'todo'`

### API Contract

- `GET/POST/PATCH/DELETE /api/tags`
- `POST /api/tasks/quick-parse` returns parse tokens and normalized task draft.
- `POST /api/tasks/:id/tags/:tagId`
- `DELETE /api/tasks/:id/tags/:tagId`
- `GET/POST/DELETE /api/tasks/:id/reminders`
- `POST /api/tasks/:id/attachments`
- `GET /api/attachments/:id/download`
- `GET /api/tasks?tagId=&priority=&from=&to=&status=&q=`
- `GET/POST/PATCH/DELETE /api/filters`

### Verification

HTTP test creates tags, attaches them to tasks, creates reminders and attachments, filters by tag and reminder time, and verifies rows in SQLite.

## Slice 3: Goals And Auto Scheduling

### Data Model

```sql
goals(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  start_at TEXT,
  deadline_at TEXT,
  total_estimated_minutes INTEGER,
  available_time_rule TEXT,
  progress_mode TEXT NOT NULL DEFAULT 'auto',
  status TEXT NOT NULL DEFAULT 'not_started',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Add to `tasks`:

- `goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL`
- `root_task_id TEXT`
- `level INTEGER NOT NULL DEFAULT 1`
- `planned_start_at TEXT`
- `planned_end_at TEXT`
- `actual_start_at TEXT`
- `actual_end_at TEXT`
- `dependency_task_ids TEXT`
- `auto_schedule_enabled INTEGER NOT NULL DEFAULT 1`
- `is_locked_schedule INTEGER NOT NULL DEFAULT 0`

### API Contract

- `GET/POST/PATCH/DELETE /api/goals`
- `GET /api/goals/:id/tree`
- `POST /api/goals/:id/tasks`
- `POST /api/goals/:id/auto-schedule`
- `POST /api/tasks/:id/dependencies`
- `DELETE /api/tasks/:id/dependencies/:dependencyId`

### Verification

Create a goal, create nested tasks, run auto-schedule, verify only lowest executable tasks get calendar blocks and locked tasks are not overwritten.

## Slice 4: Notifications

### Data Model

```sql
notifications(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  target_type TEXT,
  target_id TEXT,
  scheduled_at TEXT,
  delivered_at TEXT,
  read_at TEXT,
  action_state TEXT,
  created_at TEXT NOT NULL
);
```

### API Contract

- `GET /api/notifications`
- `POST /api/notifications/:id/read`
- `POST /api/notifications/:id/snooze`
- `POST /api/reminder-runner/tick` for local/dev verification

### Verification

Create a due reminder, run tick, verify a notification row and no duplicate notification on repeated tick.

## Slice 5: Calendar Completion

### Data Model

```sql
calendar_subscriptions(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  color TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  created_at TEXT NOT NULL
);

external_calendar_events(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES calendar_subscriptions(id) ON DELETE CASCADE,
  external_uid TEXT NOT NULL,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  is_all_day INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  UNIQUE(subscription_id, external_uid)
);
```

### API Contract

- `GET /api/calendar/events?from=&to=`
- `GET/POST/PATCH/DELETE /api/calendar/subscriptions`
- `POST /api/calendar/subscriptions/:id/sync`
- Month view is client-side over the same events range API.

### Verification

Subscribe to a fixture ICS URL/file, sync, verify events render in range and cannot be edited through task endpoints.

## Slice 6: Focus Completion

### Data Model

```sql
background_sounds(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  asset_url TEXT NOT NULL,
  license TEXT,
  created_at TEXT NOT NULL
);

user_sound_cache(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sound_id TEXT NOT NULL REFERENCES background_sounds(id),
  status TEXT NOT NULL,
  local_path TEXT,
  volume INTEGER NOT NULL DEFAULT 50,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, sound_id)
);
```

Add to `focus_sessions`:

- `background_sound_id TEXT`
- `background_sound_name TEXT`
- `background_volume INTEGER`
- `sound_played_duration INTEGER`
- `is_muted INTEGER`

### API Contract

- `GET /api/focus/sounds`
- `POST /api/focus/sounds/:id/cache`
- `DELETE /api/focus/sounds/:id/cache`
- `GET /api/focus/reports?range=day|week|month`
- Extend `POST /api/focus/sessions` with background sound fields.

### Verification

Start a focus session with a selected sound, verify session stores sound metadata and reports aggregate by day/week/month.

## Slice 7: Habits Completion

### Data Model Changes

Add to `habits`:

- `target_type TEXT NOT NULL DEFAULT 'check'`
- `target_value INTEGER`
- `target_unit TEXT`
- `start_date TEXT`
- `group_name TEXT`
- `reminder_time TEXT`

Add to `habit_checkins`:

- `value INTEGER`
- `note TEXT`

### API Contract

- `GET /api/habits/:id`
- `GET /api/habits/:id/stats?from=&to=`
- `POST /api/habits/:id/archive`
- `PATCH /api/habits/:id` supports target/reminder/group fields.

### Verification

Create count and timer habits, check in with values, verify streak and completion rate.

## Slice 8: Global Search

### API Contract

```http
GET /api/search?q=&types=tasks,lists,tags,habits,countdowns,goals
200 { results:[{ type, id, title, subtitle, matchedFields, updatedAt }] }
```

### Verification

Create one row per searchable type and verify scoped, ranked results only include current user data.

## Slice 9: Import And Export

### API Contract

- `POST /api/import/preview`
- `POST /api/import/commit`
- `GET /api/settings/export?format=json|csv`

Preview must return normalized rows, duplicate candidates, invalid rows, and no database writes. Commit writes only after explicit confirmation.

The settings center exposes the same contract in the "关联与导入" panel: the user can choose JSON or CSV, load a local file or paste content, preview duplicate and invalid rows, and only then confirm the import. The client always calls `/api/import/preview` and `/api/import/commit`; it never writes imported data to local state directly.

### Verification

`npm run test:import` uploads a fixture JSON/CSV through HTTP, verifies preview detects duplicates and invalid rows, verifies commit is rejected without confirmation, then commits and checks SQLite for the created task, list, tag, and goal rows. Client typecheck/build verify the settings UI is wired to the real import API.

## Slice 10: Settings Completion

### Settings Groups

Extend settings groups to include:

- account
- notifications
- focus
- quickAdd
- miniCalendar
- imports
- notes
- widgets
- shortcuts
- desktop

### API Contract

Existing `GET/PATCH /api/settings` remains, but validation must reject unknown groups/invalid values. Device shell state is stored through `/api/desktop/state` in `desktop_shell_state`.

### Verification

Patch every settings group, reload settings, confirm values persist and invalid values return 400.

## Slice 11: Sticky Notes

Sticky notes are real account-scoped records, not settings-only placeholders. A note can be standalone, linked to an existing task, or converted into a task after user confirmation.

### API Contract

- `GET /api/notes`
- `POST /api/notes`
- `POST /api/notes/from-task`
- `PATCH /api/notes/:id`
- `DELETE /api/notes/:id`
- `POST /api/notes/:id/restore`
- `POST /api/notes/:id/convert-to-task`

Notes persist title, body, color, opacity, font size, pinned state, desktop-like position, task linkage, timestamps, and soft-delete state. Converting a note creates a normal task with `source:"note"` and links the note back to that task.

### Verification

`npm run test:notes` logs in through SMTP email verification, creates a task-linked note, patches visual settings and position, creates a standalone note, converts it to a task, verifies user isolation, soft-deletes/restores, exports notes, and confirms `sticky_notes` plus converted task rows in SQLite.

## Slice 12: Desktop Shell Bridge

The current product has a real web bridge, not an Electron/Tauri host. It persists desktop intent locally and reports native host capability honestly:

- `GET /api/desktop/status`
- `PATCH /api/desktop/state`
- `GET /api/desktop/widget-templates`
- `GET/POST/PATCH/DELETE /api/desktop/widgets`
- `GET/POST/PATCH/DELETE /api/desktop/shortcuts`
- `POST /api/desktop/shortcuts/:id/register`
- `POST /api/desktop/app-lock/lock`
- `POST /api/desktop/app-lock/unlock`

`hostAvailable:false` and `capabilities.globalShortcuts:"host_required"` mean OS-level tray, startup registration, and global shortcut binding still require a future desktop host. The bridge persists widgets, shortcut registration requests, startup/tray/app-lock flags, and lock state in SQLite.

### Verification

`npm run test:desktop` logs in through SMTP email verification, writes desktop state/widgets/shortcuts through HTTP, exports desktop data, and confirms the rows in SQLite.

## Slice 13: AI Task Breakdown

AI task breakdown uses the user's saved OpenAI-compatible provider settings. It must not fabricate suggestions when the provider is not configured, and AI output must remain a proposal until the user explicitly creates subtasks.

### API Contract

- `POST /api/settings/ai/test`
- `POST /api/ai/task-breakdown`

`POST /api/ai/task-breakdown` accepts either `{ taskId, maxItems }` or `{ title, note, maxItems }` and returns `{ logId, suggestions }`, where each suggestion has `title`, optional `note`, optional `estimatedMinutes`, and `priority`. Missing or disabled AI config returns `409`; malformed provider output returns `502`.

The route calls `/chat/completions` on the configured provider with the stored API key, logs request metadata and parsed response in `ai_generation_logs`, and never stores the raw API key in logs.

### Verification

`npm run test:ai` logs in through SMTP email verification, confirms unconfigured AI returns 409, configures a real OpenAI-compatible test provider, verifies the provider receives the bearer token, parses subtask suggestions, creates accepted subtasks through the normal task API, and confirms `source='ai'` rows plus AI generation logs in SQLite.

## Slice 14: Account Deletion

Account deletion uses the same SMTP email provider as login, with a dedicated `account_delete` verification purpose. A deletion request must prove ownership of the current bound email, require explicit export acknowledgement, and enter a cooling period instead of immediately deleting data.

### API Contract

- `GET /api/account/deletion/preview`
- `POST /api/account/deletion/request`
- `POST /api/account/deletion/cancel`
- `POST /api/account/deletion/finalize-due`

`POST /api/account/deletion/request` requires `{ challengeId, code, confirmText:"DELETE", exportAcknowledged:true }`. It revokes active sessions and marks the user as `deleting` with a scheduled deletion time. `finalize-due` is runner-token protected and anonymizes the user row while deleting account-owned rows.

### Verification

`npm run test:account` runs against a local SMTP test server, verifies missing and mismatched codes fail, requests deletion with the bound email code, confirms the old session is revoked, then finalizes a due deletion and checks SQLite rows for tasks, notes, identities, and anonymized user data.

## Slice 15: Notification Preferences And Do Not Disturb

Notification preferences are account-scoped settings. Reminder delivery must honor the global notification switch and do-not-disturb window instead of creating unread notifications silently.

### API Contract

Existing `GET/PATCH /api/settings` supports:

- `notifications.enabled`
- `notifications.email`
- `notifications.desktop`
- `notifications.doNotDisturb`
- `notifications.doNotDisturbStart` as `HH:mm`
- `notifications.doNotDisturbEnd` as `HH:mm`
- `notifications.completionSound` as `ding | none`

`POST /api/reminder-runner/tick` returns `{ created:0, notifications:[] }` without mutating reminder rows while notifications are disabled or the current local time falls inside the do-not-disturb window. Once the window ends, due scheduled reminders can be delivered normally.

### Verification

`npm run test:notifications` patches notification settings, verifies the persisted values, creates a due reminder during an all-day do-not-disturb window, confirms no notification row is created and the reminder remains deliverable, then disables do-not-disturb and confirms the pending reminder is delivered.

## Slice 16: About, Legal Documents, And Update Check

The About page must not use placeholder links. Legal documents are local versioned product artifacts, and update checks use a configured manifest URL. If no update manifest is configured, the server returns 501 instead of pretending that no update exists.

### API Contract

- `GET /api/about/legal/terms` returns Markdown user terms.
- `GET /api/about/legal/privacy` returns Markdown privacy policy.
- `GET /api/about/update-check?currentVersion=` fetches `APP_UPDATE_MANIFEST_URL` and returns `{ currentVersion, latestVersion, updateAvailable, downloadUrl, releaseNotes, checkedAt }`.
- `GET /api/about/licenses` parses the current `package-lock.json` and returns `{ source, generatedAt, packageCount, packages:[{ name, version, license, dev, optional, resolved }] }`.
- `POST /api/about/diagnostic-logs` requires an authenticated account and explicit `{ consent:true }`, writes a scrubbed diagnostic JSON file plus a SQLite row, and returns `{ upload }`.

### Verification

`npm run test:about` starts a local update manifest server, verifies both legal document routes return real Markdown content, verifies update-check reads the manifest and reports an available newer version, verifies open-source licenses are derived from `package-lock.json` by checking real Express and React license entries, and verifies diagnostic-log upload requires auth/consent and writes scrubbed logs to SQLite/filesystem.

## Slice 17: Account Identity Binding

Email binding uses the configured SMTP provider with a dedicated `account_bind` verification purpose. Phone login and phone binding use a configured HTTP SMS provider. OAuth login and binding use a configured OAuth/OIDC UserInfo endpoint. Existing identities remain usable login methods until explicitly unbound.

### API Contract

- `GET /api/account/identities`
- `POST /api/account/email/bind`
- `POST /api/account/phone/bind`
- `POST /api/auth/oauth/:provider/login`
- `POST /api/account/oauth/:provider/bind`
- `DELETE /api/account/identities/:id`

`POST /api/account/email/bind` requires `{ challengeId, code }` from an `account_bind` email verification. `POST /api/account/phone/bind` requires `{ challengeId, code }` from an `account_bind` phone verification delivered through `SMS_PROVIDER_URL`. If the identity is already actively bound to another account, it returns 409. Successful binding updates `users.email_masked` or `users.phone_masked`, marks the new identity primary for its type, and preserves all active identities for login.

`POST /api/auth/oauth/:provider/login` and `POST /api/account/oauth/:provider/bind` require `{ accessToken }`. The server validates the token by calling `OAUTH_<PROVIDER>_USERINFO_URL` with `Authorization: Bearer <token>`, reads the subject from `sub` by default, and stores only the hashed provider subject plus masked display identifier. Missing provider configuration returns 501.

`DELETE /api/account/identities/:id` soft-unbinds an identity by setting `unbound_at`. It returns 409 when it would remove the account's last active login method.

### Verification

`npm run test:account-bind` logs in via SMTP, binds a second email via SMTP `account_bind`, verifies the new email logs into the same account, verifies another user's email cannot be bound, binds a phone through a real HTTP SMS provider, verifies phone login maps to the same account, verifies phone binding conflicts return 409, verifies identity unbind keeps at least one login method, and checks active / unbound identities in SQLite. `npm run test:oauth` starts a real local UserInfo HTTP service, verifies OAuth registration, repeat login, account binding, conflict handling, and OAuth unbind behavior through SQLite. `npm run test:auth` verifies phone verification returns 501 when no SMS provider is configured.

## Slice 18: List Folders And Task Batch Operations

List folders are account-scoped records that group multiple custom lists and persist collapsed state. Batch operations act only on tasks owned by the current account and reuse normal task update/delete/restore behavior.

### API Contract

- `GET /api/lists/folders`
- `POST /api/lists/folders`
- `PATCH /api/lists/folders/:id`
- `DELETE /api/lists/folders/:id`
- `POST /api/lists` accepts optional `folderId`
- `PATCH /api/lists/:id` accepts `folderId`
- `POST /api/tasks/batch`

`POST /api/tasks/batch` accepts `{ taskIds, action, patch }`, where `action` is `update | delete | restore | purge`. Batch update currently supports date, priority, list move, status/completion, and other existing task patch fields. A request containing another user's task returns 404.

### Verification

`npm run test:list-batch` logs in through SMTP, creates a folder and grouped list, persists collapsed state, batch-moves/completes/prioritizes two tasks, verifies another user cannot batch them, batch-deletes/restores them, deletes the folder, and checks SQLite for moved tasks and removed folder rows.

## Slice 19: AI Quadrant Suggestions

AI quadrant suggestions use the same saved OpenAI-compatible provider settings as task breakdown. Suggestions are advisory only: the task's `isImportant` / `isUrgent` fields change only after the user explicitly accepts the suggestion.

### API Contract

- `POST /api/ai/quadrant-suggestion`

Input is `{ taskId }`. The response is `{ logId, taskId, current, suggestion }`, where suggestion includes `isImportant`, `isUrgent`, `confidence`, and `reason`. Missing AI configuration returns 409; missing task returns 404; malformed provider output returns 502.

### Verification

`npm run test:ai` now also verifies quadrant suggestions: an OpenAI-compatible test provider returns a JSON quadrant recommendation, the route logs `quadrant_suggestion`, the task remains unchanged until the test applies the recommendation through the normal task patch API, and SQLite confirms both AI logs and accepted task flags.

## Slice 20: AI Weekly Review

AI weekly review aggregates current-account tasks, focus sessions, habit check-ins, and goal status before calling the configured OpenAI-compatible provider. The route is read-only: it produces a structured review and logs generation metadata, but does not write tasks or schedule changes.

### API Contract

- `POST /api/ai/weekly-review`

Input accepts optional `{ from, to }` ISO timestamps. Missing range defaults to the last seven local days. The response includes `{ logId, range, metrics, summary, wins, risks, suggestions, nextActions }`. Missing AI configuration returns 409; malformed provider output returns 502.

### Verification

`npm run test:ai` now creates task and focus data, calls the OpenAI-compatible test provider for weekly review, verifies the returned structured review and metrics, and confirms `ai_generation_logs` stores the review without raw API keys.

## Slice 21: AI Smart Scheduling

AI smart scheduling uses the saved OpenAI-compatible provider settings and is advisory only. The route reads current goal tasks plus external calendar events in the requested window, returns schedule proposals, and never mutates tasks until the user explicitly accepts a proposal through the normal task update API.

### API Contract

- `POST /api/ai/schedule-suggestion`

Input accepts `{ goalId?, taskIds?, from?, to? }`. When `goalId` is provided, the backend uses open, undeleted tasks under that goal. When `taskIds` is provided, every task must belong to the current account. If neither is provided, the backend uses open dated tasks in the current account. The response is `{ logId, goalId, range, suggestions }`, where each suggestion has `taskId`, `title`, `plannedStartAt`, `plannedEndAt`, and `reason`. Missing AI configuration returns 409; missing tasks return 404; malformed provider output returns 502.

### Verification

`npm run test:ai` now also creates a goal task and an external ICS event, calls the OpenAI-compatible test provider for scheduling, verifies the provider receives calendar context, confirms the task is unchanged before acceptance, applies the proposal through `PATCH /api/tasks/:id`, and checks `planned_start_at` / `planned_end_at` plus `schedule_suggestion` logs in SQLite.

## Slice 22: Lunar Calendar, Holidays, And Adjusted Workdays

Calendar date metadata is a real backend source instead of hard-coded UI labels. Lunar labels are computed from the runtime Chinese lunar calendar, and built-in China 2026 public holidays / adjusted workdays are based on the State Council 2026 holiday notice.

### API Contract

- `GET /api/calendar/day-info?from=&to=`

The route requires authentication and returns `{ days }`. Each day includes `date`, `lunarLabel`, `holidayName`, `holidayType`, `isOffDay`, `isAdjustedWorkday`, and `source`. Supported holiday source data currently covers the official 2026 China public holiday and adjusted-workday schedule. Ranges over 371 days return 400.

Settings `datetime.showLunar` and `datetime.showHolidayAdjustments` control whether the calendar header renders lunar labels and holiday / adjusted-workday badges.

### Verification

`npm run test:calendar` now verifies Spring Festival 2026 public-holiday and adjusted-workday metadata plus the lunar new-year label. `npm run test:settings` verifies the two datetime display toggles persist and reject invalid non-boolean values.

## Slice 23: Calendar Month View And View Memory

Calendar view selection is stored in the account-scoped settings table, not browser-only local state. The month view uses the same task range API, external calendar event API, and day-info API as the day / 3-day / week views.

### API Contract

Existing `GET/PATCH /api/settings` supports:

- `calendar.view` as `day | 3day | week | month`

The calendar client updates this setting whenever the user changes the view. Invalid values return 400.

### Verification

`npm run test:calendar-ui` verifies month range generation produces a 42-day grid aligned to the user's configured week start. `npm run test:settings` verifies `calendar.view` persists and rejects invalid values. Client build verifies the month grid renders against the existing task, external-event, and day-info contracts.

## Slice 24: Schedule Panel Grouping And Filtering

The calendar "arrange tasks" side panel uses real undated tasks and existing list/tag metadata. It can group by list, tag, or priority, and text filtering searches task title, note, and tag names. Dragging still uses the existing task scheduling flow.

### Contract

No new backend route is required. The client reads:

- `GET /api/tasks?view=undated`
- `GET /api/lists`
- `GET /api/tags`

The grouping helper returns stable groups with the current task objects, preserving the normal drag-and-drop task IDs.

### Verification

`npm run test:schedule-panel` verifies grouping by list, tag, and priority plus text filtering. Client build verifies the panel compiles against the real API DTOs.

## Slice 25: Product Analytics Event Pipeline

Product analytics events are separate from `security_audit_logs`. The analytics pipeline accepts login-page events before authentication, scopes events to `userId` / `sessionId` when a valid session cookie exists, and scrubs sensitive values before persistence. Raw phone numbers, email addresses, verification codes, tokens, API keys, passwords, and third-party identifiers must not be stored in `properties_json`.

### API Contract

- `POST /api/analytics/events`

The route accepts either a single event object or `{ events: [...] }`. Each event requires `name` and may include `properties`, `occurredAt`, `anonymousId`, `deviceId`, and `source`. Event names must be lowercase analytics identifiers such as `auth_page_view`, `auth_code_send`, `auth_login_success`, `setting_page_view`, or `auth_binding_result`. The server returns `{ accepted }` with status 202.

Server-side auth routes also emit key account events:

- `auth_code_send`
- `auth_code_verify`
- `auth_login_success`
- `auth_register_success`
- `auth_third_party_result`
- `auth_token_refresh`
- `auth_logout_success`
- `auth_binding_result`
- `auth_unbind_result`
- `auth_device_logout`
- `auth_delete_account_confirm`
- `auth_delete_account_cancel`

### Verification

`npm run test:analytics` starts a real SMTP server, posts an unauthenticated login-page event, exercises email code login including a failed verification attempt, posts an authenticated settings event, logs out, and queries SQLite to verify event names, user/session scoping, data export inclusion, and sensitive-property scrubbing.

## Slice 26: Offline Task Sync Queue

Offline-capable edits are represented as durable client operations and applied to real account data when connectivity returns. The first supported vertical slice is task creation / update / soft-delete. Each operation carries a stable `clientOperationId`; replays are idempotent and do not duplicate writes. Update and delete operations may send `baseUpdatedAt`; if the server task has changed since that timestamp, the server returns a `conflict` result with the current server task instead of silently overwriting data.

### Data Model

`sync_operations` stores `{ userId, clientOperationId, entityType, entityId, action, status, baseUpdatedAt, clientCreatedAt, payloadJson, resultJson, error, receivedAt, appliedAt }` with a unique key on `(userId, clientOperationId)`.

### API Contract

- `POST /api/sync/operations`

Input is `{ operations: [...] }`, up to 50 operations. The supported shape is:

```json
{
  "clientOperationId": "stable-client-id",
  "entityType": "task",
  "action": "create | update | delete",
  "entityId": "task-id-for-update-delete",
  "baseUpdatedAt": "optional previous Task.updatedAt",
  "clientCreatedAt": "client timestamp",
  "payload": {}
}
```

The response is `{ results }`. Each result has `status` as `applied | duplicate | conflict | failed`, plus `task`, `conflict`, or `error` details.

The web client now keeps a per-user localStorage queue for offline quick-add task creation. A network failure enqueues a task operation under the current `userId`; the queue flushes through `/api/sync/operations` when the browser reports `online`.

### Verification

`npm run test:sync` logs in through SMTP, applies an offline task create through the sync endpoint, replays the same client operation to prove idempotency, applies an update, verifies stale updates return conflict, verifies another user cannot sync against the first user's task, soft-deletes through sync, checks export inclusion, and queries SQLite for `sync_operations` statuses plus the real task row.

## Slice 27: OAuth Authorization Code And PKCE Login

Third-party login now supports the browser authorization-code flow instead of requiring a pasted access token. The server creates a one-time OAuth state, stores the PKCE code verifier in SQLite, builds the provider authorization URL, exchanges the callback code with the provider token endpoint, and then reuses the real UserInfo login path. Missing provider configuration returns 501.

### Data Model

`oauth_login_states` stores `{ state, provider, userId, purpose, codeVerifier, redirectUri, scope, createdAt, expiresAt, consumedAt }`. A state expires after 10 minutes and can be consumed only once. Login states use `purpose='login'` and no `userId`; account-binding states use `purpose='account_bind'` plus the current `userId`.

### API Contract

- `POST /api/auth/oauth/:provider/authorize`

Input is `{ redirectUri, scope? }`. Required environment variables are `OAUTH_<PROVIDER>_AUTHORIZE_URL`, `OAUTH_<PROVIDER>_TOKEN_URL`, `OAUTH_<PROVIDER>_CLIENT_ID`, and `OAUTH_<PROVIDER>_USERINFO_URL`; `OAUTH_<PROVIDER>_CLIENT_SECRET` and `OAUTH_<PROVIDER>_SCOPE` are optional. The response is `{ authorizationUrl, state, expiresAt }`; the authorization URL includes `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, and `code_challenge_method=S256`.

- `POST /api/auth/oauth/:provider/callback`

Input is `{ state, code, redirectUri, agreedToTerms, device }`. The route validates the stored state, exchanges the code with the provider token endpoint using the stored PKCE verifier, fetches UserInfo through the exchanged access token, creates or loads the user, sets real auth cookies, and returns `{ user, session, isNewUser }`.

The existing access-token endpoint remains available for provider-side integrations and account binding:

- `POST /api/auth/oauth/:provider/login`
- `POST /api/account/oauth/:provider/bind`

Account settings also support an authorization-code binding flow:

- `POST /api/account/oauth/:provider/authorize`
- `POST /api/account/oauth/:provider/callback`

The account authorize route requires a signed-in session and stores the OAuth state against the current `userId`; the callback rejects states that belong to a different account before calling the provider token endpoint.

### Verification

`npm run test:oauth` starts a local OAuth provider with real `/token` and `/userinfo` routes, verifies the generated authorization URL and PKCE parameters, completes an authorization-code login through HTTP, rejects state replay, binds a third-party account through account-scoped PKCE, verifies another signed-in user cannot consume that binding state, checks the exchanged token was used for UserInfo, and queries SQLite for consumed OAuth state plus OAuth identity counts.

## Slice 28: Task Checklist Items

Tasks now support lightweight checklist items in addition to full subtasks. Checklist items are account-scoped rows, affect task progress when the task has no subtasks, and can be converted into a real subtask when a lightweight item needs its own task lifecycle.

### Data Model

`task_checklist_items` stores `{ id, userId, taskId, title, completed, sortOrder, convertedTaskId, createdAt, updatedAt }`. `convertedTaskId` links to the generated subtask after conversion.

### API Contract

- `GET /api/tasks/:id/checklist`
- `POST /api/tasks/:id/checklist`
- `PATCH /api/tasks/:id/checklist/:itemId`
- `DELETE /api/tasks/:id/checklist/:itemId`
- `POST /api/tasks/:id/checklist/:itemId/convert-to-subtask`

Checklist creation requires `{ title }`; patch accepts `{ title?, completed?, sortOrder? }`. Conversion creates a child task with `source='checklist'`, inherits the parent list and priority, preserves completed state, stores the generated task id on the checklist item, and is idempotent on repeat calls.

Task DTOs now include `checklistTotal` and `checklistDone`; when a task has no subtasks, `rollupProgress` is derived from checklist completion.

### Verification

`npm run test:checklist` logs in through SMTP, creates a task, creates and completes checklist items through HTTP, verifies another user cannot access them, converts a completed item into a real subtask, verifies idempotent conversion, exports checklist data, and queries SQLite for `task_checklist_items` plus the converted task row.

## Slice 29: Task Activity History

Task details now include a real personal activity history instead of relying on global security audit logs. Core task operations and task-owned metadata changes write account-scoped activity rows.

### Data Model

`task_activity_logs` stores `{ id, userId, taskId, action, summary, detailsJson, createdAt }`. `taskId` is intentionally not a foreign key so a trash/purge action can still leave an exportable history row until account deletion.

### API Contract

- `GET /api/tasks/:id/activity?limit=`

The route requires authentication, verifies the task belongs to the current account, and returns `{ activities }` ordered newest first. Each activity has `{ id, taskId, action, summary, details, createdAt }`. `limit` is clamped to `1..200`.

Activities are written for task create/update/complete/reopen/delete/restore/purge, checklist create/update/complete/reopen/delete/convert-to-subtask, tag add/remove, reminder add/delete, attachment add, and dependency add/remove.

### Verification

`npm run test:activity` logs in through SMTP, creates and edits a task, completes it, creates/completes/converts a checklist item, adds a reminder and attachment, deletes/restores the task, verifies another user cannot read the history, exports activity logs, and queries SQLite for action rows plus structured `details_json`.

## Slice 30: Local Cache Cleanup

Account settings now expose a real local-cache cleanup path for the cache types that exist in the product today. Background sound cache is persisted in `user_sound_cache`; the browser offline-sync queue is stored per user in localStorage. Attachment cache is reported as `0` until a separate local attachment-cache layer exists, because attachments are currently account data rather than disposable local cache.

### API Contract

- `GET /api/account/local-cache`
- `POST /api/account/local-cache/clear`

Both routes require authentication. The preview response is `{ cache }` with `{ soundCacheCount, soundCacheBytes, attachmentCacheCount, attachmentCacheBytes }`. The clear route deletes current-account sound cache rows and returns `{ cache }` with the remaining counts plus `{ soundCacheCleared, attachmentCacheCleared, clearedAt }`.

The web settings page combines that server result with the current account's browser offline queue count from `efficiency-list.syncQueue.<userId>`, asks for confirmation, clears that localStorage queue, calls the server clear route, and records `auth_cache_clear`.

### Verification

`npm run test:cache` logs in two users through SMTP, caches different background sounds, verifies Alice's cache preview, clears Alice's local cache, confirms Bob's cache remains, and queries SQLite for `user_sound_cache` isolation plus the `auth_cache_clear` analytics event.

## Slice 31: Trash Retention And Empty Trash

The trash view now has real cleanup operations instead of only per-task permanent deletion. Deleted tasks remain recoverable until the user empties the trash or explicitly purges items beyond the retention window.

### API Contract

- `GET /api/tasks/trash/summary?retentionDays=`
- `POST /api/tasks/trash/purge-expired`
- `POST /api/tasks/trash/empty`

All routes require authentication and operate only on the current account. The summary response is `{ trash }` with `{ trashCount, expiredCount, retentionDays, oldestDeletedAt }`; `retentionDays` defaults to 30 and must be an integer from 1 to 3650. `purge-expired` deletes only tasks whose `deleted_at` is older than the retention window, while `empty` deletes all current-account trash rows. Both cleanup routes return `{ trash }` plus `{ purgedCount, clearedAt }` and write task activity rows for audit/export.

The web trash view exposes "清理 30 天前" and "清空垃圾桶" actions. Empty trash requires browser confirmation; neither action touches active tasks or another account's deleted tasks.

### Verification

`npm run test:trash` logs in two users through SMTP, soft-deletes tasks for both users, backdates one Alice trash row beyond 30 days, verifies summary counts and invalid retention validation, purges expired trash, empties Alice's remaining trash, and checks SQLite that Alice's active task and Bob's trash row remain while Alice's trash rows are removed.

## Slice 32: Sticky Note Defaults

Sticky note settings now drive real note creation defaults instead of acting as a module-only toggle. Defaults are account-scoped settings and are applied by the server when a note is created directly or generated from a task.

### Settings Contract

The `notes` settings group stores `{ enabled, defaultColor, defaultOpacity, defaultFontSize, defaultPinned, defaultPosition }`. `defaultColor` must be a hex color, `defaultOpacity` is `20..100`, `defaultFontSize` is `small | normal | large | xlarge`, and `defaultPosition` enforces minimum note dimensions.

The settings center exposes these controls in a dedicated "便签" category. The notes module creates a new note without hard-coded color so the backend defaults are authoritative.

### Verification

`npm run test:notes` patches note defaults through `/api/settings`, creates a note from a task and a standalone note through HTTP, verifies both inherit the configured defaults, patches one note, converts the other to a task, and checks SQLite for the persisted sticky-note rows. `npm run test:settings` verifies invalid note settings are rejected.

## Slice 33: Pomodoro Focus Defaults

Pomodoro settings are now a dedicated account-scoped settings group instead of hard-coded timer values in the client. New focus sessions can inherit the account defaults from the server when the client does not explicitly send background sound fields.

### Settings Contract

The `focus` settings group stores `{ defaultMinutes, restMinutes, soundId, defaultVolume, pauseSoundOnPause, playSoundDuringRest, backgroundAudioAllowed, autoCacheSounds }`. Durations must be positive integers, `soundId` must be `null` or an existing background sound id, `defaultVolume` is `0..100`, and behavior flags are booleans.

The settings center exposes a "番茄专注" category for these defaults. The focus module reads the same settings to initialize the timer, selected background sound, and default volume. The `POST /api/focus/sessions` route also applies `focus.soundId` and `focus.defaultVolume` when `backgroundSoundId` / `backgroundVolume` are omitted, so persisted focus records match account defaults even for non-UI clients.

### Verification

`npm run test:focus` patches focus defaults through `/api/settings`, creates a focus session without explicit sound fields, verifies the session inherits the default background sound and volume, checks report/export behavior, and queries SQLite for the persisted sound metadata. `npm run test:settings` verifies invalid focus volume and unknown sound ids are rejected.

## Slice 34: Desktop Shortcut Defaults And Conflicts

Shortcut settings now expose the PRD default shortcut scheme through the real desktop bridge instead of relying on free-form rows only. The settings center has dedicated "桌面小部件" and "快捷键" categories, plus a settings search input that can find categories by setting names such as reminders, shortcuts, and default date.

### API Contract

- `GET /api/desktop/shortcut-templates`
- `POST /api/desktop/shortcuts/reset`

Shortcut templates return the default PRD shortcut actions, labels, accelerators, and priority. Reset deletes the current account's stored shortcut rows and recreates the seven default shortcuts in SQLite. Creating or updating shortcuts rejects duplicate actions, duplicate accelerators, and reserved system accelerators such as `Ctrl+Alt+Delete` with `409`.

The web bridge still reports `hostAvailable:false` and `globalShortcuts:"host_required"`; registering a shortcut persists the request and does not claim OS-level binding.

### Verification

`npm run test:desktop` logs in through SMTP email verification, creates a shortcut, verifies duplicate actions and accelerator conflicts fail, verifies reserved accelerators fail, fetches templates, resets defaults, registers a default shortcut, exports desktop data, and confirms the seven default shortcut rows plus the registration timestamp in SQLite.

## Slice 35: Desktop Widget Templates

Desktop widgets now use explicit PRD templates instead of arbitrary free-form widget types. The current web bridge still persists widget intent in SQLite and does not claim an OS desktop host.

### API Contract

- `GET /api/desktop/widget-templates`
- Existing `POST/PATCH /api/desktop/widgets`

`GET /api/desktop/widget-templates` returns six widget templates:

- `today-tasks` / 今日任务 / P1
- `inbox-quick-add` / 收集箱 / P2
- `habit-checkin` / 习惯打卡 / P2
- `focus-timer` / 番茄计时 / P2
- `goal-progress` / 目标进度 / P2
- `countdowns` / 倒数日 / P2

Each template includes `defaultTitle`, `defaultConfig`, and `defaultPosition`. Creating or updating a widget rejects unknown widget types and invalid type-specific config with `400`. Valid widgets still persist in `desktop_widgets` and appear in settings export.

The settings center's dedicated "桌面小部件" category loads these templates from the backend, lets the user choose a widget type, and creates the widget through the real API.

### Verification

`npm run test:desktop` logs in through SMTP email verification, fetches the widget templates, verifies all six PRD widget types are present, rejects an unknown widget type, rejects invalid focus-timer config, creates `today-tasks` and `countdowns` widgets through HTTP, patches one widget, exports desktop data, and confirms the widget rows/configs in SQLite.

## Slice 36: Notification Permission Guidance

System notification permission is a local device/browser state, not an account preference. The backend stores only the permission state reported by the real client runtime and never fabricates OS notification access.

### Data Model

`notification_permissions` stores `{ userId, permission, status, promptReason, lastPromptedAt, updatedAt }`.

`status` is one of `unknown | default | granted | denied | unsupported`. `unknown` is returned before a device reports its browser/system permission. `promptReason` is one of `settings | task_reminder | habit_reminder | focus_reminder`.

### API Contract

- `GET /api/notifications/permission`
- `POST /api/notifications/permission`

`GET` returns `{ permission }` with `{ permission:"system-notifications", status, promptReason, lastPromptedAt, updatedAt, shouldPrompt, guidance }`. `guidance` is `request_when_needed | enabled | blocked | unsupported`.

`POST` accepts `{ status, promptReason? }` and persists the current device/browser permission status. Invalid statuses or prompt reasons return `400`.

The settings center reads the real browser `Notification.permission`, reports it to the backend, shows the current permission guidance, and only calls `Notification.requestPermission()` when the user explicitly enables/requests desktop notifications.

### Verification

`npm run test:notifications` logs in through SMTP email verification, verifies the initial permission state is `unknown`, rejects invalid permission status, persists `default` with prompt reason, updates to `denied` while preserving the prompt timestamp, exports the permission row, and confirms the row in SQLite alongside the existing reminder notification flow.

## Slice 37: Task Creation Defaults

Task defaults are now account-scoped settings that the backend applies when a task creation request omits the relevant fields. The server remains the source of truth, so API clients that only send `{ title }` receive the same default date, time block, priority, list, and reminder behavior as the web UI.

### Settings Contract

`taskDefaults` stores:

- `priority`
- `listId`
- `defaultDate`: `none | today | tomorrow | custom`
- `customDate`
- `dateMode`: `date | timeBlock | allDay`
- `defaultTimeBlockMinutes`: `15 | 30 | 45 | 60`
- `defaultTimeBlockStart`: `HH:mm`
- `timedReminder`: `none | at_start | 5m_before | 30m_before | custom`
- `timedReminderCustomMinutes`
- `allDayReminder`: `none | 1d_before | same_day`
- `allDayReminderTime`: `HH:mm`

Invalid enum values, invalid times, invalid custom dates, and default list ids outside the current account return `400`.

### Task Creation Behavior

`POST /api/tasks` now distinguishes omitted fields from explicit `null`. When `dueDate`, `startDate`, and `isAllDay` are omitted, the server applies `taskDefaults`:

- `dateMode:"timeBlock"` creates a timed task using `defaultTimeBlockStart` and `defaultTimeBlockMinutes`.
- `dateMode:"date"` and `dateMode:"allDay"` create an all-day/date task on the default date.
- Timed tasks can receive a default reminder relative to `startDate`.
- All-day/date tasks can receive a default reminder at `allDayReminderTime`.

Internal conversions such as checklist-to-subtask pass explicit `null` values and therefore do not accidentally inherit account defaults.

The settings center exposes these controls in the dedicated "任务默认值" category.

### Verification

`npm run test:settings` patches task default settings, creates tasks through HTTP with only `{ title }`, verifies timed and all-day defaults on the returned task DTOs, confirms default reminders are created, rejects invalid default durations and list ids, and checks the `task_reminders` rows in SQLite. `npm run test:metadata`, `npm run test:checklist`, and `npm run test:goals` verify the shared task creation path did not regress metadata or internal subtask/goal creation.

## Slice 38: Quick Add Recognition And Default Tags

Quick-add recognition is now account-scoped instead of hard-coded in the client. The backend reads the current user's `quickAdd` settings when `POST /api/tasks/quick-parse` runs, and task creation applies account default tags from the shared `createTask` path.

### Settings Contract

`quickAdd` stores:

- `parseEnabled`
- `dateRecognition`
- `removeDateText`
- `tagRecognition`
- `removeTagText`
- `urlParsing`

Defaults match the PRD quick-add settings: date and tag recognition are on, date text is kept, recognized tag text is removed from the title, and URL parsing is on.

`taskDefaults.defaultTagIds` stores the default tag ids for new top-level tasks. Every id must belong to the current account; invalid or duplicate ids return `400`.

### API Behavior

`POST /api/tasks/quick-parse` now accepts optional `options` overrides, but otherwise uses the saved account settings. It parses Chinese relative dates and natural time such as `明天下午3点`, recognizes `#标签` and priority tokens, and cleans the title according to the remove-date/remove-tag toggles.

`POST /api/tasks` accepts optional `tagIds`. If `tagIds` is omitted for a top-level task, the server attaches `taskDefaults.defaultTagIds` during creation. Explicit `tagIds: []`, subtasks, imports, and note-to-task conversion do not accidentally inherit default tags.

### Client Behavior

The settings center exposes quick-add parsing toggles in "更多设置" and default tag selection in "任务默认值". The task quick-add UI still calls real `/api/tasks/quick-parse` and real tag/task APIs; it no longer forces null date fields when parsing finds no date, so backend task defaults can still apply.

### Verification

`npm run test:settings` saves quick-add toggles and default tags, verifies default quick-parse keeps date text while removing tag text, verifies the cleanup toggles can invert that behavior, creates a task through HTTP and confirms the default tag is present on the DTO and in SQLite `task_tags`, and rejects invalid default tag ids. `npm run test:metadata`, `npm run test:import`, and `npm run test:checklist` cover the quick-parse override path and guard against regressions in shared task creation, import, and internal checklist conversion.

## Slice 39: Quick Add URL Title Parsing

MORE-05 is implemented as real backend URL title resolution. When quick-add text is exactly an `http://` or `https://` URL and `quickAdd.urlParsing` is enabled, `POST /api/tasks/quick-parse` fetches the page, extracts the HTML `<title>`, uses that as `draft.title`, returns a `url` token, and preserves the original URL in `draft.note` so task creation does not lose the link.

### Failure Behavior

The route does not invent placeholder titles:

- non-2xx URL responses return `502 url_title_fetch_failed`
- non-HTML responses return `415 url_title_unsupported_content`
- HTML without a title returns `422 url_title_missing`
- fetch/network failures return `502 url_title_fetch_failed`

When `quickAdd.urlParsing` is disabled, the same URL remains the task title and `draft.note` stays `null`.

### Client Behavior

The settings center exposes the "网址解析" switch under "更多设置". The task quick-add UI forwards the backend `draft.note` to `POST /api/tasks`, so a successfully resolved URL creates a task titled with the real page title and keeps the URL in the task note.

### Verification

`npm run test:settings` starts a local HTTP page fixture, calls `/api/tasks/quick-parse` with that real URL, verifies the fetched HTML title, `url` token, and preserved note, verifies a 404 page returns `502`, and verifies disabling URL parsing keeps the original URL as the title. `npm run test:metadata` confirms the existing quick-parse override path still works, and the client build verifies the task quick-add note handoff compiles.

## Slice 40: Task Insert And Overdue Position

DEF-09 and DEF-10 are now account-scoped task default settings backed by real task ordering data. Top-level tasks receive a `sort_order` when created, and list/inbox queries use that stored order instead of pretending with creation time.

### Settings Contract

`taskDefaults` now also stores:

- `addPosition`: `top | bottom`
- `overduePosition`: `top | original | grouped`

Invalid enum values return `400`.

### Task Creation Behavior

For top-level tasks:

- `addPosition:"top"` inserts before the current first active task in that list.
- `addPosition:"bottom"` inserts after the current last active task in that list.
- The chosen position is persisted in `tasks.sort_order`.

Subtasks keep their existing child-order behavior and append under the parent; imports and note conversions still create real tasks through the shared path.

### List Query And UI Behavior

For list views and the inbox:

- `overduePosition:"original"` preserves stored list order.
- `overduePosition:"top"` returns overdue tasks before non-overdue tasks.
- `overduePosition:"grouped"` returns overdue tasks first and the client renders separate "已过期" / "未过期" groups.

Calendar/date-based smart views keep their date-oriented ordering.

### Verification

`npm run test:settings` creates a dedicated list, switches between bottom and top insert settings, creates tasks through HTTP, verifies the returned list order, updates one task to an overdue due date, verifies original/top/grouped overdue ordering, rejects invalid enum values, and checks the persisted `sort_order` rows in SQLite. `npm run test:metadata`, `npm run test:list-batch`, server/client typecheck, and client build verify the shared task query and UI paths still compile and pass.

## Slice 41: Sidebar Mini Calendar

MINI-01 and MINI-02 are now backed by account-scoped settings and real calendar metadata. The task sidebar renders a Mini calendar when enabled, and lunar labels come from the existing `/api/calendar/day-info` backend rather than hard-coded frontend data.

### Settings Contract

`miniCalendar` stores:

- `enabled`: whether the sidebar Mini calendar is shown.
- `showLunar`: `follow | on | off`; `follow` mirrors `datetime.showLunar`.
- `showWeekNumbers`: preserved as an optional display setting for week numbers.

Invalid `showLunar` values and non-boolean toggles return `400`.

### Client Behavior

The settings center exposes Mini calendar controls in "日期与时间". The sidebar computes the visible 42-day month range using the configured week start, displays previous/next month controls, optionally shows week numbers, and fetches `/api/calendar/day-info` only when lunar labels should be visible.

### Verification

`npm run test:settings` verifies the Mini calendar settings persist through `/api/settings`, rejects invalid enum values, and checks the `settings` SQLite row. `npm run test:calendar` verifies the backend day-info source still returns real lunar and holiday metadata, `npm run test:calendar-ui` verifies month range generation, and client build verifies the Sidebar and settings UI compile together.

## Slice 42: Desktop Close Behavior And Auto Lock

SYS-03 and SYS-06 are now persisted through the desktop web bridge instead of existing only as UI labels. The bridge still reports `hostAvailable:false`, but it exposes the state a future native host needs and implements browser-side auto-lock behavior for the current web runtime.

### State Contract

`desktop_shell_state` now stores:

- `closeBehavior`: `minimize_to_tray | quit`
- `autoLockMinutes`: `0 | 1 | 5 | 10`
- `lastActiveAt`
- `autoLockedAt`

Existing booleans such as `startup`, `tray`, `appLock`, `locked`, and `backgroundAudioAllowed` continue to persist in the same table. Invalid close behavior or auto-lock values return `400`.

### API Behavior

- `POST /api/desktop/window/close-intent` returns `{ action, status }`, where `action` is the persisted close behavior.
- `POST /api/desktop/app-lock/activity` records the latest activity timestamp.
- `POST /api/desktop/app-lock/auto-lock-check` compares `lastActiveAt` with `autoLockMinutes`; if app lock is enabled and the user has been idle long enough, it sets `locked:true` and records `autoLockedAt`.
- Manual unlock clears the auto-lock marker and refreshes activity time.

### Client Behavior

The settings center exposes close behavior and auto-lock duration under "更多设置". The app records activity from pointer/key/focus events, periodically calls the auto-lock check endpoint, and displays a blocking lock overlay when the bridge state is locked.

### Verification

`npm run test:desktop` persists close behavior and auto-lock settings, rejects invalid values, verifies close intent, records an old activity timestamp, verifies the auto-lock check locks the app and returns an `autoLockedAt`, and checks the relevant `desktop_shell_state` rows in SQLite. Server/client typecheck and client build verify the App lock overlay and settings controls compile.

## Slice 43: App Lock Password

SYS-04 now uses a real account-scoped application lock password instead of a UI-only lock toggle. Passwords are stored only as salted `scrypt` hashes in SQLite and are never included in settings export.

### Data Contract

`desktop_app_lock_credentials` stores:

- `user_id`
- `password_hash`
- `updated_at`

The hash format is `scrypt:v1:<salt>:<hash>`. Raw passwords are rejected unless they are 4-128 characters, and existing passwords require the current password before replacement or removal.

### API Behavior

- `PUT /api/desktop/app-lock/password` sets or changes the password. When it succeeds, app lock is enabled and any stale lock state is cleared.
- `DELETE /api/desktop/app-lock/password` verifies the current password, deletes the credential row, disables app lock, and clears lock state.
- `POST /api/desktop/app-lock/unlock` requires `{ password }` only when a credential exists. Wrong or missing passwords return `401`.
- `GET /api/desktop/status` returns `appLockPasswordSet` so the client knows whether to prompt for a password.

### Client Behavior

The lock overlay prompts for the application lock password when required and shows real backend errors on incorrect input. The settings center exposes password set/change/disable controls under "更多设置", and manual unlock reuses the same current-password input.

### Verification

`npm run test:desktop` sets a password through HTTP, verifies the SQLite row contains an `scrypt:v1` hash rather than the raw password, rejects missing and wrong unlock passwords, accepts the correct password, rejects password changes without the current password, verifies the new password replaces the old one, deletes the credential after current-password verification, confirms export does not include app-lock credentials or hashes, and checks the credential table is empty after password removal.

## Slice 44: Offline Sync Field Merge

SY-04 now has a concrete conflict strategy for task updates coming back from an offline client. Older clients that only send `baseUpdatedAt` still get a safe `conflict` result when the server task has changed. Clients that also send `payload.baseSnapshot` get automatic field-level merge plus last-write-wins for same-field edits.

### Merge Contract

`POST /api/sync/operations` update operations may include:

```json
{
  "baseUpdatedAt": "previous task updatedAt",
  "clientCreatedAt": "when the offline edit was made",
  "payload": {
    "title": "Client title",
    "completed": true,
    "baseSnapshot": { "id": "task-id", "title": "Old title", "completed": false }
  }
}
```

When `baseUpdatedAt` is stale:

- If a field in `payload` still matches `baseSnapshot` on the server, the client field is merged.
- If both server and client changed the same field, `clientCreatedAt >= server.updatedAt` lets the client value win; otherwise the server value is kept.
- If no `baseSnapshot` is present, the route keeps returning `conflict` with the current server task.

Merge metadata is stored in `sync_operations.result_json` as `strategy:"field_merge_lww"` with merged, client-won, and server-kept fields. The response remains compatible with existing clients: applied merges return `status:"applied"` and the resulting task.

### Verification

`npm run test:sync` now creates an offline task, applies an update, proves legacy stale updates still return `conflict`, simulates a server-side concurrent title/priority change, then verifies a stale offline completed-field update merges without overwriting server fields. It also verifies same-field server-wins and client-wins cases, checks the final soft-deleted task in SQLite, and confirms three `field_merge_lww` rows are stored in `sync_operations`.

## Slice 45: Logout With Pending Offline Sync

AUTH-41 and ACC-08 now have a real logout guard for unsynced account data. The web client checks the current account's local offline sync queue before calling `/api/auth/logout`.

### Client Contract

`logout()` resolves the current account's queue key `efficiency-list.syncQueue.<userId>` before revoking the session:

- If there are no pending operations, the user sees the normal logout confirmation.
- If pending operations exist, the user gets three choices: sync now, continue logout, or cancel.
- "Sync now" calls the real `/api/sync/operations` path through `flushSyncQueue(userId)`. If all operations apply or are duplicates, logout continues.
- If sync leaves pending operations or fails because the network/API is unavailable, the user must explicitly confirm continuing logout.
- "Continue logout" preserves the offline queue under the same `userId`, revokes the server session, and returns to the login screen without showing business data.
- `logout({ confirm:false })` is reserved for flows that already completed a higher-risk confirmation, such as account deletion, and bypasses this prompt.

Logout analytics now records `has_unsynced_data`, `pending_sync_count`, `pending_sync_remaining`, `logout_choice`, and success/error context without storing task payloads.

### Verification

`npm run test:logout-flow` exercises the decision flow with injected pending counts and sync outcomes: normal confirm, cancel, sync success, partial sync cancel, continue without sync, cancel with pending data, failed-sync continue, and forced logout. `npm run test:sync` remains the HTTP-to-SQLite proof that the "sync now" branch uses the real sync endpoint and persists/apply operations correctly.

## Slice 46: Account Deleting State Gate

AUTH-65 is now explicit instead of silently undoing deletion on login. Re-authenticating during the cooling period creates a normal session cookie, but the user remains in `status:"deleting"` until they actively cancel deletion.

### API Behavior

- `POST /api/auth/login`, OAuth login, `GET /api/auth/session`, and `POST /api/auth/refresh` allow `normal` and `deleting` users so a pending-deletion user can view account status.
- Business routes mounted under `/api` after account/auth routes require `status:"normal"`. A `deleting` account receives `423 account_restricted` and cannot create or edit tasks, notes, settings, sync operations, or other product data.
- `POST /api/account/deletion/cancel` is the only path that changes `deleting` back to `normal`; it records the existing security audit log and returns the restored user.

### Client Behavior

`AuthProvider` now gates `user.status === "deleting"` before rendering the product shell. The user sees an "账号注销中" screen with the scheduled delete time, a real "撤销注销" button calling `/api/account/deletion/cancel`, and an exit button. The main app is not rendered while the account is pending deletion.

### Verification

`npm run test:account` now verifies that re-login during the cooling period keeps `status:"deleting"` and preserves `deleteScheduledAt`, that a deleting account is blocked from creating business data with `423`, that explicit cancel restores `status:"normal"` and clears the scheduled delete time, and that finalization still anonymizes the user while deleting tasks, notes, and identities. Client typecheck/build verify the deleting-state gate compiles.

## Slice 47: Post-Deletion Re-Registration Policy

AUTH-68 is now controlled by an explicit compliance/risk setting instead of being an accidental consequence of deleting identity rows.

### Data Contract

`deleted_identity_reservations` stores finalized-deletion identity tombstones when re-registration is blocked:

- `deleted_user_id`
- `type`: `email | phone | oauth`
- `provider`
- `identifier_hash`
- `display_identifier`
- `reserved_at`
- `policy`: currently `block`

The table stores only hashed identifiers plus masked display strings; it is not exported as user data.

### Policy Contract

`ACCOUNT_REREGISTRATION_POLICY` controls finalized account identity reuse:

- `allow` (default): finalization deletes active identities and the same email/phone/OAuth subject may create or bind a new account later.
- `block`: finalization copies active login identities into `deleted_identity_reservations` before deleting account-owned rows. Later login-code registration, account binding, and OAuth registration/binding for the same identity return `423 identity_re_registration_blocked`.

This keeps the first release configurable without hard-coding a legal/compliance answer in product code.

### Verification

`npm run test:account` runs with `ACCOUNT_REREGISTRATION_POLICY=block`, finalizes a deleting account, verifies active `auth_identities` are removed, verifies one deleted email reservation is persisted, and confirms the same email cannot request a new login/registration code because the API returns `423 identity_re_registration_blocked`.

## Slice 48: Auth Risk Blocking

AUTH-26 now has a real configurable risk gate for the first release. The implementation does not pretend to be a full fraud engine; it exposes deterministic rules that security/ops can configure and that are enforced before verification delivery or session creation.

### Risk Contract

Environment variables:

- `AUTH_RISK_BLOCKED_IDENTIFIERS`: comma-separated normalized identifiers (`risk@example.com`, `email:risk@example.com`, `+15550001111`) or identifier hashes.
- `AUTH_RISK_BLOCKED_DEVICE_IDS`: comma-separated client `device.deviceId` values blocked at login.
- `AUTH_RISK_SUPPORT_CONTACT`: contact text shown in the error message; defaults to `support@example.com`.

Behavior:

- `POST /api/auth/verification-codes` checks the normalized email/phone before inserting a verification code or sending SMTP/SMS. A blocked identifier returns `423 auth_risk_restricted`.
- `POST /api/auth/login`, OAuth access-token login, and OAuth callback login check `device.deviceId` before creating a session. A blocked device returns `423 auth_risk_restricted`.
- Every blocked risk decision writes a `security_audit_logs` row with an `auth_risk_*` action and does not store raw passwords, verification codes, or tokens.
- The login page surfaces the backend message and provides a mailto support entry so the user has a concrete appeal/contact path.

### Verification

`npm run test:auth` configures a blocked email, blocked device id, and support contact; verifies the blocked email returns `423 auth_risk_restricted`, includes the support contact, sends no SMTP message, and creates no verification-code row; verifies a valid challenge cannot be used from a blocked device; and checks two `security_audit_logs` risk rows in SQLite while normal email login, refresh, export isolation, and logout still pass.

## Slice 49: First Task Onboarding

AUTH-72 now has a real account-scoped activation check instead of a static empty state. The client asks the backend whether the signed-in account has ever created a task and only shows the first-task guide when the answer is still false.

### API Contract

`GET /api/account/onboarding` returns:

```json
{
  "onboarding": {
    "firstTaskCreated": false,
    "showFirstTaskGuide": true,
    "totalTaskCount": 0,
    "activeTaskCount": 0
  }
}
```

- `totalTaskCount` counts all task rows for the current `userId`, including soft-deleted tasks, so the first-task guide does not reappear after the activation action has happened.
- `activeTaskCount` counts non-deleted task rows and is available for later onboarding steps without leaking other accounts' data.
- The route is authenticated and reads SQLite directly through the current session user.

### Client Behavior

The task module refreshes onboarding status with the task list/sidebar data. When `showFirstTaskGuide` is true, the normal quick-add field is replaced with a focused first-task form. Submitting it calls the existing real task creation flow, including quick-parse, `/api/tasks`, tag attachment, offline queue handling, and then refreshes the onboarding status so the guide disappears after the first persisted task.

### Verification

`npm run test:auth` now verifies a newly registered Alice account receives `showFirstTaskGuide:true` and zero task counts from `/api/account/onboarding`; after a real `POST /api/tasks`, the same endpoint returns `firstTaskCreated:true`, `showFirstTaskGuide:false`, and one task count. It also verifies Bob's new account still receives the guide and has zero task counts, while the SQLite task table contains only Alice's task.

## Slice 50: Notification Permission Prompt On Reminder Intent

AUTH-73 now has a concrete client-side permission trigger. System notification permission remains a real local browser/device state; the app does not fabricate permission grants on the backend.

### Client Contract

`client/src/notificationPermission.ts` exposes `ensureNotificationPermission(promptReason)`:

- If `window.Notification` is unavailable, it reports `unsupported` to `/api/notifications/permission` with the prompt reason.
- If the browser status is `default`, it calls the real `Notification.requestPermission()` from the user-triggered flow and reports the resulting status.
- If the browser status is already `granted` or `denied`, it reports that real status without asking again.

The helper is called when the user sets a task reminder, creates a habit with a reminder time, or starts a Pomodoro session whose completion alert is the focus reminder moment. Reminder creation and Pomodoro recording continue to use the existing real API/storage paths; permission state is stored separately in `notification_permissions`.

### Verification

`npm run test:notification-permission-client` exercises the client helper with injected browser runtimes and verifies `default` requests once, `granted` does not request again, unsupported environments report `unsupported`, and the correct `task_reminder`, `habit_reminder`, and `focus_reminder` prompt reasons are sent to the API adapter.

`npm run test:notifications` verifies the backend accepts and persists the three reminder prompt reasons through `/api/notifications/permission`, keeps invalid statuses rejected, and still proves reminder delivery writes real `notifications` and `task_reminders` rows in SQLite.

## Slice 51: System Calendar Permission Guide

AUTH-74 now has an honest permission boundary for system-calendar read-only subscription. The web app no longer treats system calendar access as equivalent to a normal ICS paste. System calendar access requires a real native/browser host bridge; when that bridge is absent, the product records `unsupported` and points the user back to the already-supported ICS read-only subscription path.

### Data Contract

`calendar_permissions` stores the device-reported state:

- `permission`: currently `system-calendar-readonly`
- `status`: `unknown | granted | denied | unsupported`
- `prompt_reason`: currently `system_calendar_subscription`
- `last_prompted_at`
- `updated_at`

This is exported with account data as `calendarPermissions` and removed during account deletion finalization.

### API Contract

- `GET /api/calendar/system-permission` returns the current permission state with `shouldPrompt` and `guidance`.
- `POST /api/calendar/system-permission` persists the real client/runtime status. Invalid statuses and prompt reasons return `400`.
- `POST /api/calendar/system-subscription` is the only route for enabling native system calendar subscriptions. It returns `403 system_calendar_permission_required` unless permission is `granted`; when permission is granted but no real provider/host is configured, it returns `501 system_calendar_provider_not_configured` and does not create subscription rows.
- Generic `POST/PATCH /api/calendar/subscriptions` rejects `type:"system"` with `501` so system calendars cannot be faked through the ICS route.

### Client Behavior

`client/src/systemCalendarPermission.ts` looks for a real `window.efficiencyListSystemCalendar` bridge. Without it, it reports `unsupported` to the backend. With a bridge, it reads `getPermissionStatus()` and only calls `requestReadOnlyAccess()` when the status is still unknown. The calendar screen exposes a "订阅系统日历" action that runs this guide first; unsupported or denied states show inline guidance and do not create a fake system subscription.

### Verification

`npm run test:system-calendar-permission-client` verifies unsupported web runtime reporting, a native-style unknown-to-granted request, and denied status without re-requesting.

`npm run test:calendar` verifies the initial `unknown` permission state, rejects invalid status, persists `unsupported` and then `granted`, rejects system subscription without permission, returns `501` when permission exists but no provider is configured, rejects generic `type:"system"` subscription creation, exports the permission row, and still proves real ICS subscription sync writes one `calendar_subscriptions` row and one `external_calendar_events` row in SQLite.

## Slice 52: AI Key Guide On AI Intent

AUTH-75 now has a client-side guide before any AI capability is invoked. The backend already refuses unconfigured AI with `409` and never fabricates AI results; the client now surfaces a clearer setup path at the point of intent.

### Client Contract

`client/src/aiGuide.ts` checks the current account settings before AI actions:

- If AI is disabled, the user is told to enable AI in "设置 > AI 设置" and save provider/API Key details.
- If `baseUrl`, `model`, or `API Key` is missing, the message lists the missing fields.
- If configuration is complete, the action calls the existing real `/api/ai/*` endpoint.

The guide is wired into:

- task detail AI subtask breakdown
- task detail AI quadrant suggestion
- goal AI schedule suggestion
- focus weekly AI review

### Verification

`npm run test:ai-guide-client` verifies disabled AI, missing base URL/model/key, and fully configured states. `npm run test:ai` now also proves that disabled AI and missing API Key both return `409` without calling the provider, then configures a real OpenAI-compatible test provider and verifies task breakdown, quadrant suggestion, weekly review, and schedule suggestion still call the provider, parse responses, persist logs, and never store the raw API key in AI generation logs.

## Slice 53: Login Device Management

AUTH-50, AUTH-51, and AUTH-52 now have a real account-settings surface instead of only backend routes. The settings modal loads `/api/account/sessions`, displays current and historical login sessions, and calls `DELETE /api/account/sessions/:id` to revoke a selected non-current session. Current-device logout is routed through the existing logout flow so pending offline sync confirmation is preserved.

### Contract

- `GET /api/account/sessions` returns every session for the current account, including `revokedAt`, with `isCurrentDevice` computed from the requesting cookie.
- `DELETE /api/account/sessions/:id` revokes only a session owned by the signed-in account. A different account receives `404` and cannot affect the target session.
- A revoked session cookie becomes unauthenticated on its next request because auth middleware checks `login_sessions.revoked_at`.

### Verification

`npm run test:auth` logs Alice into two real SMTP-code sessions, lists both devices from Alice's first cookie, revokes the second device, verifies the second cookie can no longer call `/api/auth/session`, verifies Bob cannot revoke Alice's current session, and checks SQLite for three session rows with two revoked sessions after Alice logs out. Client typecheck/build verify the settings device-management UI is wired to the real API.

## Slice 54: Configured System Calendar Provider

AUTH-74 and CAL-05 now move beyond a permission-only 501 boundary when a real read-only provider is configured. The backend accepts either `SYSTEM_CALENDAR_ICS_FILE` / `SYSTEM_CALENDAR_ICS_PATH` from a native desktop host export, or `SYSTEM_CALENDAR_ICS_URL` from a read-only system-calendar service. Missing configuration still returns `501`; provider read/fetch failure returns `502`.

### Contract

- `POST /api/calendar/system-subscription` still requires stored `status:"granted"` from `/api/calendar/system-permission`.
- With no provider configuration, it returns `501 system_calendar_provider_not_configured` and creates no subscription.
- With a configured provider, it reads the provider's real ICS content, creates a `type:"system"` subscription, syncs events into `external_calendar_events`, and returns `{ subscription, events }`.
- Generic `POST /api/calendar/subscriptions` continues to reject `type:"system"` so system calendars cannot be faked through a pasted ICS payload.
- `PATCH /api/calendar/subscriptions/:id` may rename/disable a system subscription, but cannot change its `type` or `url`; the source remains provider-managed.
- Re-syncing a system subscription ignores caller-supplied `icsText` and reloads the configured provider source.

### Verification

`npm run test:calendar` now verifies the unconfigured `501` path, writes a real fixture ICS file as `SYSTEM_CALENDAR_ICS_FILE`, creates a system subscription through HTTP, confirms the synced system event is queryable through `/api/calendar/events`, proves the system subscription source cannot be patched into a fake ICS feed, proves the generic system subscription route still returns `501`, and checks SQLite for one system subscription plus the synced external event.

## Slice 55: About Contact And Feedback Channels

ABOUT-06 and ABOUT-07 now have a configured real entry instead of static placeholder text. The About settings page asks the backend for contact and feedback channels; the backend only returns channels explicitly configured by deployment.

### Contract

- `GET /api/about/contact` returns `{ contactEmail, feedbackUrl, supportText }`.
- `APP_CONTACT_EMAIL` configures the contact email. `AUTH_RISK_SUPPORT_CONTACT` may be reused as a fallback support email.
- `APP_FEEDBACK_URL` configures the issue feedback entry and must be `http:`, `https:`, or `mailto:`.
- `APP_SUPPORT_TEXT` configures optional service/help text.
- If none of those channels are configured, the route returns `501 about_contact_not_configured`; invalid configured values return `502 invalid_about_contact`.

### Verification

`npm run test:about` now verifies configured contact email, feedback URL, and support text are returned by `/api/about/contact`, then clears the env config and verifies the route returns `501` instead of fabricating a support channel. Client typecheck/build verify the About settings page calls the real route and renders the returned contact/feedback entries.

## Slice 56: Open Source License Inventory

ABOUT-05 now uses the real dependency lockfile instead of a hand-written license list. The About settings page calls the backend license inventory and renders package/version/license rows from that response.

### Contract

- `GET /api/about/licenses` reads the repository `package-lock.json` at request time.
- The response is `{ source:"package-lock.json", generatedAt, packageCount, packages }`.
- Each package row includes `{ name, version, license, dev, optional, resolved }`.
- Workspace roots and app packages are excluded; installed npm packages under `node_modules/*` are included. Missing license metadata is returned as `null`, not guessed.
- If the lockfile is missing or malformed, the API returns `502 about_licenses_unavailable`.

### Verification

`npm run test:about` verifies the route returns a non-empty package list, `packageCount` matches the array length, and the real Express and React entries from `package-lock.json` report their MIT licenses. Client typecheck/build verify the About settings page calls the real route and renders the dependency license list.

## Slice 57: Authorized Diagnostic Log Upload

ABOUT-08 now has a real upload path instead of a static promise. Diagnostic uploads are account-scoped, require an explicit consent flag, and persist both metadata in SQLite and a scrubbed JSON log file on disk.

### Data Contract

`diagnostic_log_uploads` stores:

- `id`
- `user_id`
- `filename`
- `log_path`
- `summary_json`
- `size_bytes`
- `uploaded_at`

### API Contract

- `POST /api/about/diagnostic-logs` requires a valid session cookie.
- Body is `{ consent:true, clientContext, entries:[{ level?, message, occurredAt?, context? }] }`.
- Missing explicit consent returns `400 diagnostic_consent_required`.
- Empty or malformed entries return `400 invalid_diagnostic_log`.
- Payloads over the diagnostic size limit return `413 diagnostic_log_too_large`.
- Server-side scrubbing redacts emails, phone numbers, six-digit verification codes, tokens, API keys, passwords, authorization headers, and secrets before writing the JSON file.
- `DIAGNOSTIC_LOG_DIR` optionally overrides the default `server/data/diagnostic-logs` storage directory.

### Verification

`npm run test:about` now logs in through real SMTP email verification, verifies unauthenticated uploads return `401`, verifies consent is required, uploads a diagnostic payload containing a raw email, phone, code, and token, then queries SQLite and reads the stored JSON file to prove sensitive values were redacted while safe context remains.

## Slice 58: Account Sync Status

ACC-07 now has a real account sync status surface instead of relying on a cache-cleanup row. The server summarizes the current account's durable `sync_operations` rows, while the web settings page combines that server summary with the browser-local offline queue count.

### API Contract

- `GET /api/account/sync-status`

Response:

```json
{
  "syncStatus": {
    "health": "never_synced | synced | conflict | failed",
    "lastSyncAt": "ISO timestamp or null",
    "lastSuccessfulSyncAt": "ISO timestamp or null",
    "pendingServerOperationCount": 0,
    "statusCounts": { "applied": 0, "conflict": 0, "failed": 0 },
    "lastOperation": {
      "clientOperationId": "stable-client-id",
      "entityType": "task",
      "action": "create | update | delete",
      "status": "applied | conflict | failed",
      "entityId": "task-id or null",
      "error": null,
      "receivedAt": "ISO timestamp",
      "appliedAt": "ISO timestamp or null"
    }
  }
}
```

`pendingServerOperationCount` counts received operations that remain `conflict` or `failed`; browser-local unsent operations stay in `localStorage` and are displayed by the client from the current account's offline queue.

### Verification

`npm run test:sync` now checks `/api/account/sync-status` before any sync, after an applied create, after a conflict, after another user's failed operation, and after a final successful delete. It verifies the HTTP response against the real SQLite `sync_operations` rows and keeps the existing DB assertions for applied, conflict, failed, and merge operation counts.

## Slice 59: Pomodoro Rest Cycle Loop

PM-05 now has a real rest-cycle record instead of a UI-only timer transition. When a Pomodoro completes, the client saves the focus session, enters the configured rest duration, and records the completed rest cycle before automatically starting the next Pomodoro. Rest-complete reminders are persisted as normal in-app notifications when notifications are enabled and not in do-not-disturb time.

### Data Contract

`focus_rest_cycles` stores `{ id, userId, focusSessionId, restStartedAt, restEndedAt, restDurationSec, nextFocusStartedAt, reminderStatus, notificationId, createdAt }`. Each Pomodoro focus session can have at most one rest cycle, making client retries idempotent.

### API Contract

- `GET /api/focus/rest-cycles?limit=100`
- `POST /api/focus/rest-cycles`

Create input:

```json
{
  "focusSessionId": "pomodoro-session-id",
  "restStartedAt": "ISO timestamp",
  "restEndedAt": "ISO timestamp",
  "restDurationSec": 300,
  "nextFocusStartedAt": "ISO timestamp or null"
}
```

The route requires the focus session to belong to the current account and to be a Pomodoro session. It returns `{ restCycle }`; invalid timing returns `400`, another account's session returns `404`, and repeated creates for the same focus session return the existing cycle.

### Verification

`npm run test:focus` now creates a Pomodoro through HTTP, records an 8-minute rest cycle, verifies retry idempotency, verifies Bob cannot attach a rest cycle to Alice's session, confirms a `focus_rest_complete` notification row exists, checks settings export includes `focusRestCycles`, and queries SQLite for the rest duration, next focus timestamp, and linked notification id. Client typecheck/build verify the Pomodoro UI's rest countdown and automatic next-round wiring compile against the real API.

## Slice 60: Account Language And Date Localization

P-03 now has an account-scoped localization foundation instead of relying only on the browser's transient `navigator.language`. The first supported languages are Simplified Chinese and English; `system` resolves to Chinese for Chinese browser languages and English otherwise.

### Settings Contract

The `localization` settings group stores `{ language }`, where `language` is `system | zh-CN | en-US`. The setting is persisted in the same account-scoped `settings` table and is included in settings export. Invalid locales are rejected with `400`.

### Client Contract

The settings provider applies the persisted language by setting `document.documentElement.lang`, `data-locale`, and the shared calendar/date formatting locale. Existing time-format settings still control 12-hour vs 24-hour display; date labels now use the resolved locale instead of hard-coded Chinese month/day strings.

### Verification

`npm run test:settings` patches `localization.language` through HTTP, verifies it persists in the API response, rejects an unsupported locale, and checks the SQLite `settings` row. `npm run test:localization-client` verifies system-language resolution plus localized time/date formatting. Client typecheck/build verify the settings UI and date-label usage compile.

## Slice 61: Appearance Sidebar Background And App Opacity

APP-03 and APP-07 now use account-scoped appearance settings instead of browser-only styling. The sidebar can use the default product background, a saved hex color, or a saved http/https image URL. The app opacity is stored as an integer percentage from `0` to `100`.

### Settings Contract

The `appearance` settings group now stores:

```json
{
  "sidebarBackground": {
    "type": "default | color | image",
    "color": "#f0eee6",
    "imageUrl": "https://example.com/sidebar.jpg or null"
  },
  "appOpacity": 100
}
```

Invalid background types, non-hex colors, non-http/https image URLs, and opacity values outside `0..100` return `400`. Values are persisted in the existing `settings` SQLite table and included in settings export with the rest of the account settings.

### Client Contract

The settings center exposes sidebar background controls and an opacity slider in the appearance panel. The settings provider applies the persisted values to CSS variables so the sidebar and app shell update from the same API response that was written to storage.

### Verification

`npm run test:settings` patches sidebar background and opacity through `/api/settings`, verifies the API response, rejects invalid color/image/opacity values, and checks the SQLite `appearance` row. Server/client typecheck and client build verify the settings UI and CSS-variable wiring compile.

## Slice 62: Pomodoro Immersive Mode

PM-07 now has a real browser fullscreen focus mode instead of a visual-only toggle. The focus module requests fullscreen on the focus workspace through the browser Fullscreen API, hides the right-side overview while immersive, and returns to the normal focus layout when fullscreen exits.

### Client Contract

The focus module exposes an "沉浸" control. Entering immersive mode calls `HTMLElement.requestFullscreen()` on the focus shell. Exiting calls `document.exitFullscreen()` and requires confirmation while a focus session, paused session, or rest cycle is active. Stopping a Pomodoro or rest cycle still requires confirmation; count-up sessions only add a stop confirmation when they are currently in immersive mode because stopping them saves the session instead of abandoning it.

If the browser does not expose Fullscreen API support, the client surfaces a real unsupported-capability error and does not pretend to enter immersive mode.

### Verification

`npm run test:focus-immersive-client` verifies the confirmation rules, explicit unsupported Fullscreen API errors, and the real helper calls to `requestFullscreen` / `exitFullscreen`. Client typecheck/build verify the focus UI compiles against the browser API wiring.

## Slice 63: Notification Detail Visibility

NOTI-02 now has an account-scoped privacy setting instead of always rendering notification titles and bodies. The setting controls the in-app notification center with three modes: show details only when the app is unlocked, always show details, or hide details.

### Settings Contract

The `notifications` settings group now stores:

```json
{
  "detailVisibility": "when_unlocked | always | hidden"
}
```

The default is `when_unlocked`. Invalid values return `400`, and the value is persisted in the existing account-scoped `settings` SQLite table.

### Client Contract

`NotificationCenter` receives the current desktop app-lock state from `App`. When `detailVisibility` is `when_unlocked` and the app is locked, or when the setting is `hidden`, the notification title and body are replaced with generic privacy copy. `always` preserves the original server-provided notification content even while locked.

### Verification

`npm run test:settings` verifies the notification detail preference persists through `/api/settings`, rejects invalid values, and checks the SQLite settings row. `npm run test:notification-detail-client` verifies the unlocked, locked, always-show, and always-hide rendering rules without fabricating notification data.

## Slice 64: Module Order

MOD-02 now stores the left navigation module order as account-scoped settings instead of relying on the fixed `ModuleRail` array. The task module remains non-hideable, but it participates in ordering so the entire rail can match the user's chosen order.

### Settings Contract

The `modules` settings group now stores:

```json
{
  "order": ["goals", "tasks", "calendar", "matrix", "focus", "habits", "countdown", "notes"]
}
```

`order` must contain every known module key exactly once. Unknown keys, missing keys, and duplicates return `400`; old settings rows without `order` are normalized to the default order when read.

### Client Contract

`ModuleRail` renders modules through the persisted order and still filters hidden non-core modules. The settings center exposes a draggable module-order list with up/down controls as an accessible fallback. Changes call the existing `/api/settings` route and are not stored in browser-only state.

### Verification

`npm run test:settings` patches `modules.order` through HTTP, verifies the API response, rejects duplicate/missing order payloads, and checks the SQLite `modules` row. `npm run test:module-order-client` verifies order normalization and reordering behavior used by the rail/settings UI. Client typecheck/build verify the ordered rail and settings drag controls compile.

## Slice 65: Account Time Zone Selection

TIME-06 and TIME-07 now have account-scoped time-zone settings instead of always relying on the browser's local time zone. The default remains system time; when manual time zone is enabled, time displays use the saved IANA time zone.

### Settings Contract

The `datetime` settings group now stores:

```json
{
  "timeZoneMode": "system | manual",
  "timeZone": "Asia/Shanghai or null"
}
```

`timeZoneMode` defaults to `system`, and `timeZone` defaults to `null`. Manual mode requires a valid IANA time zone. Invalid zones return `400`, and values are persisted in the existing account-scoped `settings` SQLite table.

### Client Contract

The settings center exposes a time-zone on/off switch and a manual time-zone selector. The shared calendar/date formatting helper applies the persisted time-zone preference to focus records, calendar blocks, and other views that use `hm()` / `localDateLabel()`.

### Verification

`npm run test:settings` patches manual time-zone settings through `/api/settings`, rejects invalid/missing manual zones, and checks the SQLite `datetime` row. `npm run test:localization-client` verifies shared date/time formatting changes when switching between manual `Asia/Shanghai`, manual `America/New_York`, and system time-zone modes. Client typecheck/build verify the settings UI and formatter wiring compile.

## Slice 66: Reminder Notification Volume

SOUND-03 now has an account-scoped reminder volume instead of relying on a fixed in-app notification sound level. The setting is persisted with the existing notification preferences and is used by the notification center when new unread reminders arrive.

### Settings Contract

The `notifications` settings group now stores:

```json
{
  "reminderVolume": 70
}
```

`reminderVolume` is an integer from `0` to `100`. Invalid values return `400`, old settings rows default to `70`, and valid values are persisted in the existing account-scoped `settings` SQLite table.

### Client Contract

The settings center exposes a `0-100` reminder-volume slider. `NotificationCenter` compares unread notification counts after real `/api/reminder-runner/tick` and `/api/notifications` calls; when the unread count increases, it plays a short Web Audio notification tone unless `completionSound` is `none` or the volume is `0`.

### Verification

`npm run test:settings` patches `notifications.reminderVolume` through `/api/settings`, rejects out-of-range values, and checks the SQLite `notifications` settings row. `npm run test:notification-sound-client` verifies volume normalization, clamping, and muted/disabled playback gating used by the Web Audio helper. `npm run test:notifications` remains the backend regression for real reminder notification creation.

## Slice 67: Pomodoro Background Audio Fade-Out

PM-06 and SOUND-05 now have a real browser background-audio playback path instead of only storing the chosen sound in the focus session. The focus module plays the selected `background_sounds.asset_url` through `HTMLAudioElement`, honors the independent background volume, and can fade out when focus audio is paused or stopped.

### Settings Contract

The `focus` settings group now stores:

```json
{
  "fadeOutStop": true
}
```

`fadeOutStop` is a boolean and defaults to `true`. Invalid non-boolean values return `400`, and valid values are persisted in the existing account-scoped `settings` SQLite table.

### Client Contract

`FocusModule` resolves the selected background sound from the real `/api/focus/sounds` response. Browser-playable cached paths are preferred, while `cache://` placeholders fall back to the seeded asset URL under `client/public/sounds`. The background audio plays while a focus session is running, follows `pauseSoundOnPause`, follows `playSoundDuringRest`, honors `backgroundAudioAllowed`, and fades down before pausing/stopping when `fadeOutStop` is enabled.

### Verification

`npm run test:focus-background-audio-client` verifies volume normalization, playable sound URL resolution, run/pause/rest playback gating, and fade-out math. `npm run test:settings` verifies `focus.fadeOutStop` persists through `/api/settings`, rejects invalid values, and checks the SQLite `focus` settings row. `npm run test:focus` remains the backend regression for real background sound assets, caching, focus session persistence, and rest-cycle notification creation.

## Slice 68: Classified Reminder Switches

NOTI-03 through NOTI-06 now have account-scoped reminder switches instead of a single all-or-nothing notification preference. The switches are persisted with the notification settings and are enforced by the real reminder producers.

### Settings Contract

The `notifications` settings group now stores:

```json
{
  "taskReminders": true,
  "habitReminders": true,
  "focusReminders": true,
  "goalReminders": true
}
```

Each value is boolean and defaults to `true`. Invalid non-boolean values return `400`, and valid values are persisted in the existing account-scoped `settings` SQLite table.

### Reminder Contract

`POST /api/reminder-runner/tick` still honors the global notification switch and do-not-disturb window first. When those allow delivery:

- `taskReminders` controls due `task_reminders` rows. Disabled task reminders remain `scheduled` so they can still be delivered after the switch is enabled again.
- `habitReminders` creates daily in-app notifications for active habits whose `reminder_time` has passed, whose weekday is scheduled, and which have not been checked in for the current local day.
- `goalReminders` creates one in-app notification per active overdue goal deadline.
- `focusReminders` controls rest-complete notifications created by `/api/focus/rest-cycles`.

### Verification

`npm run test:settings` verifies all four switches persist through `/api/settings`, rejects invalid switch values, and checks the SQLite `notifications` settings row. `npm run test:notifications` verifies disabled task/habit/goal switches suppress new notifications, re-enabling them creates real task, habit, and goal notification rows, disabled task reminders are not marked sent until re-enabled, and disabled focus reminders suppress rest-cycle notifications. Server/client typecheck and client build verify the settings UI and reminder contracts compile.

## Slice 69: Custom Notification Sounds

SOUND-01 and SOUND-02 now have a real custom-audio path instead of only built-in sound choices. Users can upload account-owned audio files, use one as the reminder ringtone, and use one as the custom completion sound.

### Data Contract

Custom notification sounds are stored as file bytes plus SQLite metadata:

```sql
notification_sounds(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'both',
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
)
```

Files are written under `server/data/notification-sounds` by default, or `NOTIFICATION_SOUNDS_DIR` when configured. Accepted MIME types are audio MIME types such as WAV, MPEG, OGG, WebM, and MP4 audio. Files larger than 2MB are rejected.

### API Contract

- `GET /api/notification-sounds?purpose=reminder|completion`
- `POST /api/notification-sounds` with `{ name, purpose, mimeType, contentBase64 }`
- `GET /api/notification-sounds/:id/download`

All routes require the logged-in account. Sound downloads are account-scoped; another account receives `404` for a sound it does not own.

### Settings Contract

The `notifications` settings group now stores:

```json
{
  "reminderSound": "default | custom",
  "reminderSoundId": "notification sound id or null",
  "completionSound": "ding | none | custom",
  "completionSoundId": "notification sound id or null"
}
```

Choosing a custom reminder or completion sound requires a sound id owned by the current account. Invalid or cross-account ids return `400`.

### Client Contract

The settings center lists uploaded sounds, uploads new audio with a real `FileReader` to the backend route, and saves the selected custom sound through `/api/settings`. `NotificationCenter` still plays the built-in Web Audio ding for defaults, but when a custom sound is selected it plays the authenticated `/api/notification-sounds/:id/download` URL through `HTMLAudioElement`.

### Verification

`npm run test:notification-sounds` verifies audio upload validation, SQLite metadata, filesystem writes, purpose filtering, account-scoped download isolation, custom setting persistence, export metadata, and download byte integrity. `npm run test:notification-sound-client` verifies custom sound URL selection and playback gating. Server/client typecheck and client build verify the new route, settings UI, and audio helper compile.

## Slice 70: Task Completion Sound Trigger

SOUND-02 now fires from real task-completion actions instead of only exposing a configurable setting. The playback path runs only after a successful backend update returns an updated task or checklist item.

### Client Contract

Task completion sound is triggered when a completion state transitions from `false` to `true` in these existing UI flows:

- task list checkbox via `PATCH /api/tasks/:id`
- inline subtask checkbox via `PATCH /api/tasks/:id`
- task detail parent checkbox or status change via `PATCH /api/tasks/:id`
- task detail checklist item checkbox via `PATCH /api/tasks/:taskId/checklist/:itemId`
- matrix quadrant task checkbox via `PATCH /api/tasks/:id`
- batch complete via `POST /api/tasks/batch`, with one sound per successful batch

The helper respects `notifications.completionSound`, custom completion sound ids, and `notifications.reminderVolume`. Reopening a completed item, re-saving an already completed item, choosing `none`, or setting volume to `0` does not play audio.

### Verification

`npm run test:task-completion-sound-client` verifies transition gating, custom-sound propagation, disabled settings, and muted settings. `npm run test:notification-sound-client` remains the regression for custom download URL selection and the actual Web Audio/HTMLAudio playback helper.

## Slice 71: Task Completion Undo

T-10 and C-01 now have a visible undo path for completed tasks instead of relying only on manually finding the task in the completed smart list.

### Client Contract

When a task-list checkbox changes a task from open to completed, the client waits for the real `PATCH /api/tasks/:id` response, then shows a completion undo bar with the task title. When a batch complete succeeds through `POST /api/tasks/batch`, the undo bar records only the tasks that were incomplete before the batch and plays one completion sound. Clicking `撤销` calls `POST /api/tasks/batch` with `{ action:"update", patch:{ completed:false } }`, clears the undo bar, refreshes the current list, and shows a sync notice. Reopening a task or doing a non-completion batch clears the undo bar.

### Verification

`npm run test:task-completion-undo` logs in through SMTP, creates a real task, completes it via HTTP, reopens it through the same batch route used by the UI undo button, verifies it leaves the completed smart list, verifies another account cannot undo it, and checks SQLite for `completed=0`, `completed_at=NULL`, `status='todo'`, plus both `task_completed` and `task_reopened` activity rows. Client typecheck/build verify the undo bar and wiring compile.

## Slice 72: Quick Add Parse Preview And Undo

T-02 now exposes the natural-language parsing result before task creation instead of parsing invisibly at submit time only.

### Client Contract

When quick-add parsing is enabled, pressing Enter on a draft without a current preview calls the real `POST /api/tasks/quick-parse` route and shows highlighted tokens for date, time, priority, tag, estimate, recurrence, URL, and final title. Pressing Enter again or clicking `按解析结果创建` creates the task from the returned draft, attaches parsed tags through the real tag/task-tag routes, and does not call the parser a second time. Clicking `撤销解析` switches the current draft to raw mode; the next submit creates the original text through `POST /api/tasks` without applying parsed date, priority, or tag values. Editing the draft invalidates the preview and requires parsing again.

### Verification

`npm run test:quick-add-preview-client` verifies token labels, draft summaries, parsed submit mode, dismissed raw submit mode, and stale-preview invalidation. `npm run test:quick-add-preview` logs in through SMTP, calls `/api/tasks/quick-parse` for `明天下午3点开会 #工作 !高`, creates one task using the parsed draft and tag relation, creates another task as raw text to simulate `撤销解析`, and checks SQLite for parsed priority/start time/tag plus raw title/no tag/no parsed time. Client typecheck/build verify the quick-add preview UI compiles.

### Slice 90: T-04 quick capture from voice/share/widget/shortcut

T-04 is implemented as a real task-capture contract instead of native-shell mock data. `POST /api/tasks/quick-capture` accepts:

```ts
{
  source: 'voice' | 'system_share' | 'desktop_widget' | 'shortcut' | 'web';
  text?: string;
  title?: string;
  url?: string | null;
  listId?: string | null;
  priority?: 0 | 1 | 2 | 3;
  dueDate?: string | null;
  startDate?: string | null;
  isAllDay?: boolean;
  parse?: boolean;
}
```

The backend validates the source enum and URL shape, uses the current account `quickAdd` settings when `parse !== false`, creates missing parsed tags through the real tag repository, merges parsed tags with account default tags, and persists the task through the shared `repo.createTask` path with `tasks.source` set to the capture source. Shared URLs are preserved in `tasks.note`.

The task quick-add panel exposes a browser voice button. It only uses real `SpeechRecognition` / `webkitSpeechRecognition`; unsupported browsers return `voice_capture_unsupported` and no fake transcript is created. Recognized speech is sent to `/api/tasks/quick-capture` with the current task-list context. Offline network failures are queued through the existing local sync queue with the capture source retained.

`npm run test:quick-add-preview` now also calls `/api/tasks/quick-capture` for `system_share` and `voice`, verifies source persistence, parsed priority/tag attachment, shared URL preservation, invalid-source rejection, and SQLite rows in `tasks`/`task_tags`. `npm run test:voice-quick-capture-client` verifies browser speech API detection, transcript extraction, unsupported runtime rejection, and surfaced recognition errors.

## Slice 73: List And Folder Ordering

L-05 now has a real persisted ordering path for custom lists and list folders. The sidebar exposes up, down, and pin-to-top controls; these write `sortOrder` through the existing list/folder PATCH APIs instead of storing order in browser state.

### Client Contract

Each custom list row has compact controls for moving within its current sibling group and pinning to the top of that group. Lists inside a folder reorder only among that folder's children; ungrouped lists reorder only among ungrouped lists. Each folder header exposes the same controls for folder order. Move operations swap the current row's `sortOrder` with the neighbor; pin-to-top writes a `sortOrder` lower than the current first row. After the real API calls complete, the task module reloads lists and folders from the backend, so refreshes and account changes keep the persisted order.

### Verification

`npm run test:list-order` logs in two accounts through SMTP, creates three custom lists, patches one list's `sortOrder` to the top, verifies `/api/lists` returns the persisted order, creates two folders, patches one folder's `sortOrder` to the top, verifies `/api/lists/folders` returns that order, verifies another account cannot reorder those rows, and checks SQLite order for both `lists` and `list_folders`. Client typecheck/build verify the sidebar controls compile.

## Slice 74: Task List Sort And Group Controls

S-01/S-02 now have task-list sorting and grouping controls on top of the real task/list/tag DTOs already returned by the backend. No browser-only task data or fake API path is introduced.

### Client Contract

The task panel exposes sort modes for custom backend order, time, priority, title, and list. It exposes group modes for none, list, date, priority, and tag. Custom order preserves the API order; other modes derive their order from `Task`, custom `List`, and `Tag` fields returned by `/api/tasks`, `/api/lists`, and `/api/tags`. Because the current `/api/lists` contract excludes the smart inbox list, tasks whose `listId` is not present in custom list metadata are grouped and sorted with the inbox fallback. Existing overdue grouping remains available only when task grouping is disabled.

### Verification

`npm run test:task-list-view-client` verifies the sort and group helper rules, including calendar ordering, priority labels, list order, untagged fallback, and multi-tag task duplication across tag groups. `npm run test:task-list-view` logs in through SMTP, creates real lists, tags, and tasks over HTTP, fetches active tasks/lists/tags from the API, verifies sort/group output from those DTOs, and checks SQLite for persisted task priority/date rows plus `task_tags` relations.

## Slice 75: Combined Task Filters And Saved Smart Lists

S-03/S-04 now have a real combined-filter path instead of saving only the current tag. The task panel can filter by keyword, time scope, priority, status, and tag, while preserving the current smart-list or custom-list scope.

### API Contract

`GET /api/tasks` now supports combining the existing scope parameters with filter parameters:

- scope: `view` or `listId`, with legacy calendar range calls still allowed through `from` + `to`
- filters: `tagId`, `priority`, `status`, `q`, `from` + `to`, and `dateFilter=today|next7days|undated`

When `from` + `to` are supplied together with `view` or `listId`, the range is applied as an additional condition rather than replacing the current scope. `dateFilter=undated` is also applied as an additional condition, so a custom list can be filtered down to only its undated tasks.

### Client Contract

The task panel exposes a filter row for keyword, time, priority, and status. The existing tag dropdown remains part of the same query. Changing any manual filter clears the selected saved-filter id but does not fabricate results; `TaskModule` rebuilds the `/api/tasks` query and reloads from the backend. Saving a filter writes the current `view` or `listId` plus all active filter conditions to `/api/filters`. Selecting a saved filter restores its scope, tag, and visible filter controls before reloading tasks.

### Verification

`npm run test:task-filter-client` verifies query serialization, saved-filter query construction, and restoring UI controls from a saved query. `npm run test:task-filter-combo` logs in through SMTP, creates a real list, tag, and four tasks over HTTP, proves `listId + tagId + priority + status + q + from/to` returns only the matching task, saves that query through `/api/filters`, replays it from the saved filter, verifies `dateFilter=undated` remains scoped to list/tag/priority, and checks SQLite for the saved `query_json` plus task-tag relations.

## Slice 76: Manual Task Ordering

T-16 now has a persisted task-ordering path for list-style task views. The implementation uses compact order controls instead of browser-only drag state, and writes the same `sortOrder` field already used by the backend list ordering query.

### Client Contract

Task order controls appear only when the current view can honestly persist manual order: custom sort mode, no grouping, not trash, not overdue grouped, and the selection is a custom list or the inbox smart list. The controls support move up, move down, and pin to top. Move operations swap the visible neighbors' `sortOrder` values. Pin-to-top writes a `sortOrder` lower than the current first task. After the real PATCH requests complete, `TaskModule` reloads tasks from the backend.

### API Contract

No new endpoint is introduced. The client calls the existing `PATCH /api/tasks/:id` route with `{ "sortOrder": number }`. The route remains account-scoped; attempting to reorder another account's task returns `404`.

### Verification

`npm run test:task-manual-order-client` verifies the move-up, move-down, pin-to-top, and no-op helper rules. `npm run test:task-manual-order` logs in two accounts through SMTP, creates a real custom list and three tasks, reorders them through `PATCH /api/tasks/:id`, verifies `/api/tasks?listId=...` returns the persisted order, verifies another account cannot patch the task order, and checks SQLite `tasks.sort_order` plus `task_activity_logs` rows.

## Slice 77: Pomodoro Long Rest Settings

PM-04 now supports the long-rest half of custom Pomodoro duration settings. The existing PM-05 auto-rest loop uses the configured short rest for normal cycles and the configured long rest every N completed Pomodoros.

### Settings Contract

The account-scoped `focus` settings group now stores:

```json
{
  "defaultMinutes": 25,
  "restMinutes": 5,
  "longRestMinutes": 15,
  "longRestInterval": 4
}
```

`defaultMinutes`, `restMinutes`, `longRestMinutes`, and `longRestInterval` must be positive integers. They are persisted through the existing `PATCH /api/settings` route and are included in the normal settings export/reset behavior.

### Client Contract

The settings center exposes inputs for long-rest duration and long-rest interval alongside the existing Pomodoro and short-rest duration controls. `FocusModule` computes the next rest plan from the persisted settings and the current account's completed Pomodoro count: cycles whose completed count is divisible by `longRestInterval` use `longRestMinutes`; other cycles use `restMinutes`. The rest-cycle record still writes through the existing `/api/focus/rest-cycles` route.

### Verification

`npm run test:focus-rest-cycle-client` verifies the short-rest/long-rest selection rule and safe fallbacks. `npm run test:settings` verifies `longRestMinutes` and `longRestInterval` persist through `/api/settings`, rejects an invalid interval, and remain compatible with settings export. `npm run test:focus` remains the HTTP/SQLite regression for Pomodoro session and rest-cycle persistence.

## Slice 78: Focus Report Dimensions

PM-12 now extends the existing focus trend report with account-scoped task, list, and tag dimensions. The report still reads from real `focus_sessions` rows and joins existing task metadata instead of creating analytics snapshots or frontend-only summaries.

### Data Model

No new table is required. `/api/focus/reports` aggregates:

- `focus_sessions` for the report time window.
- `tasks` for linked task titles and list ids.
- `lists` for linked list names.
- `task_tags` and `tags` for tag dimensions.

Unlinked focus sessions are returned in explicit null-id buckets such as `未关联任务`, `未关联清单`, and `未标记`.

### API Contract

`GET /api/focus/reports?range=day|week|month` still returns `{ report }`, with the existing `{ range, buckets, totalCount, totalDurationSec }` fields plus:

```json
{
  "byTask": [{ "id": "task-id-or-null", "name": "Draft report", "count": 1, "durationSec": 1500 }],
  "byList": [{ "id": "list-id-or-null", "name": "Deep Work", "count": 1, "durationSec": 1500 }],
  "byTag": [{ "id": "tag-id-or-null", "name": "Writing", "count": 1, "durationSec": 1500 }]
}
```

Tag dimensions count a tagged focus session once for each tag attached to the linked task, so tag dimension totals may exceed the report total when one task has multiple tags.

### Client Contract

`FocusModule` renders the weekly trend buckets and then shows the top task, list, and tag dimensions from the same report response. Empty dimensions render an empty state; the client does not synthesize analytics from cached sessions.

### Verification

`npm run test:focus` creates a real list, tag, task, unlinked focus session, linked focus session, and rest cycle over HTTP. It verifies `/api/focus/reports?range=week` aggregates by task, list, and tag, includes unlinked/untagged buckets, and checks SQLite for the `focus_sessions` -> `tasks` -> `task_tags` source rows. Client and server typecheck plus client build verify the expanded DTO and UI compile.

## Slice 79: Calendar Blank Slot Drag Create

CAL-13 now supports selecting an empty time range in the calendar timeline instead of only creating a fixed one-hour task on click. The UI selection is client-side, but creation still goes through the real task API and persists the resulting timed task in SQLite.

### Data Model

No new table is required. Drag-created calendar tasks are normal `tasks` rows:

- `start_date` stores the selected start timestamp.
- `due_date` stores the selected end timestamp.
- `is_all_day` is `0`.

### API Contract

The client continues to call `POST /api/tasks` with:

```json
{
  "title": "新任务",
  "startDate": "ISO timestamp",
  "dueDate": "ISO timestamp",
  "isAllDay": false
}
```

The existing task route validates the time range, applies normal account defaults, writes the task row, and makes it visible through `GET /api/tasks?from=&to=`.

### Client Contract

`CalendarGrid` handles pointer down / move / up on empty day columns. Dragging down or up creates a visible selection preview snapped to 15-minute increments. Releasing the pointer calls `onCreateAt(day, startMinutes, durationMinutes)`. A click without a drag preserves the previous one-hour quick-create behavior, clamped to the end of the day.

Existing scheduled-task drag, resize, detail popover, and right-panel drop scheduling remain on the same real task update paths.

### Verification

`npm run test:calendar-blank-selection-client` verifies timeline offset snapping, up/down drag selection, click fallback, and near-midnight clamping. `npm run test:calendar` creates a timed task through HTTP with the selected start/end shape, verifies it is returned by the calendar range query, and checks the SQLite `tasks` row for `start_date`, `due_date`, and `is_all_day=0`. Client/server typecheck and client build verify the new UI contract compiles.

## Slice 80: Calendar Cross-Day And Overlap Layout

CAL-15 now renders timed tasks by day segment instead of only rendering them on their start day. A task whose time range crosses midnight appears on each affected day, clipped to that day. Tasks that overlap within the same day are assigned lanes and displayed side-by-side.

### Data Model

No new table is required. The layout reads existing timed task fields:

- `tasks.start_date`
- `tasks.due_date`
- `tasks.is_all_day = 0`

The backend range query already returns cross-day tasks when `start_date <= to AND due_date >= from`; the client layout consumes those real rows.

### Client Contract

`taskSegmentsForDay(tasks, day)`:

- Excludes all-day and invalid timed tasks.
- Includes tasks whose time interval intersects the day.
- Clips segment start/end to the day boundary.
- Marks `startsBeforeDay` and `endsAfterDay` for cross-day visual indicators.
- Assigns `lane` and `laneCount` per overlapping cluster so simultaneous blocks are displayed side-by-side while non-overlapping blocks retain full width.

`CalendarGrid` renders those segments in each day column, keeps existing move/resize/drop scheduling paths, and shows a dashed top/bottom edge when a segment continues across days.

### Verification

`npm run test:calendar-overlap-layout-client` verifies cross-day first/second-day clipping, cross-day flags, overlapping two-lane layout, and full-width non-overlap layout. `npm run test:calendar` creates cross-day and overlapping timed tasks through `POST /api/tasks`, verifies range queries return the cross-day task on the second day and both overlapping tasks on their day, and checks SQLite task rows. Client/server typecheck and client build verify the UI contract compiles.

## Slice 81: Calendar Subtask Hierarchy Blocks

CAL-16 now makes scheduled subtasks distinguishable in the calendar. A timed subtask block shows a weak direct-parent hint, exposes the full hierarchy path on hover, and opens the subtask's own detail modal when clicked.

### Data Model

No new table is required. Task hierarchy already uses `tasks.parent_id`. Task DTOs now include derived, account-scoped hierarchy metadata:

```json
{
  "parentTitle": "学习 AI Agent",
  "hierarchyPath": ["年度学习", "学习 AI Agent", "阅读第 1 章"]
}
```

`parentTitle` is the direct parent title or `null` for top-level tasks. `hierarchyPath` is ordered from top-level ancestor to the current task. The server derives both from the current user's `tasks` rows during normal task hydration.

### API Contract

All existing task read paths that return `TaskDTO` keep their current routes and now include the hierarchy fields:

- `GET /api/tasks?from=&to=`
- `GET /api/tasks/:id`
- `GET /api/tasks?parentId=`

No parallel calendar-only hierarchy route is added.

### Client Contract

`CalendarGrid` renders `parentTitle` as a muted parent hint above the child title. The block `title` attribute uses `hierarchyPath.join(" / ")` for hover context. `CalendarModule` opens `TaskDetailModal` directly for tasks with `parentId`, so clicking a subtask block enters the subtask detail rather than the parent task. Top-level tasks keep the existing lightweight calendar popover.

### Verification

`npm run test:calendar-task-hierarchy-client` verifies parent hints and hierarchy path labels. `npm run test:calendar` creates a real parent chain and a scheduled subtask through `POST /api/tasks`, verifies the calendar range query returns the subtask with `parentTitle` and full `hierarchyPath`, and checks SQLite `parent_id/start_date/due_date/is_all_day`. Client/server typecheck and client build verify the calendar UI and modal entry compile.

## Slice 82: Focus Achievements

PM-13 now has a real milestone/achievement surface derived from focus history. Achievements are not stored as a fake client list; they are calculated from the current account's `focus_sessions` rows every time the API is read.

### Data Model

No new table is required. The achievement source of truth is:

- `focus_sessions.is_pomodoro`
- `focus_sessions.duration_sec`
- `focus_sessions.ended_at`

### API Contract

`GET /api/focus/achievements` returns:

```json
{
  "achievements": [
    {
      "id": "first_pomodoro",
      "title": "第一次番茄",
      "description": "完成 1 个番茄专注",
      "metric": "pomodoro_count",
      "target": 1,
      "progress": 1,
      "achieved": true,
      "achievedAt": "ISO timestamp"
    }
  ]
}
```

Supported metrics are `pomodoro_count`, `focus_duration_sec`, and `daily_pomodoro_count`. `progress` is capped at `target`, and `achievedAt` is the first focus-session end time at which the milestone threshold was reached.

### Client Contract

`FocusModule` loads achievements from `/api/focus/achievements` alongside real sessions, stats, sounds, and reports. The UI shows achieved count and per-achievement progress bars. It does not compute independent achievement state from cached client sessions.

### Verification

`npm run test:focus` creates real Pomodoro sessions through `POST /api/focus/sessions`, calls `/api/focus/achievements`, verifies achieved and locked milestones plus progress values, and checks SQLite `focus_sessions` row count/duration as the source rows. Client/server typecheck and client build verify the API and UI contracts compile.

## Slice 83: Persistent Important Task Reminders

N-02 now has a real persistent reminder path for important task reminders. Normal task reminders keep the existing one-shot behavior. High-priority or important tasks repeat until the user confirms a related notification or completes the task.

### Data Model

No new table is required. The source of truth is:

- `tasks.priority >= 3` or `tasks.is_important = 1`
- `task_reminders.status`
- `task_reminders.remind_at`
- `notifications.read_at`
- `notifications.target_type = "task_reminder"`

For important reminders, the runner writes the next due time back to `task_reminders.remind_at` and keeps `status = "scheduled"`. Once any notification for that reminder is read, the next runner tick sets the reminder to `sent`.

### API Contract

`POST /api/reminder-runner/tick` keeps the existing response:

```json
{
  "created": 1,
  "notifications": [
    {
      "type": "task_reminder",
      "targetType": "task_reminder",
      "targetId": "reminder-id-or-repeat-id"
    }
  ]
}
```

For the first important reminder notification, `targetId` is the reminder id. For repeat notifications, `targetId` is `${reminderId}:repeat:${remindAt}` so each repeat is persisted as a distinct notification row under the existing unique target index.

### Verification

`npm run test:notifications` creates a high-priority task through `POST /api/tasks`, creates its reminder through `POST /api/tasks/:id/reminders`, runs the reminder runner, advances the real SQLite `task_reminders.remind_at` timestamp, verifies a second repeat notification is created, reads the repeat notification, advances `remind_at` again, and verifies the runner stops creating notifications while the reminder row becomes `sent`.

## Slice 84: Recurring Task Next Instance

T-11/T-12 recurrence metadata now has a real execution path. Completing a dated recurring task creates the next task instance instead of only storing `recurrenceRule` on the completed row.

### Data Model

No new table is required. The source rows are:

- `tasks.recurrence_rule`
- `tasks.start_date`
- `tasks.due_date`
- `task_tags`
- `task_reminders`

The generated next instance is a normal `tasks` row with `source = "recurrence"`, `status = "todo"`, shifted `start_date`/`due_date`, copied tags, and copied reminders shifted by the same date delta.

### API Contract

`PATCH /api/tasks/:id` with `{ "status": "done" }` or `{ "completed": true }` keeps returning the completed task. If the task transitions from open to completed and its recurrence rule is one of `FREQ=DAILY`, `FREQ=WEEKLY`, `FREQ=MONTHLY`, or `FREQ=YEARLY`, the server creates the next instance in the same transaction path. Repeating the same patch on an already completed task does not create duplicate next instances.

### Verification

`npm run test:metadata` creates a weekly timed task through `POST /api/tasks`, attaches a real tag and reminder, completes it through `PATCH /api/tasks/:id`, verifies `/api/tasks?view=active` returns the generated `source="recurrence"` task with dates shifted by one week, and checks SQLite for the new task, copied tag relation, and shifted reminder row.

## Slice 85: Defer Current Recurring Task Instance

Recurring tasks now support a real "defer this occurrence" operation. This covers the PRD recurrence rule for postponing the current instance without marking it completed and without generating a duplicate task.

### Data Model

No new table is required. The operation updates:

- `tasks.start_date`
- `tasks.due_date`
- `task_reminders.remind_at`
- `task_reminders.status`

The task stays open. Existing reminders are shifted by the same delta and reset to `scheduled`.

### API Contract

`POST /api/tasks/:id/recurrence/defer` returns:

```json
{
  "task": {
    "id": "task-id",
    "startDate": "shifted ISO timestamp",
    "dueDate": "shifted ISO timestamp",
    "completed": false,
    "reminders": [
      { "remindAt": "shifted ISO timestamp", "status": "scheduled" }
    ]
  }
}
```

The route returns `400 invalid` if the task has no `recurrenceRule` or no date anchor to shift.

### Verification

`npm run test:metadata` creates a daily timed recurring task through `POST /api/tasks`, creates a reminder through `POST /api/tasks/:id/reminders`, calls `POST /api/tasks/:id/recurrence/defer`, verifies the response has task dates and reminder time shifted by one day, and checks SQLite for the updated `tasks` and `task_reminders` rows.

## Slice 86: Tag Hierarchy And Merge

TG-03 and TG-04 now have real backend behavior. Tags can be organized under a parent tag, and duplicate tags can be merged into a target tag without losing task associations.

### Data Model

`tags` now includes:

- `parent_id TEXT`

`TagDTO` includes `parentId`. Parent updates reject self-parenting and cycles. Tag merge migrates `task_tags` rows from the source tag to the target tag, ignores duplicates already present on the same task, reparents child tags to the target tag, then deletes the source tag.

### API Contract

- `POST /api/tags` accepts `{ name, color?, parentId? }`
- `PATCH /api/tags/:id` accepts `{ name?, color?, parentId?, sortOrder? }`
- `POST /api/tags/:id/merge` accepts `{ targetId }` and returns merge counts

### Client Contract

The Settings center exposes tag hierarchy and merge controls in the task-defaults area. Parent changes call `PATCH /api/tags/:id`; merge changes call `POST /api/tags/:id/merge`, refresh the real tag list, and update default tag settings if the merged source tag had been selected as a default.

### Verification

`npm run test:metadata` creates a parent tag, a child tag, and a duplicate alias tag through HTTP, attaches the alias to a real task, calls `POST /api/tags/:id/merge`, verifies the source tag disappears, verifies the task now has the target tag, and checks SQLite for `tags.parent_id` plus the migrated `task_tags` rows. Client/server typecheck and `npm run build -w client` verify the Settings UI and API client compile.

## Slice 87: Skip Current Recurring Task Instance

Recurring tasks now support a real "skip this occurrence" operation. Skipping does not count as completion and does not leave the skipped instance in active task lists.

### Data Model

`TaskStatus` now includes:

- `skipped`

The skipped instance remains in `tasks` with `status = "skipped"`, `completed = 0`, and `completed_at = NULL`. Scheduled reminders on the skipped instance are marked `cancelled`. The generated next instance is a normal open task with copied reminders shifted by the recurrence delta.

Active task queries, parent subtask lists, list task counts, smart-list counts, matrix view, unclassified view, and calendar range queries exclude `status = "skipped"` unless the task is fetched directly by id.

### API Contract

`POST /api/tasks/:id/recurrence/skip` returns:

```json
{
  "task": {
    "id": "skipped-task-id",
    "status": "skipped",
    "completed": false
  },
  "nextTask": {
    "id": "next-task-id",
    "source": "recurrence",
    "status": "todo"
  }
}
```

Calling the route again on the same skipped instance returns `nextTask: null` and does not create duplicate future instances.

### Client Contract

`TaskDetailModal` shows `顺延本次` and `跳过本次` controls for recurring tasks. The controls call the real recurrence routes and reload the task through the API.

### Verification

`npm run test:metadata` creates a daily recurring task and reminder, calls `POST /api/tasks/:id/recurrence/skip`, verifies the current task becomes `skipped` and not completed, verifies the current reminder is `cancelled`, verifies the generated next task and reminder are shifted one day, verifies a repeated skip call is idempotent, verifies the skipped task is absent from `/api/tasks?view=active`, and checks SQLite rows for the skipped task plus both reminder rows. `npm run test:task-list-view`, client/server typecheck, and `npm run build -w client` verify list filtering and the task-detail UI compile.

## Slice 88: Existing Task Reparent And Conversion

T-19 and SUB-06 now have a real task-conversion path instead of relying on an unsafe generic `parentId` patch. Users can attach an existing independent task as a subtask, or promote a subtask back to an independent task. The backend enforces the PRD's five-level hierarchy limit and rejects cycles.

### Data Model

No new table is required. The source of truth remains:

- `tasks.parent_id`
- `tasks.list_id`
- `tasks.sort_order`
- `task_activity_logs`

When a task is attached under a parent, it inherits the parent task's list and receives the next child `sort_order`. When a task is promoted, it keeps its current list and receives a top-level `sort_order`. Old and new parents are reconciled so roll-up completion/progress stays accurate.

### API Contract

`POST /api/tasks/:id/reparent` accepts:

```json
{ "parentId": "target-parent-task-id-or-null" }
```

It returns `{ "task": TaskDTO }`. The route returns:

- `404 not_found` when the task or parent does not belong to the current account.
- `409 hierarchy_cycle` when moving a task under itself or one of its descendants would create a cycle.
- `400 max_depth_exceeded` when the resulting hierarchy would exceed five levels.

The legacy `PATCH /api/tasks/:id` path still accepts `parentId`, but it delegates to the same reparent logic so no client can bypass these rules.

### Client Contract

`TaskDetailModal` exposes a search field for finding existing active tasks and attaching them under the current task through the real reparent route. Existing subtask "promote" actions call the same route with `parentId:null`.

### Verification

`npm run test:metadata` attaches an existing task under a real parent through HTTP, verifies the parent subtask count, rejects a parent-under-child cycle, promotes the task back to top level, rejects a sixth hierarchy level, rejects another account's reparent attempt with `404`, and checks SQLite for `tasks.parent_id = NULL` plus two `task_reparented` activity rows. Client/server typecheck and `npm run build -w client` verify the API client and task-detail UI compile.

## Slice 89: List Type Task Or Note

L-04 now has a persisted list-type contract. A custom list can be a normal task list or a note list. Note lists are still account-scoped lists with real rows, but their items are reference records rather than completable tasks.

### Data Model

`lists` now includes:

- `type TEXT NOT NULL DEFAULT 'task'`

Allowed values are `task` and `note`. Existing lists migrate to `task`; inbox remains a task list.

### API Contract

- `POST /api/lists` accepts `{ name, color?, icon?, folderId?, type?: "task"|"note" }`.
- `PATCH /api/lists/:id` accepts `{ type?: "task"|"note" }` alongside existing list fields.
- `GET /api/lists` returns `ListDTO.type`.

Invalid types return `400 invalid_list_type`. Creating or updating a task into `completed:true` / `status:"done"` while its final list type is `note` returns `400 note_list_no_completion`. Batch updates use the same backend rule.

### Client Contract

The sidebar create-list form exposes `任务清单` / `笔记清单`. Existing custom lists expose a compact type selector and show a `Note` badge when the list is a note list. Task rows in note lists render a static record marker instead of a completion checkbox; all writes still go through the real task/list APIs.

### Verification

`npm run test:list-batch` creates a note list through HTTP, verifies the returned type, creates a record in that list, verifies direct completion and batch completion both fail with `note_list_no_completion`, and checks SQLite for `lists.type = "note"` plus an incomplete task row. Client/server typecheck and `npm run build -w client` verify the DTO, sidebar, API client, and note-list row rendering compile.

## Slice 91: Task Note Markdown Preview

T-15 now has a real Markdown note surface instead of a plain text-only field. The persisted data model is unchanged: `tasks.note` stores the Markdown source text. The existing `POST /api/tasks` and `PATCH /api/tasks/:id` paths remain authoritative for writing notes, so rich note content still travels through real HTTP and SQLite.

### Client Contract

`TaskDetailModal` exposes Edit / Preview modes for task notes. Edit mode keeps the existing textarea and saves through `PATCH /api/tasks/:id`. Preview mode renders headings, paragraphs, unordered lists, ordered lists, inline code, emphasis, strong text, and links. Link rendering is safe-by-default: only `http:`, `https:`, and `mailto:` URLs become anchors; unsafe or relative Markdown links are shown as text and never injected as HTML.

### Verification

`npm run test:task-note-markdown-client` verifies Markdown block parsing, list parsing, inline code, emphasis, safe link rendering, and unsafe-link rejection. `npm run test:metadata` now creates a task with Markdown note text through HTTP and checks the same source text in both the task DTO and SQLite `tasks.note`. Client/server typecheck and `npm run build -w client` verify the task detail UI compiles.

## Slice 92: Today Tasks Desktop Widget Data

WID-01 now has a real widget-host contract instead of only a stored template. Existing `desktop_widgets` rows remain the configuration source of truth.

### API Contract

- `GET /api/desktop/widgets/:id/data`
  - For `type:"today-tasks"` returns `{ data }` with the saved widget config, `generatedAt`, real `TaskDTO[]`, and counts `{ shown, total, overdue }`.
  - Disabled widgets return `409 desktop_widget_disabled`.
  - Unknown future widget types return `501 desktop_widget_data_not_implemented`; all six PRD widget templates now have data implementations.
- `POST /api/desktop/widgets/:id/actions`
  - For `type:"today-tasks"` accepts `{ action:"complete_task", taskId }`.
  - The route verifies the task is currently part of that widget's real today data, respects `config.allowComplete`, calls the shared `repo.updateTask` path, and returns the completed task plus refreshed widget data.

### Verification

`npm run test:desktop` now creates overdue/today/future/completed tasks through HTTP, creates a `today-tasks` widget, verifies the widget data contains only real today-visible open tasks, completes one task through the widget action, verifies the refreshed data excludes it, rejects invalid actions and disabled completion, and checks SQLite for both the widget config and the task `completed` write.

## Slice 93: Inbox Quick Add Desktop Widget

WID-02 now uses the same widget-host data/action boundary as WID-01. `GET /api/desktop/widgets/:id/data` supports `type:"inbox-quick-add"` and returns the saved widget config, generated timestamp, recent real inbox tasks, and counts `{ shown, total }`.

`POST /api/desktop/widgets/:id/actions` supports `{ action:"quick_add_task", text }` for `inbox-quick-add`. The route respects `config.quickAdd`, validates non-empty text, creates a real task in the account inbox through `repo.createTask`, marks `source:"desktop_widget"`, and returns refreshed widget data. Invalid actions return `400`; disabled quick add returns `409 desktop_widget_action_disabled`.

`npm run test:desktop` now creates an `inbox-quick-add` widget, verifies widget data reads real inbox tasks, creates a task through the widget action, verifies the new task appears in refreshed data, rejects wrong actions and disabled quick-add config, exports the widget row, and checks SQLite for the widget config plus a task row whose `source` is `desktop_widget` and whose `list_id` is the account inbox.

## Slice 94: Habit Check-In Desktop Widget

WID-03 now uses the same widget-host data/action boundary as WID-01 and WID-02. `GET /api/desktop/widgets/:id/data` supports `type:"habit-checkin"` and returns the saved widget config, generated timestamp, local `YYYY-MM-DD` date, scheduled real `HabitDTO[]`, and counts `{ shown, total, checked }`.

`POST /api/desktop/widgets/:id/actions` supports `{ action:"toggle_habit", habitId, value?, note? }` for `habit-checkin`. The route respects `config.allowCheckin`, verifies the habit is visible in today's widget data, calls the shared `habitsRepo.toggleCheckin` path, returns the refreshed habit/check-in result plus refreshed widget data, and writes a real row to `habit_checkins`. Invalid actions return `400`; disabled check-in returns `409 desktop_widget_action_disabled`; non-visible habits return `404`.

`npm run test:desktop` now creates a scheduled habit through HTTP, creates a `habit-checkin` widget, verifies widget data reads the real habit and unchecked counts, toggles the habit through the widget action, verifies refreshed data and check-in details, rejects wrong actions and disabled check-in config, exports the widget row, and checks SQLite for the widget config plus the `habit_checkins` row written by the widget action.

## Slice 95: Focus Timer Desktop Widget

WID-04 now has a persisted widget timer state instead of a UI-only countdown. A new `desktop_focus_timers` table stores per-user/per-widget timer status, target duration, accumulated elapsed seconds, start/pause timestamps, and update time. Completed focus records still belong to the existing `focus_sessions` contract.

`GET /api/desktop/widgets/:id/data` supports `type:"focus-timer"` and returns `{ timer, stats, allowStartPause }`, where `timer` is calculated from the persisted row and current server time, and `stats` comes from the real `focusRepo.stats` aggregate. `POST /api/desktop/widgets/:id/actions` supports `{ action:"start_focus" }` and `{ action:"pause_focus" }`, respects `config.allowStartPause`, writes `desktop_focus_timers`, returns refreshed widget data, rejects invalid actions with `400`, rejects disabled start/pause with `409 desktop_widget_action_disabled`, and rejects pause while not running with `409 desktop_focus_timer_not_running`.

`npm run test:desktop` now creates a `focus-timer` widget, verifies idle data and real focus stats, rejects pause before start, starts and pauses the timer through widget actions, rejects invalid and disabled actions, exports the widget row, and checks SQLite for the widget config plus the persisted `desktop_focus_timers` paused state.

## Slice 96: Countdowns Desktop Widget

WID-06 now has a real read-only widget data contract. `GET /api/desktop/widgets/:id/data` supports `type:"countdowns"` and returns saved widget config, generated timestamp, real `CountdownDTO[]`, counts `{ shown, total, pinned, elapsed }`, and the resolved `pinnedFirst` flag.

The widget uses the existing `countdownsRepo.listCountdowns` source of truth, including `effectiveDate` and signed `daysRemaining`. `config.limit` truncates the returned list. `config.pinnedFirst:false` disables pinned-priority ordering and sorts by date only; the default keeps pinned items first. WID-06 has no widget action requirement, so `POST /api/desktop/widgets/:id/actions` still returns `501 desktop_widget_action_not_implemented` for `countdowns`.

`npm run test:desktop` now creates three countdowns through HTTP, creates a `countdowns` widget, verifies widget data reads real countdown rows, validates pinned-first ordering, limit, pinned count, and elapsed count, exports the widget row, and checks SQLite for the widget config plus the three countdown rows.

## Slice 97: Goal Progress Desktop Widget

WID-05 now has a real read-only widget data contract. `GET /api/desktop/widgets/:id/data` supports `type:"goal-progress"` and returns saved widget config, generated timestamp, real goals, progress rollups, counts `{ shown, total, active, completed }`, and the resolved `showTodaySuggestion` flag.

The widget uses existing `repo.listGoals` and `repo.getGoalTree` data. For each shown non-archived goal, progress includes total/completed task counts, total/completed estimated minutes, and a percent derived from estimated minutes when available, otherwise task counts; completed goals report 100%. When `config.showTodaySuggestion` is true, the widget suggests a real open goal task scheduled or due today, falling back to the highest-priority open goal task. WID-05 has no widget action requirement, so `POST /api/desktop/widgets/:id/actions` still returns `501 desktop_widget_action_not_implemented` for `goal-progress`.

`npm run test:desktop` now creates active and completed goals through HTTP, creates real goal tasks, completes one task, schedules another for today, creates a `goal-progress` widget, verifies progress and today suggestion from widget data, exports the widget row, and checks SQLite for the widget config plus the goal/task fixture rows.

## Slice 98: One-Time Normal Rule Override

RULE-05 and the PRD conflict policy now have a real "temporary breakthrough" path for non-hard personal rules. Hard rules remain non-overridable unless the user edits or disables the rule itself; normal and preference rules can be ignored for one generated proposal without mutating the rule row.

### API Contract

`POST /api/goals/:id/schedule-proposals` accepts:

```json
{
  "ignoredRuleIds": ["normal-or-preference-rule-id"],
  "mode": "initial_schedule | reschedule",
  "trigger": "rule_override:<conflict-id>:<rule-id>"
}
```

- `ignoredRuleIds` must be an array of enabled rules that belong to the current account and are scoped to the target goal.
- Referencing a hard rule returns `400 hard_rule_cannot_be_ignored`.
- Referencing a disabled, deleted, cross-account, or out-of-scope rule returns `400 invalid_ignored_rule`.
- Ignored rules are removed only from that proposal's rule evaluation. The persisted `personal_schedule_rules` row remains enabled.
- The draft proposal persists an informational conflict with `type:"rule_override"`, `severity:"info"`, and the ignored `ruleIds` so the confirmation page and audit trail show that a one-time override was used.

### Client Contract

The rule conflict action builder exposes `临时突破「规则名」一次` only for enabled `normal` or `preference` rules. Clicking it calls the existing schedule-proposal route with `ignoredRuleIds`; it does not call the rule PATCH route and does not disable the rule. The generated proposal is still a draft that requires normal confirmation before task times are written.

### Verification

`npm run test:schedule-rules` verifies hard rules return `hard_rule_cannot_be_ignored`, a normal blocking rule first causes a real `schedule_overflow`, then `ignoredRuleIds` generates a schedulable draft with a persisted `rule_override` conflict, and confirmation writes the task's SQLite `start_date` / `due_date`. `npm run test:schedule-rule-conflict-actions-client` verifies hard rules do not expose override actions while normal rules do, including the correct `ignoredRuleIds` proposal input.

## Slice 99: Goal Task Schedule Status

TASK-04 now has a PRD-facing schedule status instead of requiring the client to infer every task state from unrelated fields. The source of truth remains the existing `tasks` row; no separate status table is introduced.

### API Contract

Every `TaskDTO` now includes:

```json
{
  "scheduleStatus": "unscheduled | scheduled | doing | completed | overdue | skipped"
}
```

The backend derives it from real persisted fields:

- `skipped` when `tasks.status = 'skipped'`.
- `completed` when `tasks.completed = 1` or `tasks.status = 'done'`.
- `doing` when `tasks.status = 'doing'` or `actual_start_at` exists without `actual_end_at`.
- `overdue` when an open task's `due_date` or `planned_end_at` is before the server's current time.
- `scheduled` when the open task has a timed calendar block (`start_date` + `due_date` + `is_all_day=0`) or a planned proposal block.
- `unscheduled` otherwise.

### Client Contract

The goal task list uses `scheduleStatus` to show the PRD labels `未排期 / 已排期 / 进行中 / 已完成 / 延期 / 跳过`. The existing client helper still falls back to deriving the state from task fields when older cached data lacks the new field.

### Verification

`npm run test:goals` creates tasks through the real goal API, updates them through `PATCH /api/tasks/:id`, reloads `/api/goals/:id/tree`, and verifies `unscheduled`, `scheduled`, `completed`, and `overdue` schedule statuses from the HTTP DTO while checking the underlying SQLite rows used by the same scenario. `npm run test:goal-task-status-client` verifies the UI helper honors the API-provided status and retains fallback behavior.

## Slice 100: Task Category Rule Minimum Block Duration

RULE-01/RULE-05 and the PRD task-category rule example now affect the real scheduling engine. A `task_category` rule can require matching tasks to use a minimum block size, for example writing work must be scheduled in blocks of at least 90 minutes.

### API Contract

`POST /api/schedule-rules` and `PATCH /api/schedule-rules/:id` accept task-category actions:

```json
{
  "type": "task_category",
  "condition": { "taskType": "writing" },
  "action": { "effect": "min_block", "minScheduleMinutes": 90 }
}
```

- `condition.taskType` matches `tasks.schedule_task_type`. Empty `taskType` applies to all task types.
- `condition.taskTypes` may also be an array of task type strings.
- `action.minScheduleMinutes`, `action.minMinutes`, `condition.minScheduleMinutes`, or `condition.minMinutes` can define the minimum block size.
- The minimum must be an integer from 15 to 1440; invalid values return `400 invalid_schedule_rule`.
- During `POST /api/goals/:id/schedule-proposals`, matching task-category rules raise the task's effective `minScheduleMinutes`. Split proposals use that effective minimum, include the rule ID in each matching change, and include the matched rule plus the minimum-block reason in explanations.

### Client Contract

The personal-rule form's `任务分类` rule type now asks for both task type and minimum block minutes. Saving still calls the real schedule-rule API; no client-side fake rule state is introduced.

### Verification

`npm run test:schedule-rules` now creates an invalid task-category rule and verifies `400 invalid_schedule_rule`, then creates a writing rule with `minScheduleMinutes:90`, a real splittable writing task, generates a schedule proposal, verifies two 90-minute split changes with matched-rule explanations, confirms the proposal, and checks SQLite for the persisted rule action, stored proposal JSON, and two generated `schedule_split` child task rows.

## Slice 101: Energy Preference Scheduling Window

SCHED-03 and the PRD's energy-preference rule now affect actual slot selection instead of only appearing as metadata. Energy preference remains a soft rule: the scheduler tries the preferred time window first, then falls back to the normal work window if no preferred slot can fit.

### API Contract

`energy_preference` schedule rules can define an optional preferred window:

```json
{
  "type": "energy_preference",
  "condition": {
    "energyType": "medium",
    "startTime": "10:00",
    "endTime": "12:00",
    "daysOfWeek": [1, 2, 3, 4, 5]
  },
  "action": { "effect": "prefer", "period": "morning" }
}
```

- `condition.energyType` matches `tasks.schedule_energy_type`; omitted energy type matches any task with an energy type.
- If `startTime` or `endTime` is supplied, both must be valid `HH:mm` values; otherwise the rule can fall back to `action.period` / `condition.period` (`morning`, `afternoon`, `evening`).
- `daysOfWeek` is optional and must contain integers `0-6`.
- Preferred windows are clipped to the goal's scheduling range and `availableTimeRule`.
- If a preferred window is unavailable, the proposal still uses the first conflict-free fallback slot and explains that fallback.

### Verification

`npm run test:schedule-rules` now creates a scoped medium-energy preference rule for 10:00-12:00, rejects an invalid one-sided time window with `400 invalid_schedule_rule`, creates a real medium-energy task, generates a proposal that starts at 10:00 instead of the goal's 09:00 work-window start, confirms it, and checks SQLite for the stored rule id plus preferred-window explanation in `schedule_proposals`.

## Slice 102: Precise Task Attribute Rule Matching

RULE-05/SCHED-03 explanations now distinguish general active scheduling constraints from task-attribute rules. `energy_preference` and `task_category` rules are attached to a proposal change only when the current task's `scheduleEnergyType` or `scheduleTaskType` actually matches the rule.

### API Contract

`POST /api/goals/:id/schedule-proposals` still returns the same proposal shape:

```json
{
  "changes": [{ "ruleIds": ["matched-rule-id"] }],
  "explanations": [{ "matchedRules": [{ "id": "matched-rule-id" }] }]
}
```

- General constraints (`time_boundary`, `fixed_habit`, `buffer`, `reminder`, `plan_priority`) remain active schedule constraints for the scoped goal and can appear in `ruleIds`.
- `energy_preference` appears when its `condition.energyType` matches the task's `scheduleEnergyType`. If the task has not been classified with an energy type yet, energy-preference rules remain candidate guidance so DayPilot can still show that the proposal was shaped by pending energy rules.
- `task_category` appears only when `condition.taskType` / `condition.taskTypes` matches the task's `scheduleTaskType`; unmatched category rules no longer make the confirmation page or DayPilot dashboard look as if they influenced the task.
- Overflow conflicts use the same precise rule-id set for that task, so mismatch-only metadata rules are not reported as blockers.

### Verification

`npm run test:schedule-rules` now creates a high-energy writing task plus two scoped but non-matching rules: a low-energy preference and a meeting-category minimum block. The generated HTTP proposal keeps hard boundary, reminder, plan-priority, and matching high-energy rules, but excludes the non-matching energy/category rules from `changes[].ruleIds` and `explanations[].matchedRules`; the existing SQLite checks still prove preview and proposal rows are persisted through the real database.

## Slice 103: Applied Energy Preference Rule Precision

SCHED-03 explanations now report the energy-preference rule that actually selected the time window for a proposal segment, not every matching energy rule for the task. This keeps the confirmation page and DayPilot rule-impact list from overstating why a task landed in a specific slot.

### API Contract

`POST /api/goals/:id/schedule-proposals` keeps the existing proposal shape, but energy-preference `ruleIds` are now segment-specific:

- When a preferred energy window is used, `changes[].ruleIds` and `explanations[].matchedRules` include only the applied energy rule for that segment.
- Other matching energy rules that were not used for the selected time window are omitted from that segment.
- If no preferred energy window can fit and the scheduler falls back to the normal work window, the proposal keeps matching energy rule IDs so the explanation can say preference rules existed but were unavailable.
- General scoped constraints and matching task-category rules continue to be included as before.

### Verification

`npm run test:schedule-rules` now creates two medium-energy preference rules for the same task: 10:00-12:00 and 14:00-16:00. The generated proposal starts at 10:00, includes only the 10:00 rule in the HTTP change and explanation, excludes the later-but-matching rule, confirms the proposal, and checks SQLite `schedule_proposals.changes_json` preserves the same applied-rule precision.

## Slice 104: DayPilot Plan Priority Task Ordering

DayPilot plan-priority rules now affect task execution ordering, not only the active-plan card order. The dashboard still treats overdue/today tasks as the first sort dimension, then uses enabled `plan_priority` rules to break ties between tasks with the same urgency.

### API Contract

`GET /api/goals/daypilot-dashboard` keeps the same response shape, but `topTasks` and `unscheduledTasks` are sorted from real SQLite rows with this precedence:

1. Task urgency bucket: overdue, due today, then later/no due date.
2. Enabled `plan_priority` score for the task's goal, derived from `personal_schedule_rules`.
3. Task `priority`.
4. Task due date or goal deadline.
5. Task creation time.

`scheduledTasks` remain ordered by actual scheduled time because that list is a chronological agenda.

### Verification

`npm run test:schedule-rules` now creates two same-priority, same-due-date dashboard tasks: one in a competing high-priority goal and one in the goal scoped by a `plan_priority` rule. The competing task is created first to prove creation order is not the tie-breaker. The real `/api/goals/daypilot-dashboard` response returns both tasks in `topTasks` and orders the task from the plan-priority goal first.

## Slice 105: Buffer Rule Capacity Explanation

RULE-05 explanations now make buffer-rule capacity impact visible. Buffer rules already reserve time after scheduled or busy blocks; proposal changes and overflow conflicts now say how many buffer minutes were applied so the confirmation page and DayPilot rule-impact list can explain why a slot moved or no longer fits.

### API Contract

`POST /api/goals/:id/schedule-proposals` keeps the existing proposal shape:

- When a scoped `buffer` rule is active, successful `changes[].reason` includes the applied buffer duration.
- The matching `explanations[].message` includes the same buffer duration and keeps the buffer rule in `matchedRules`.
- If buffer time reduces capacity enough that a task cannot fit, the `schedule_overflow` conflict message includes the buffer duration and keeps the buffer rule id in `ruleIds`.
- Buffer rules continue to be read from `personal_schedule_rules`; no new storage table or client-side rule state is introduced.

### Verification

`npm run test:schedule-rules` now creates a two-hour goal window, a scoped 15-minute buffer rule, and two real 60-minute tasks. The proposal schedules only the first task, records a `schedule_overflow` for the second task, includes the buffer rule id in both the change and conflict, mentions the 15-minute buffer in HTTP reason/explanation/conflict text, and verifies the same reason/conflict details are persisted in SQLite `schedule_proposals.changes_json` and `conflicts_json`.

## Slice 106: Active Time-Block Rule Precision

RULE-05 explanations now distinguish active time-block constraints from enabled but irrelevant time-boundary rules. A `time_boundary` or `fixed_habit` rule is attached to proposal changes only when it expands into at least one concrete blocked slot inside the generated proposal range.

### API Contract

`POST /api/goals/:id/schedule-proposals` keeps the same response shape:

- `time_boundary` and `fixed_habit` rules appear in `changes[].ruleIds` / `explanations[].matchedRules` only when `expandRuleBlocks` creates real blocks for the proposal range.
- Enabled time-block rules scoped to the goal but outside the date range or wrong weekday remain stored and enabled, but do not appear as matched rules for that proposal.
- Other general rules (`buffer`, `reminder`, `plan_priority`) keep their existing scoped-goal behavior.
- Task-attribute precision from Slice 102 and applied-energy precision from Slice 103 continue to apply.

### Verification

`npm run test:schedule-rules` now creates a Sunday-only time-boundary rule scoped to a Monday-Wednesday proposal range. The generated HTTP proposal still includes the active `No work after 21:30` rule, but excludes the Sunday-only rule from `changes[].ruleIds` and `explanations[].matchedRules`; the preview test also verifies the draft preview route still does not persist any additional rule rows in SQLite.

## Slice 107: Manual Adjustment Buffer-Tail Conflict Explanation

Manual adjustment validation now explains when a dragged proposal change conflicts with a buffer tail rather than the scheduled block itself. This keeps the confirmation page's "manual adjustment conflict" reason aligned with the actual server-side validation.

### API Contract

`PATCH /api/schedule-proposals/:id/changes/:changeKey` keeps the same request and response shape:

```json
{
  "plannedStartAt": "ISO timestamp",
  "plannedEndAt": "ISO timestamp"
}
```

- The server continues to validate the manual time against existing tasks, external events, rule blocks, other proposal changes, and scoped buffer rules.
- If the edited time overlaps only the buffer tail after a busy/proposal block, `changes[].reason` and the `manual_adjustment_conflict.message` name the active buffer duration.
- The conflict still uses `type:"manual_adjustment_conflict"` and remains a draft warning; no task dates are written until normal confirmation.
- Public DTO fields are unchanged; the buffer-tail marker is internal validation state only.

### Verification

`npm run test:schedule-rules` now creates a two-task proposal with a scoped 15-minute buffer rule, then calls the real manual-change PATCH route to move the second task into the first task's buffer tail. The HTTP response marks the change conflicting, mentions the `15-minute buffer` in both the change reason and manual conflict message, and SQLite `schedule_proposals.changes_json` / `conflicts_json` preserve the same explanation.

## Slice 108: Auto-Schedule Compatibility Route Uses Proposals

The legacy `POST /api/goals/:id/auto-schedule` shortcut now uses the same proposal engine as the DayPilot confirmation flow. It no longer writes task times through a separate rule-blind scheduler.

### API Contract

`POST /api/goals/:id/auto-schedule` keeps the existing compatibility response and adds the confirmed proposal:

```json
{
  "goal": {},
  "scheduled": [],
  "proposal": { "status": "confirmed" }
}
```

- The route internally calls the real schedule-proposal generator, then confirms the draft proposal.
- Personal schedule rules, calendar busy blocks, dependency ordering, split-task behavior, reminders, and proposal explanations follow the same logic as `POST /api/goals/:id/schedule-proposals` plus `POST /api/schedule-proposals/:id/confirm`.
- If the generated proposal has a blocking conflict, the route returns `409` before writing task dates, instead of partially scheduling through the old direct writer.
- If there are no eligible changes and no blocking conflicts, it returns `scheduled:[]` with the generated draft proposal for compatibility.

### Verification

`npm run test:schedule-rules` now creates a goal inside an active 21:30 time-boundary rule, calls the legacy `/auto-schedule` route, verifies the response includes a confirmed proposal with the personal rule id, verifies the scheduled task lands at 20:00-21:30, and checks SQLite `schedule_proposals` plus `tasks.start_date/due_date` to prove the shortcut went through the real proposal confirmation path.

## Slice 109: Remove Rule-Blind Auto-Schedule Writer

The old repository-level `autoScheduleGoal` writer has been removed so the compatibility route cannot be accidentally reconnected to a rule-blind scheduler. The only automatic scheduling entry point left is the proposal engine, followed by normal proposal confirmation.

### Contract

`POST /api/goals/:id/auto-schedule` remains the compatibility API from Slice 108:

- The route generates a real schedule proposal.
- Blocking proposal conflicts return `409` before task dates are written.
- Successful scheduling confirms the proposal and writes through the same confirmation path as the DayPilot page.
- There is no exported `repo.autoScheduleGoal` fallback that can update task dates without `schedule_proposals` audit data.

### Verification

`rg "\bautoScheduleGoal\b|\bparseTimeRule\b|\balignToWindow\b" server/src tests` must return no matches for the removed repository writer/helpers. `npm run test:schedule-rules` still verifies the compatibility route creates and confirms a real proposal before writing task dates, and `npm run test:goals` keeps the legacy API behavior covered for existing clients.
