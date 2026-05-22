import { sql, ensureSchema } from './_lib/db.js';
import { requireUser, readJson } from './_lib/auth.js';

// POST /api/sync
// body:
//   {
//     ops: [
//       { id: "op-uuid", table: "tasks"|"districts"|"user_meta", kind: "upsert"|"delete", payload: {...} },
//       ...
//     ],
//     cursors: { tasks: iso|null, districts: iso|null, user_meta: iso|null }
//   }
// response:
//   {
//     applied: ["op-uuid", ...],
//     deltas:  { tasks: [...rows], districts: [...rows], meta: {...}|null },
//     cursors: { tasks: iso, districts: iso, user_meta: iso }
//   }
//
// Rules:
// - Every op is filtered/scoped by the authenticated user_id from the cookie.
// - Upserts use last-write-wins: incoming row only overwrites if its
//   updated_at is strictly newer than the stored row's updated_at.
// - Deletes are soft (set deleted_at).
// - Delta pull returns rows where updated_at > cursor (or all non-tombstone
//   rows on the very first call where cursor is null). The new cursor is the
//   max(updated_at) over the returned rows.
// - All ops are idempotent: if the server crashes mid-batch, the client
//   resends them on the next flush and the same end state results.

const MAX_OPS = 500;

function nowIso() { return new Date().toISOString(); }

// ─────────────────────────────────────────────────────────────────────────
// Row <-> client object mapping
// ─────────────────────────────────────────────────────────────────────────

function rowToTask(row) {
  return {
    id: row.id,
    districtId: row.district_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    building: row.building || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    deletedAt: row.deleted_at instanceof Date ? row.deleted_at.toISOString() : row.deleted_at
  };
}

