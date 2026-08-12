import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createControlPlaneTestStore } from "../../testing/create-test-store.js";
import {
  archiveControlProject,
  createControlProject,
  createControlProjectRepository,
  getControlProjectByBbProject,
  updateControlProjectStatus,
} from "./control-projects.js";
import {
  createDecisionRequest,
  createDecisionRequestRepository,
  listDecisionRequests,
} from "./decision-requests.js";
import { encodePageCursor } from "./cursor.js";
import {
  activateWorkSession,
  assignWorkSessionAgent,
  createWorkSession,
  createWorkSessionRepository,
  listWorkSessions,
  updateWorkSession,
} from "./work-sessions.js";

const stores: Array<ReturnType<typeof createControlPlaneTestStore>> = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function store() {
  const value = createControlPlaneTestStore();
  stores.push(value);
  return value;
}

function projectWithAgent(db: ReturnType<typeof store>["db"], id = "p") {
  createControlProject(db, { id, bb_project_id: `bb-${id}`, now: 1 });
  db.prepare(
    `INSERT INTO managed_agents
     (id, project_id, kind, role, status, version, created_at, updated_at)
     VALUES (?, ?, 'worker', 'worker', 'active', 1, 1, 1)`,
  ).run(`agent-${id}`, id);
  return { projectId: id, agentId: `agent-${id}` };
}

const explainPlanSchema = z.array(z.object({ detail: z.string() }));

