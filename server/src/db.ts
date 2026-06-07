// Real SQLite persistence using Node 24's built-in node:sqlite (no native build step).
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? resolve(here, '../data/app.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id                  TEXT PRIMARY KEY,
    nickname            TEXT,
    avatar_url          TEXT,
    phone_masked        TEXT,
    email_masked        TEXT,
    status              TEXT NOT NULL DEFAULT 'normal',
    registered_at       TEXT NOT NULL,
    last_login_at       TEXT,
    delete_requested_at TEXT,
    delete_scheduled_at TEXT
  );

  CREATE TABLE IF NOT EXISTS auth_identities (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type               TEXT NOT NULL CHECK(type IN ('phone','email','oauth')),
    provider           TEXT,
    identifier_hash    TEXT NOT NULL,
    display_identifier TEXT NOT NULL,
    is_primary         INTEGER NOT NULL DEFAULT 0,
    verified_at        TEXT NOT NULL,
    bound_at           TEXT NOT NULL,
    unbound_at         TEXT,
    UNIQUE(type, identifier_hash)
  );

  CREATE TABLE IF NOT EXISTS auth_password_credentials (
    user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deleted_identity_reservations (
    id                 TEXT PRIMARY KEY,
    deleted_user_id    TEXT NOT NULL,
    type               TEXT NOT NULL CHECK(type IN ('phone','email','oauth')),
    provider           TEXT,
    identifier_hash    TEXT NOT NULL,
    display_identifier TEXT,
    reserved_at        TEXT NOT NULL,
    policy             TEXT NOT NULL DEFAULT 'block'
  );

  CREATE TABLE IF NOT EXISTS oauth_login_states (
    state         TEXT PRIMARY KEY,
    provider      TEXT NOT NULL,
    user_id       TEXT,
    purpose       TEXT NOT NULL DEFAULT 'login',
    code_verifier TEXT NOT NULL,
    redirect_uri  TEXT NOT NULL,
    scope         TEXT,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    consumed_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS login_sessions (
    id                       TEXT PRIMARY KEY,
    user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id                TEXT NOT NULL,
    device_name              TEXT,
    platform                 TEXT,
    app_version              TEXT,
    refresh_token_hash       TEXT NOT NULL,
    login_at                 TEXT NOT NULL,
    last_active_at           TEXT NOT NULL,
    access_token_expires_at  TEXT NOT NULL,
    refresh_token_expires_at TEXT NOT NULL,
    revoked_at               TEXT
  );

  CREATE TABLE IF NOT EXISTS verification_codes (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL CHECK(type IN ('phone','email')),
    identifier_hash TEXT NOT NULL,
    display_identifier TEXT,
    code_hash       TEXT NOT NULL,
    purpose         TEXT NOT NULL DEFAULT 'login',
    expires_at      TEXT NOT NULL,
    resend_after_at TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    consumed_at     TEXT,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS security_audit_logs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    ip          TEXT,
    user_agent  TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analytics_events (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
    session_id      TEXT,
    anonymous_id    TEXT,
    device_id       TEXT,
    event_name      TEXT NOT NULL,
    properties_json TEXT NOT NULL,
    source          TEXT,
    occurred_at     TEXT NOT NULL,
    received_at     TEXT NOT NULL,
    ip              TEXT,
    user_agent      TEXT
  );

  CREATE TABLE IF NOT EXISTS diagnostic_log_uploads (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    log_path     TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL,
    uploaded_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_operations (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_operation_id TEXT NOT NULL,
    entity_type         TEXT NOT NULL,
    entity_id           TEXT,
    action              TEXT NOT NULL,
    status              TEXT NOT NULL,
    base_updated_at     TEXT,
    client_created_at   TEXT,
    payload_json        TEXT NOT NULL,
    result_json         TEXT,
    error_code          TEXT,
    error_message       TEXT,
    received_at         TEXT NOT NULL,
    applied_at          TEXT,
    UNIQUE(user_id, client_operation_id)
  );

  CREATE TABLE IF NOT EXISTS lists (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    folder_id  TEXT REFERENCES list_folders(id) ON DELETE SET NULL,
    name       TEXT NOT NULL,
    color      TEXT,
    icon       TEXT,
    type       TEXT NOT NULL DEFAULT 'task' CHECK(type IN ('task','note')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_inbox   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS list_folders (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    collapsed  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    title             TEXT NOT NULL,
    note              TEXT,
    list_id           TEXT REFERENCES lists(id) ON DELETE SET NULL,
    priority          INTEGER NOT NULL DEFAULT 0,
    due_date          TEXT,
    start_date        TEXT,
    is_all_day        INTEGER NOT NULL DEFAULT 1,
    is_important      INTEGER,
    is_urgent         INTEGER,
    parent_id         TEXT,
    goal_id           TEXT,
    root_task_id      TEXT,
    level             INTEGER NOT NULL DEFAULT 1,
    planned_start_at  TEXT,
    planned_end_at    TEXT,
    actual_start_at   TEXT,
    actual_end_at     TEXT,
    dependency_task_ids TEXT,
    auto_schedule_enabled INTEGER NOT NULL DEFAULT 1,
    is_locked_schedule INTEGER NOT NULL DEFAULT 0,
    estimated_minutes INTEGER,
    schedule_energy_type TEXT,
    schedule_task_type TEXT,
    is_splittable INTEGER NOT NULL DEFAULT 0,
    min_schedule_minutes INTEGER,
    subtask_config    TEXT,
    recurrence_rule   TEXT,
    source            TEXT NOT NULL DEFAULT 'manual',
    manual_progress   INTEGER,
    pinned            INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'todo',
    completed         INTEGER NOT NULL DEFAULT 0,
    completed_at      TEXT,
    deleted_at        TEXT,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS goals (
    id                      TEXT PRIMARY KEY,
    user_id                 TEXT NOT NULL,
    title                   TEXT NOT NULL,
    description             TEXT,
    start_at                TEXT,
    deadline_at             TEXT,
    priority                INTEGER NOT NULL DEFAULT 0,
    total_estimated_minutes INTEGER,
    available_time_rule     TEXT,
    progress_mode           TEXT NOT NULL DEFAULT 'auto',
    status                  TEXT NOT NULL DEFAULT 'not_started',
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS personal_schedule_rules (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    description    TEXT,
    type           TEXT NOT NULL CHECK(type IN ('time_boundary','energy_preference','fixed_habit','buffer','task_category','reminder','plan_priority')),
    status         TEXT NOT NULL CHECK(status IN ('enabled','disabled')),
    priority       TEXT NOT NULL CHECK(priority IN ('hard','normal','preference')),
    condition_json TEXT NOT NULL,
    action_json    TEXT NOT NULL,
    scope_json     TEXT NOT NULL DEFAULT '{}',
    deleted_at     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schedule_rule_templates (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    description    TEXT,
    type           TEXT NOT NULL CHECK(type IN ('time_boundary','energy_preference','fixed_habit','buffer','task_category','reminder','plan_priority')),
    priority       TEXT NOT NULL CHECK(priority IN ('hard','normal','preference')),
    condition_json TEXT NOT NULL,
    action_json    TEXT NOT NULL,
    scope_json     TEXT NOT NULL DEFAULT '{}',
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schedule_proposals (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id           TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    status            TEXT NOT NULL CHECK(status IN ('draft','confirmed','discarded','undone')),
    range_start       TEXT NOT NULL,
    range_end         TEXT NOT NULL,
    changes_json      TEXT NOT NULL,
    explanations_json TEXT NOT NULL,
    conflicts_json    TEXT NOT NULL,
    risk_score        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    confirmed_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS tags (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    color      TEXT,
    parent_id  TEXT REFERENCES tags(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS task_tags (
    user_id    TEXT NOT NULL,
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY(task_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS task_reminders (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    remind_at  TEXT NOT NULL,
    channel    TEXT NOT NULL DEFAULT 'email',
    status     TEXT NOT NULL DEFAULT 'scheduled',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_checklist_items (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    completed         INTEGER NOT NULL DEFAULT 0,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    converted_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_activity_logs (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    task_id      TEXT NOT NULL,
    action       TEXT NOT NULL,
    summary      TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    file_name    TEXT NOT NULL,
    mime_type    TEXT,
    size_bytes   INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    type         TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT,
    target_type  TEXT,
    target_id    TEXT,
    scheduled_at TEXT,
    delivered_at TEXT,
    read_at      TEXT,
    action_state TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notification_permissions (
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission       TEXT NOT NULL,
    status           TEXT NOT NULL,
    prompt_reason    TEXT,
    last_prompted_at TEXT,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY(user_id, permission)
  );

  CREATE TABLE IF NOT EXISTS notification_sounds (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    purpose      TEXT NOT NULL DEFAULT 'both',
    mime_type    TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saved_filters (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    query_json TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS search_history (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    query        TEXT NOT NULL,
    types_json   TEXT NOT NULL DEFAULT '[]',
    result_count INTEGER NOT NULL DEFAULT 0,
    searched_at  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE(user_id, query, types_json)
  );

  CREATE TABLE IF NOT EXISTS desktop_widgets (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type          TEXT NOT NULL,
    title         TEXT NOT NULL,
    config_json   TEXT NOT NULL,
    position_json TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS desktop_shortcuts (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action        TEXT NOT NULL,
    accelerator   TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    registered_at TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE(user_id, action)
  );

  CREATE TABLE IF NOT EXISTS desktop_shell_state (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, key)
  );

  CREATE TABLE IF NOT EXISTS desktop_app_lock_credentials (
    user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS desktop_focus_timers (
    user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    widget_id               TEXT NOT NULL REFERENCES desktop_widgets(id) ON DELETE CASCADE,
    status                  TEXT NOT NULL CHECK(status IN ('idle','running','paused')),
    mode                    TEXT NOT NULL DEFAULT 'pomodoro',
    target_duration_sec     INTEGER NOT NULL,
    accumulated_elapsed_sec INTEGER NOT NULL DEFAULT 0,
    started_at              TEXT,
    paused_at               TEXT,
    updated_at              TEXT NOT NULL,
    PRIMARY KEY(user_id, widget_id)
  );

  CREATE TABLE IF NOT EXISTS ai_generation_logs (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scenario      TEXT NOT NULL,
    provider      TEXT,
    model         TEXT,
    request_json  TEXT NOT NULL,
    response_json TEXT,
    status        TEXT NOT NULL,
    error_message TEXT,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sticky_notes (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    color         TEXT,
    opacity       INTEGER NOT NULL DEFAULT 95,
    font_size     TEXT NOT NULL DEFAULT 'normal',
    pinned        INTEGER NOT NULL DEFAULT 0,
    position_json TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS focus_sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    mode         TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    ended_at     TEXT NOT NULL,
    duration_sec INTEGER NOT NULL,
    is_pomodoro  INTEGER NOT NULL DEFAULT 0,
    background_sound_id TEXT,
    background_sound_name TEXT,
    background_volume INTEGER,
    sound_played_duration INTEGER,
    is_muted INTEGER NOT NULL DEFAULT 0,
    note         TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS focus_rest_cycles (
    id                    TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL,
    focus_session_id      TEXT NOT NULL REFERENCES focus_sessions(id) ON DELETE CASCADE,
    rest_started_at       TEXT NOT NULL,
    rest_ended_at         TEXT NOT NULL,
    rest_duration_sec     INTEGER NOT NULL,
    next_focus_started_at TEXT,
    reminder_status       TEXT NOT NULL,
    notification_id       TEXT,
    created_at            TEXT NOT NULL,
    UNIQUE(user_id, focus_session_id)
  );

  CREATE TABLE IF NOT EXISTS background_sounds (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    category   TEXT,
    asset_url  TEXT NOT NULL,
    license    TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_sound_cache (
    user_id    TEXT NOT NULL,
    sound_id   TEXT NOT NULL REFERENCES background_sounds(id),
    status     TEXT NOT NULL,
    local_path  TEXT,
    volume     INTEGER NOT NULL DEFAULT 50,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, sound_id)
  );

  CREATE TABLE IF NOT EXISTS calendar_subscriptions (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    type           TEXT NOT NULL,
    name           TEXT NOT NULL,
    url            TEXT,
    color          TEXT,
    enabled        INTEGER NOT NULL DEFAULT 1,
    last_synced_at TEXT,
    created_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS calendar_permissions (
    user_id          TEXT NOT NULL,
    permission       TEXT NOT NULL,
    status           TEXT NOT NULL,
    prompt_reason    TEXT,
    last_prompted_at TEXT,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY(user_id, permission)
  );

  CREATE TABLE IF NOT EXISTS external_calendar_events (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    subscription_id TEXT NOT NULL REFERENCES calendar_subscriptions(id) ON DELETE CASCADE,
    external_uid    TEXT NOT NULL,
    title           TEXT NOT NULL,
    starts_at       TEXT NOT NULL,
    ends_at         TEXT NOT NULL,
    is_all_day      INTEGER NOT NULL DEFAULT 0,
    raw_json        TEXT,
    UNIQUE(subscription_id, external_uid)
  );

  CREATE TABLE IF NOT EXISTS habits (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    name         TEXT NOT NULL,
    icon         TEXT,
    color        TEXT,
    days_of_week TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
    target_type  TEXT NOT NULL DEFAULT 'check',
    target_value INTEGER,
    target_unit  TEXT,
    start_date   TEXT,
    group_name   TEXT,
    reminder_time TEXT,
    note         TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    archived     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS habit_checkins (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    habit_id   TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    value      INTEGER,
    note       TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(habit_id, date)
  );

  CREATE TABLE IF NOT EXISTS countdowns (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    title         TEXT NOT NULL,
    target_date   TEXT NOT NULL,
    mode          TEXT NOT NULL DEFAULT 'countdown',
    icon          TEXT,
    color         TEXT,
    repeat_yearly INTEGER NOT NULL DEFAULT 0,
    pinned        INTEGER NOT NULL DEFAULT 0,
    note          TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id    TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, key)
  );
`);

// Migrations for databases created before account-scoped data.
{
  const addCol = (table: string, col: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };

  const authIdentitySql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'auth_identities'").get() as
    | { sql: string }
    | undefined)?.sql;
  if (authIdentitySql && !authIdentitySql.includes("'oauth'")) {
    db.exec(`
      DROP INDEX IF EXISTS idx_auth_identities_user;
      ALTER TABLE auth_identities RENAME TO auth_identities_legacy;
      CREATE TABLE auth_identities (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type               TEXT NOT NULL CHECK(type IN ('phone','email','oauth')),
        provider           TEXT,
        identifier_hash    TEXT NOT NULL,
        display_identifier TEXT NOT NULL,
        is_primary         INTEGER NOT NULL DEFAULT 0,
        verified_at        TEXT NOT NULL,
        bound_at           TEXT NOT NULL,
        unbound_at         TEXT,
        UNIQUE(type, identifier_hash)
      );
      INSERT INTO auth_identities (id, user_id, type, provider, identifier_hash, display_identifier, is_primary, verified_at, bound_at, unbound_at)
      SELECT id, user_id, type, NULL, identifier_hash, display_identifier, is_primary, verified_at, bound_at, unbound_at
      FROM auth_identities_legacy;
      DROP TABLE auth_identities_legacy;
    `);
  }
  addCol('auth_identities', 'provider', 'provider TEXT');
  addCol('oauth_login_states', 'user_id', 'user_id TEXT');
  addCol('oauth_login_states', 'purpose', "purpose TEXT NOT NULL DEFAULT 'login'");

  const scheduleProposalSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedule_proposals'").get() as { sql?: string } | undefined
  )?.sql;
  if (scheduleProposalSql && !scheduleProposalSql.includes("'undone'")) {
    db.exec(`
      ALTER TABLE schedule_proposals RENAME TO schedule_proposals_legacy;
      CREATE TABLE schedule_proposals (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        goal_id           TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        status            TEXT NOT NULL CHECK(status IN ('draft','confirmed','discarded','undone')),
        range_start       TEXT NOT NULL,
        range_end         TEXT NOT NULL,
        changes_json      TEXT NOT NULL,
        explanations_json TEXT NOT NULL,
        conflicts_json    TEXT NOT NULL,
        risk_score        INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL,
        confirmed_at      TEXT
      );
      INSERT INTO schedule_proposals
        (id, user_id, goal_id, status, range_start, range_end, changes_json, explanations_json, conflicts_json, risk_score, created_at, confirmed_at)
      SELECT id, user_id, goal_id, status, range_start, range_end, changes_json, explanations_json, conflicts_json, risk_score, created_at, confirmed_at
      FROM schedule_proposals_legacy;
      DROP TABLE schedule_proposals_legacy;
    `);
  }

  for (const table of ['lists', 'tasks', 'focus_sessions', 'habits', 'habit_checkins', 'countdowns']) {
    addCol(table, 'user_id', 'user_id TEXT');
  }

  addCol('lists', 'folder_id', 'folder_id TEXT');
  addCol('lists', 'type', "type TEXT NOT NULL DEFAULT 'task'");
  addCol('tags', 'parent_id', 'parent_id TEXT');
  addCol('tasks', 'start_date', 'start_date TEXT');
  addCol('tasks', 'is_important', 'is_important INTEGER');
  addCol('tasks', 'is_urgent', 'is_urgent INTEGER');
  addCol('tasks', 'parent_id', 'parent_id TEXT');
  addCol('tasks', 'goal_id', 'goal_id TEXT');
  addCol('tasks', 'root_task_id', 'root_task_id TEXT');
  addCol('tasks', 'level', 'level INTEGER NOT NULL DEFAULT 1');
  addCol('tasks', 'planned_start_at', 'planned_start_at TEXT');
  addCol('tasks', 'planned_end_at', 'planned_end_at TEXT');
  addCol('tasks', 'actual_start_at', 'actual_start_at TEXT');
  addCol('tasks', 'actual_end_at', 'actual_end_at TEXT');
  addCol('tasks', 'dependency_task_ids', 'dependency_task_ids TEXT');
  addCol('tasks', 'auto_schedule_enabled', 'auto_schedule_enabled INTEGER NOT NULL DEFAULT 1');
  addCol('tasks', 'is_locked_schedule', 'is_locked_schedule INTEGER NOT NULL DEFAULT 0');
  addCol('tasks', 'estimated_minutes', 'estimated_minutes INTEGER');
  addCol('tasks', 'schedule_energy_type', 'schedule_energy_type TEXT');
  addCol('tasks', 'schedule_task_type', 'schedule_task_type TEXT');
  addCol('tasks', 'is_splittable', 'is_splittable INTEGER NOT NULL DEFAULT 0');
  addCol('tasks', 'min_schedule_minutes', 'min_schedule_minutes INTEGER');
  addCol('tasks', 'subtask_config', 'subtask_config TEXT');
  addCol('tasks', 'recurrence_rule', 'recurrence_rule TEXT');
  addCol('goals', 'priority', 'priority INTEGER NOT NULL DEFAULT 0');
  addCol('tasks', 'source', "source TEXT NOT NULL DEFAULT 'manual'");
  addCol('tasks', 'manual_progress', 'manual_progress INTEGER');
  addCol('tasks', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
  addCol('tasks', 'status', "status TEXT NOT NULL DEFAULT 'todo'");
  addCol('verification_codes', 'display_identifier', 'display_identifier TEXT');
  addCol('focus_sessions', 'background_sound_id', 'background_sound_id TEXT');
  addCol('focus_sessions', 'background_sound_name', 'background_sound_name TEXT');
  addCol('focus_sessions', 'background_volume', 'background_volume INTEGER');
  addCol('focus_sessions', 'sound_played_duration', 'sound_played_duration INTEGER');
  addCol('focus_sessions', 'is_muted', 'is_muted INTEGER NOT NULL DEFAULT 0');
  addCol('habits', 'target_type', "target_type TEXT NOT NULL DEFAULT 'check'");
  addCol('habits', 'target_value', 'target_value INTEGER');
  addCol('habits', 'target_unit', 'target_unit TEXT');
  addCol('habits', 'start_date', 'start_date TEXT');
  addCol('habits', 'group_name', 'group_name TEXT');
  addCol('habits', 'reminder_time', 'reminder_time TEXT');
  addCol('habit_checkins', 'value', 'value INTEGER');
  addCol('habit_checkins', 'note', 'note TEXT');
  addCol('countdowns', 'mode', "mode TEXT NOT NULL DEFAULT 'countdown'");

  const settingsCols = db.prepare('PRAGMA table_info(settings)').all() as Array<{ name: string; pk: number }>;
  const hasUserId = settingsCols.some((c) => c.name === 'user_id');
  const keyIsOldPrimaryKey = settingsCols.some((c) => c.name === 'key' && c.pk === 1) && !hasUserId;
  if (keyIsOldPrimaryKey) {
    db.exec(`
      ALTER TABLE settings RENAME TO settings_legacy;
      CREATE TABLE settings (
        user_id    TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, key)
      );
      INSERT INTO settings (user_id, key, value, updated_at)
      SELECT '__legacy__', key, value, updated_at FROM settings_legacy;
      DROP TABLE settings_legacy;
    `);
  } else if (!hasUserId) {
    db.exec('ALTER TABLE settings ADD COLUMN user_id TEXT');
  }
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);
  CREATE INDEX IF NOT EXISTS idx_auth_password_credentials_updated ON auth_password_credentials(updated_at);
  CREATE INDEX IF NOT EXISTS idx_deleted_identity_reservations_user ON deleted_identity_reservations(deleted_user_id, reserved_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_deleted_identity_reservations_identity ON deleted_identity_reservations(type, COALESCE(provider, ''), identifier_hash);
  CREATE INDEX IF NOT EXISTS idx_oauth_login_states_provider ON oauth_login_states(provider, expires_at, consumed_at);
  CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON analytics_events(user_id, received_at);
  CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON analytics_events(event_name, received_at);
  CREATE INDEX IF NOT EXISTS idx_diagnostic_log_uploads_user ON diagnostic_log_uploads(user_id, uploaded_at);
  CREATE INDEX IF NOT EXISTS idx_sync_operations_user ON sync_operations(user_id, received_at);
  CREATE INDEX IF NOT EXISTS idx_sync_operations_status ON sync_operations(user_id, status, received_at);
  CREATE INDEX IF NOT EXISTS idx_login_sessions_user ON login_sessions(user_id, revoked_at);
  CREATE INDEX IF NOT EXISTS idx_verification_codes_identifier ON verification_codes(type, identifier_hash, created_at);
  CREATE INDEX IF NOT EXISTS idx_lists_user ON lists(user_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_list_folders_user ON list_folders(user_id, sort_order, created_at);
  CREATE INDEX IF NOT EXISTS idx_lists_user_folder ON lists(user_id, folder_id, sort_order);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_user_inbox ON lists(user_id) WHERE is_inbox = 1;
  CREATE INDEX IF NOT EXISTS idx_tasks_user_list ON tasks(user_id, list_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_user_due ON tasks(user_id, due_date);
  CREATE INDEX IF NOT EXISTS idx_tasks_user_state ON tasks(user_id, completed, deleted_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status, deleted_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_user_goal ON tasks(user_id, goal_id, level);
  CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status, deadline_at);
  CREATE INDEX IF NOT EXISTS idx_schedule_rules_user ON personal_schedule_rules(user_id, status, deleted_at, priority);
  CREATE INDEX IF NOT EXISTS idx_schedule_rule_templates_sort ON schedule_rule_templates(sort_order, id);
  CREATE INDEX IF NOT EXISTS idx_schedule_proposals_user_goal ON schedule_proposals(user_id, goal_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_tags_user_sort ON tags(user_id, sort_order, created_at);
  CREATE INDEX IF NOT EXISTS idx_task_tags_user_tag ON task_tags(user_id, tag_id);
  CREATE INDEX IF NOT EXISTS idx_task_tags_user_task ON task_tags(user_id, task_id);
  CREATE INDEX IF NOT EXISTS idx_task_reminders_user_task ON task_reminders(user_id, task_id, remind_at);
  CREATE INDEX IF NOT EXISTS idx_task_reminders_user_due ON task_reminders(user_id, remind_at, status);
  CREATE INDEX IF NOT EXISTS idx_task_checklist_items_task ON task_checklist_items(user_id, task_id, sort_order, created_at);
  CREATE INDEX IF NOT EXISTS idx_task_activity_logs_task ON task_activity_logs(user_id, task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_attachments_user_task ON attachments(user_id, task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read_at, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_unique_target ON notifications(user_id, target_type, target_id) WHERE target_type IS NOT NULL AND target_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_notification_permissions_user ON notification_permissions(user_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_notification_sounds_user ON notification_sounds(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_saved_filters_user_sort ON saved_filters(user_id, sort_order, created_at);
  CREATE INDEX IF NOT EXISTS idx_search_history_user_recent ON search_history(user_id, searched_at);
  CREATE INDEX IF NOT EXISTS idx_desktop_widgets_user ON desktop_widgets(user_id, enabled, updated_at);
  CREATE INDEX IF NOT EXISTS idx_desktop_shortcuts_user ON desktop_shortcuts(user_id, enabled, updated_at);
  CREATE INDEX IF NOT EXISTS idx_desktop_focus_timers_user ON desktop_focus_timers(user_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_ai_generation_logs_user ON ai_generation_logs(user_id, scenario, created_at);
  CREATE INDEX IF NOT EXISTS idx_sticky_notes_user ON sticky_notes(user_id, deleted_at, updated_at);
  CREATE INDEX IF NOT EXISTS idx_sticky_notes_task ON sticky_notes(user_id, task_id);
  CREATE INDEX IF NOT EXISTS idx_focus_user_ended ON focus_sessions(user_id, ended_at);
  CREATE INDEX IF NOT EXISTS idx_focus_rest_cycles_user ON focus_rest_cycles(user_id, rest_ended_at);
  CREATE INDEX IF NOT EXISTS idx_sound_cache_user ON user_sound_cache(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_calendar_subs_user ON calendar_subscriptions(user_id, enabled);
  CREATE INDEX IF NOT EXISTS idx_calendar_permissions_user ON calendar_permissions(user_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_external_events_user_range ON external_calendar_events(user_id, starts_at, ends_at);
  CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id, archived, sort_order);
  CREATE INDEX IF NOT EXISTS idx_checkins_user_habit ON habit_checkins(user_id, habit_id, date);
  CREATE INDEX IF NOT EXISTS idx_countdowns_user ON countdowns(user_id, sort_order);
`);

{
  const seedSound = db.prepare('SELECT id FROM background_sounds WHERE id = ?').get('rain');
  if (!seedSound) {
    const ts = nowISO();
    db.prepare(
      `INSERT INTO background_sounds (id, name, category, asset_url, license, created_at)
       VALUES
       ('rain', 'Rain', 'nature', '/sounds/rain.wav', 'generated-local', ?),
       ('white-noise', 'White Noise', 'noise', '/sounds/white-noise.wav', 'generated-local', ?),
       ('cafe', 'Cafe', 'ambient', '/sounds/cafe.wav', 'generated-local', ?)`,
    ).run(ts, ts, ts);
  }
  db.prepare(
    `UPDATE background_sounds
     SET asset_url = CASE id
       WHEN 'rain' THEN '/sounds/rain.wav'
       WHEN 'white-noise' THEN '/sounds/white-noise.wav'
       WHEN 'cafe' THEN '/sounds/cafe.wav'
       ELSE asset_url
     END,
     license = 'generated-local'
     WHERE id IN ('rain', 'white-noise', 'cafe')
       AND (license = 'builtin-placeholder' OR asset_url LIKE '/sounds/%.mp3')`,
  ).run();
}

{
  const ts = nowISO();
  const templates = [
    {
      id: 'protect-sleep',
      name: '保护睡眠',
      description: '每天夜间不安排任务，保留休息时间。',
      type: 'time_boundary',
      priority: 'hard',
      condition: { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '22:30', endTime: '07:30' },
      action: { effect: 'block' },
      scope: {},
      sortOrder: 10,
    },
    {
      id: 'morning-deep-work',
      name: '上午深度工作',
      description: '上午优先安排高精力任务。',
      type: 'energy_preference',
      priority: 'preference',
      condition: { energyType: 'high', startTime: '09:00', endTime: '11:30', daysOfWeek: [1, 2, 3, 4, 5] },
      action: { effect: 'prefer', period: 'morning' },
      scope: {},
      sortOrder: 20,
    },
    {
      id: 'weekend-no-work',
      name: '周末不工作',
      description: '周六、周日不安排工作任务。',
      type: 'time_boundary',
      priority: 'normal',
      condition: { daysOfWeek: [0, 6], startTime: '00:00', endTime: '23:59' },
      action: { effect: 'block' },
      scope: {},
      sortOrder: 30,
    },
    {
      id: 'exercise-fixed',
      name: '运动不可移动',
      description: '周二、周四晚上保留固定运动时间。',
      type: 'fixed_habit',
      priority: 'hard',
      condition: { daysOfWeek: [2, 4], startTime: '18:30', endTime: '19:30' },
      action: { effect: 'block' },
      scope: {},
      sortOrder: 40,
    },
  ] as const;
  const upsert = db.prepare(
    `INSERT INTO schedule_rule_templates
       (id, name, description, type, priority, condition_json, action_json, scope_json, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       type = excluded.type,
       priority = excluded.priority,
       condition_json = excluded.condition_json,
       action_json = excluded.action_json,
       scope_json = excluded.scope_json,
       sort_order = excluded.sort_order,
       updated_at = excluded.updated_at`,
  );
  for (const template of templates) {
    upsert.run(
      template.id,
      template.name,
      template.description,
      template.type,
      template.priority,
      JSON.stringify(template.condition),
      JSON.stringify(template.action),
      JSON.stringify(template.scope),
      template.sortOrder,
      ts,
      ts,
    );
  }
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function getInboxId(userId: string): string {
  const existing = db.prepare('SELECT id FROM lists WHERE user_id = ? AND is_inbox = 1 LIMIT 1').get(userId) as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const ts = nowISO();
  db.prepare(
    `INSERT INTO lists (id, user_id, name, color, icon, sort_order, is_inbox, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, userId, 'Inbox', null, 'inbox', -1, ts, ts);
  return id;
}

console.log(`[db] SQLite ready at ${DB_PATH}`);