function rowToDistrict(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    order: row.order,
    size: row.size,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    deletedAt: row.deleted_at instanceof Date ? row.deleted_at.toISOString() : row.deleted_at
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Upserts (last-write-wins via WHERE EXCLUDED.updated_at > existing)
// ─────────────────────────────────────────────────────────────────────────

async function upsertTask(userId, p) {
  if (!p || !p.id) return;
  const updatedAt = p.updatedAt || nowIso();
  const buildingJson = p.building == null ? null : JSON.stringify(p.building);
  await sql`
    insert into tasks
      (id, user_id, district_id, title, status, priority, building,
       created_at, started_at, completed_at, updated_at, deleted_at)
    values
      (${p.id}, ${userId}, ${p.districtId}, ${p.title}, ${p.status},
       ${p.priority || null}, ${buildingJson}::jsonb,
       ${p.createdAt || updatedAt}, ${p.startedAt || null},
       ${p.completedAt || null}, ${updatedAt}, ${p.deletedAt || null})
    on conflict (id) do update set
      district_id  = excluded.district_id,
      title        = excluded.title,
      status       = excluded.status,
      priority     = excluded.priority,
      building     = excluded.building,
      started_at   = excluded.started_at,
      completed_at = excluded.completed_at,
      updated_at   = excluded.updated_at,
      deleted_at   = excluded.deleted_at
    where tasks.user_id = ${userId}
      and excluded.updated_at > tasks.updated_at
  `;
}

async function softDeleteTask(userId, p) {
  if (!p || !p.id) return;
  const updatedAt = p.updatedAt || nowIso();
  const deletedAt = p.deletedAt || updatedAt;
  await sql`
    update tasks
       set deleted_at = ${deletedAt}, updated_at = ${updatedAt}
     where id = ${p.id} and user_id = ${userId} and ${updatedAt} > updated_at
  `;
}

async function upsertDistrict(userId, p) {
  if (!p || !p.id) return;
  const updatedAt = p.updatedAt || nowIso();
  await sql`
    insert into districts
      (id, user_id, name, color, "order", size, created_at, updated_at, deleted_at)
    values
      (${p.id}, ${userId}, ${p.name}, ${p.color}, ${p.order ?? 0},
       ${p.size ?? 3}, ${p.createdAt || updatedAt}, ${updatedAt}, ${p.deletedAt || null})
    on conflict (id) do update set
      name       = excluded.name,
      color      = excluded.color,
      "order"    = excluded."order",
      size       = excluded.size,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at
    where districts.user_id = ${userId}
      and excluded.updated_at > districts.updated_at
  `;
}

async function softDeleteDistrict(userId, p) {
  if (!p || !p.id) return;
  const updatedAt = p.updatedAt || nowIso();
  const deletedAt = p.deletedAt || updatedAt;
  await sql`
    update districts
       set deleted_at = ${deletedAt}, updated_at = ${updatedAt}
     where id = ${p.id} and user_id = ${userId} and ${updatedAt} > updated_at
  `;
}

async function upsertMeta(userId, payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  await sql`
    insert into user_meta (user_id, data, updated_at)
    values (${userId}, ${JSON.stringify(data)}::jsonb, now())
    on conflict (user_id) do update set
      data       = excluded.data,
      updated_at = excluded.updated_at
  `;
}

// ─────────────────────────────────────────────────────────────────────────
// Delta pulls
// ─────────────────────────────────────────────────────────────────────────

async function pullTasks(userId, cursor) {
  if (cursor) {
    const { rows } = await sql`
      select * from tasks
       where user_id = ${userId} and updated_at > ${cursor}
       order by updated_at asc
       limit 1000
    `;
    return rows;
  }
  const { rows } = await sql`
    select * from tasks
     where user_id = ${userId} and deleted_at is null
     order by updated_at asc
     limit 1000
  `;
  return rows;
}

async function pullDistricts(userId, cursor) {
  if (cursor) {
    const { rows } = await sql`
      select * from districts
       where user_id = ${userId} and updated_at > ${cursor}
       order by updated_at asc
       limit 1000
    `;
    return rows;
  }
  const { rows } = await sql`
    select * from districts
     where user_id = ${userId} and deleted_at is null
     order by updated_at asc
     limit 1000
  `;
  return rows;
}

async function pullMeta(userId, cursor) {
  if (cursor) {
    const { rows } = await sql`
      select data, updated_at from user_meta
       where user_id = ${userId} and updated_at > ${cursor}
       limit 1
    `;
    return rows[0] || null;
  }
  const { rows } = await sql`
    select data, updated_at from user_meta where user_id = ${userId} limit 1
  `;
  return rows[0] || null;
}

function maxIso(rows, fallback) {
  if (!rows || rows.length === 0) return fallback || null;
  let m = null;
  for (const r of rows) {
    const v = r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at;
    if (!m || v > m) m = v;
  }
  return m || fallback || null;
}

// ─────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    await ensureSchema();
    const user = requireUser(req, res);
    if (!user) return;

    const body = await readJson(req);
    const ops = Array.isArray(body.ops) ? body.ops.slice(0, MAX_OPS) : [];
    const cursors = (body.cursors && typeof body.cursors === 'object') ? body.cursors : {};

    const applied = [];

    for (const op of ops) {
      if (!op || typeof op !== 'object') continue;
      try {
        if (op.table === 'tasks' && op.kind === 'upsert') {
          await upsertTask(user.sub, op.payload);
        } else if (op.table === 'tasks' && op.kind === 'delete') {
          await softDeleteTask(user.sub, op.payload);
        } else if (op.table === 'districts' && op.kind === 'upsert') {
          await upsertDistrict(user.sub, op.payload);
        } else if (op.table === 'districts' && op.kind === 'delete') {
          await softDeleteDistrict(user.sub, op.payload);
        } else if (op.table === 'user_meta') {
          await upsertMeta(user.sub, op.payload);
        } else {
          continue; // unknown op; ignore but don't fail the batch
        }
        if (op.id) applied.push(op.id);
      } catch (err) {
        console.error('sync op failed', { table: op.table, kind: op.kind, id: op.id }, err);
        // Stop here so we don't acknowledge ops past a failure. The client
        // will retry the unacknowledged tail on the next flush.
        break;
      }
    }

    const [taskRows, districtRows, metaRow] = await Promise.all([
      pullTasks(user.sub, cursors.tasks || null),
      pullDistricts(user.sub, cursors.districts || null),
      pullMeta(user.sub, cursors.user_meta || null)
    ]);

    const newCursors = {
      tasks:     maxIso(taskRows,     cursors.tasks     || null),
      districts: maxIso(districtRows, cursors.districts || null),
      user_meta: metaRow
        ? (metaRow.updated_at instanceof Date ? metaRow.updated_at.toISOString() : metaRow.updated_at)
        : (cursors.user_meta || null)
    };

    return res.status(200).json({
      applied,
      deltas: {
        tasks: taskRows.map(rowToTask),
        districts: districtRows.map(rowToDistrict),
        meta: metaRow ? metaRow.data : null
      },
      cursors: newCursors
    });
  } catch (err) {
    console.error('sync error', err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
}