function explainPlan(value: unknown): Array<{ detail: string }> {
  const result = explainPlanSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid query plan: ${result.error}`);
  return result.data;
}

function invokeCreateDecisionRequestWithUnknown(
  db: ReturnType<typeof store>["db"],
  input: unknown,
): void {
  // Deliberately model an untyped command boundary so the repository's
  // runtime JSON validation is exercised without an internal type cast.
  Reflect.apply(createDecisionRequest, undefined, [db, input]);
}

describe("SQLite aggregate repositories", () => {
  it("provides focused control-project repositories and CAS updates", () => {
    const { db } = store();
    const repository = createControlProjectRepository(db);
    const created = repository.create({
      id: "cpr_1",
      bb_project_id: "proj_1",
      now: 1,
    });
    expect(repository.getByBbProject("proj_1")).toMatchObject({
      id: "cpr_1",
      version: 1,
      status: "draft",
    });
    const active = repository.updateStatus({
      id: created.id,
      expectedVersion: 1,
      status: "active",
      now: 2,
    });
    expect(active).toMatchObject({ status: "active", version: 2 });
    expect(() =>
      archiveControlProject(db, { id: created.id, expectedVersion: 1, now: 3 }),
    ).toThrow(/version/);
    expect(
      updateControlProjectStatus(db, {
        id: created.id,
        expectedVersion: 2,
        status: "archived",
        now: 3,
      }),
    ).toMatchObject({ status: "archived", version: 3 });
    expect(getControlProjectByBbProject(db, "missing")).toBeNull();
    expect(createControlProjectRepository(db).list({ limit: 1 })).toMatchObject(
      {
        items: [{ id: "cpr_1" }],
        nextCursor: null,
      },
    );
    createControlProject(db, { id: "cpr_2", bb_project_id: "proj_2", now: 4 });
    createControlProject(db, { id: "cpr_3", bb_project_id: "proj_3", now: 4 });
    const firstPage = createControlProjectRepository(db).list({ limit: 1 });
    expect(firstPage.items.map((item) => item.id)).toEqual(["cpr_3"]);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(
      createControlProjectRepository(db)
        .list({
          limit: 1,
          cursor: firstPage.nextCursor!,
        })
        .items.map((item) => item.id),
    ).toEqual(["cpr_2"]);
    expect(() =>
      createControlProjectRepository(db).list({
        status: "draft",
        cursor: firstPage.nextCursor!,
      }),
    ).toThrow(/cursor.*filter/i);
    const plan = explainPlan(
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM control_projects ORDER BY updated_at DESC, id DESC LIMIT ?",
        )
        .all(2),
    );
    expect(
      plan.some((row) => row.detail.includes("control_projects_order")),
    ).toBe(true);
    const filteredPlan = explainPlan(
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM control_projects WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
        )
        .all("draft", 2),
    );
    expect(
      filteredPlan.some((row) =>
        row.detail.includes("control_projects_status_order"),
      ),
    ).toBe(true);
  });

  it("allows planned sessions and validates dispatched agents", () => {
    const { db } = store();
    const { projectId, agentId } = projectWithAgent(db);
    const repository = createWorkSessionRepository(db);
    expect(
      repository.create({
        id: "planned",
        projectId,
        now: 2,
      }),
    ).toMatchObject({ id: "planned", agent_id: null, status: "created" });
    expect(() =>
      createWorkSession(db, {
        id: "without-agent",
        projectId,
        agentId: "missing",
        now: 2,
      }),
    ).toThrow(/agent/i);
    expect(() =>
      repository.create({
        id: "unassigned-active",
        projectId,
        status: "active",
        now: 2,
      }),
    ).toThrow(/assigned agent/);
    expect(
      repository.create({
        id: "w1",
        projectId,
        agentId,
        status: "active",
        now: 2,
        plan: "large plan omitted from list summaries",
        resultSummary: "large result omitted from list summaries",
      }),
    ).toMatchObject({ id: "w1", agent_id: agentId, version: 1 });
    createControlProject(db, {
      id: "other",
      bb_project_id: "bb-other",
      now: 1,
    });
    expect(() =>
      repository.create({
        id: "cross-project",
        projectId: "other",
        agentId,
        now: 2,
      }),
    ).toThrow(/agent/i);
    expect(repository.list({ projectId, status: "active" }).items).toEqual([
      expect.objectContaining({ id: "w1", status: "active" }),
    ]);
    expect(
      repository.list({ projectId, status: "active" }).items[0],
    ).not.toHaveProperty("plan");
    const unassigned = repository.create({
      id: "assign-me",
      projectId,
      now: 2,
    });
    expect(
      assignWorkSessionAgent(db, {
        projectId,
        id: unassigned.id,
        expectedVersion: unassigned.version,
        agentId,
        now: 3,
      }),
    ).toMatchObject({ agent_id: agentId, version: 2 });
    expect(
      assignWorkSessionAgent(db, {
        projectId,
        id: unassigned.id,
        expectedVersion: 2,
        agentId,
        now: 3,
      }),
    ).toMatchObject({ id: unassigned.id, version: 2, agent_id: agentId });
    expect(
      activateWorkSession(db, {
        projectId,
        id: unassigned.id,
        expectedVersion: 2,
        now: 4,
      }),
    ).toMatchObject({ status: "active", version: 3 });
    expect(
      updateWorkSession(db, {
        projectId,
        id: "w1",
        expectedVersion: 1,
        status: "checkpointed",
        currentCheckpoint: "cp-1",
        now: 3,
      }),
    ).toMatchObject({ version: 2, status: "checkpointed" });
    expect(() =>
      assignWorkSessionAgent(db, {
        projectId: "other",
        id: unassigned.id,
        expectedVersion: 2,
        agentId,
        now: 5,
      }),
    ).toThrow(/not found|version/i);
    expect(() =>
      createWorkSessionRepository(db).get("other", "w1"),
    ).not.toThrow();
    expect(createWorkSessionRepository(db).get("other", "w1")).toBeNull();

    db.prepare(
      `INSERT INTO managed_agents
       (id, project_id, kind, role, status, version, created_at, updated_at)
       VALUES ('failed-agent', ?, 'worker', 'worker', 'failed', 1, 1, 1)`,
    ).run(projectId);
    const failedTarget = createWorkSession(db, {
      id: "failed-target",
      projectId,
      now: 5,
    });
    expect(() =>
      assignWorkSessionAgent(db, {
        projectId,
        id: failedTarget.id,
        expectedVersion: failedTarget.version,
        agentId: "failed-agent",
        now: 6,
      }),
    ).toThrow(/assignable/i);
    expect(() =>
      activateWorkSession(db, {
        projectId,
        id: "w1",
        expectedVersion: 2,
        now: 6,
      }),
    ).toThrow(/created/i);
    const terminal = updateWorkSession(db, {
      projectId,
      id: "w1",
      expectedVersion: 2,
      status: "finished",
      now: 6,
    });
    expect(() =>
      updateWorkSession(db, {
        projectId,
        id: "w1",
        expectedVersion: terminal.version,
        status: "active",
        now: 7,
      }),
    ).toThrow(/terminal/i);
  });

  it("uses bounded keyset pages with deterministic tie breaking", () => {
    const { db } = store();
    const { projectId, agentId } = projectWithAgent(db);
    const repository = createWorkSessionRepository(db);
    for (const id of ["w-a", "w-b", "w-c"]) {
      repository.create({ id, projectId, agentId, now: 2 });
    }
    const first = repository.list({ projectId, limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["w-c", "w-b"]);
    expect(first.nextCursor).not.toBeNull();
    expect(
      repository
        .list({ projectId, limit: 2, cursor: first.nextCursor! })
        .items.map((item) => item.id),
    ).toEqual(["w-a"]);
    expect(() =>
      repository.list({ projectId: "other", cursor: first.nextCursor! }),
    ).toThrow(/cursor.*filter/i);
    expect(() =>
      repository.list({
        projectId,
        status: "active",
        cursor: first.nextCursor!,
      }),
    ).toThrow(/cursor.*filter/i);
    expect(() => repository.list({ projectId, cursor: "bad" })).toThrow(
      /cursor/i,
    );
    expect(() =>
      encodePageCursor({
        updatedAt: 1,
        id: "x".repeat(5_000),
        projectId,
        status: null,
      }),
    ).toThrow(/size/i);

    const plan = explainPlan(
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM work_sessions WHERE project_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
        )
        .all(projectId, 2),
    );
    expect(
      plan.some((row) => row.detail.includes("work_sessions_project_order")),
    ).toBe(true);
    const filteredPlan = explainPlan(
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM work_sessions WHERE project_id = ? AND status = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
        )
        .all(projectId, "active", 2),
    );
    expect(
      filteredPlan.some((row) =>
        row.detail.includes("work_sessions_project_status_order"),
      ),
    ).toBe(true);
  });

  it("validates decision JSON at both write and read boundaries", () => {
    const { db } = store();
    const { projectId } = projectWithAgent(db);
    const repository = createDecisionRequestRepository(db);
    expect(() =>
      invokeCreateDecisionRequestWithUnknown(db, {
        id: "bad-boundary",
        projectId,
        question: "q",
        category: "design",
        options: "not-an-array",
        now: 2,
      }),
    ).toThrow();
    const request = createDecisionRequest(db, {
      id: "d1",
      projectId,
      question: "q",
      category: "design",
      options: [{ id: "a" }],
      risk: { level: "low" },
      scope: { task: "t1" },
      evidence: [{ ref: "e1" }],
      now: 2,
    });
    expect(request).toMatchObject({
      id: "d1",
      projectId,
      status: "open",
      options: [{ id: "a" }],
      risk: { level: "low" },
      scope: { task: "t1" },
      evidence: [{ ref: "e1" }],
    });
    expect(request).not.toHaveProperty("options_json");
    const page = listDecisionRequests(db, {
      projectId,
      status: "open",
      limit: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty("options_json");
    expect(listDecisionRequests(db, { projectId: "other" }).items).toEqual([]);
    expect(repository.get("other", request.id)).toBeNull();
    expect(() =>
      repository.update({
        projectId: "other",
        id: request.id,
        expectedVersion: request.version,
        recommendation: "cross-project",
        now: 3,
      }),
    ).toThrow(/not found|version/i);
    createDecisionRequest(db, {
      id: "d2",
      projectId,
      question: "q2",
      category: "design",
      options: [],
      now: 2,
    });
    createDecisionRequest(db, {
      id: "d3",
      projectId,
      question: "q3",
      category: "design",
      options: [],
      now: 2,
    });
    const firstPage = listDecisionRequests(db, { projectId, limit: 1 });
    expect(firstPage.items.map((item) => item.id)).toEqual(["d3"]);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(
      listDecisionRequests(db, {
        projectId,
        limit: 1,
        cursor: firstPage.nextCursor!,
      }).items.map((item) => item.id),
    ).toEqual(["d2"]);
    // Simulate corruption that bypassed an older database's trigger; the
    // repository must still reject it while reading the aggregate.
    db.exec("DROP TRIGGER decision_requests_json_shape_update");
    db.prepare(
      "UPDATE decision_requests SET options_json = ? WHERE id = ?",
    ).run("{}", "d1");
    expect(() => repository.get(projectId, "d1")).toThrow(/options.*shape/i);
    db.prepare(
      "UPDATE decision_requests SET options_json = ? WHERE id = ?",
    ).run(JSON.stringify([{ id: "a" }]), "d1");
    db.prepare(
      "ALTER TABLE decision_requests ADD COLUMN future_column TEXT",
    ).run();
    expect(repository.get(projectId, "d1")).toMatchObject({ id: "d1" });

    const plan = explainPlan(
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM decision_requests WHERE project_id = ? AND status = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
        )
        .all(projectId, "open", 2),
    );
    expect(
      plan.some((row) =>
        row.detail.includes("decision_requests_project_status_order"),
      ),
    ).toBe(true);
    const unfilteredPlan = explainPlan(
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM decision_requests WHERE project_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
        )
        .all(projectId, 2),
    );
    expect(
      unfilteredPlan.some((row) =>
        row.detail.includes("decision_requests_project_order"),
      ),
    ).toBe(true);
  });
});
