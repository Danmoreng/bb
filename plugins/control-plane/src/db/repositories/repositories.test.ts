import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { initializeControlPlaneDatabase } from "../migrations.js";
import {
  archiveControlProject,
  createControlProject,
  getControlProjectByBbProject,
  updateControlProjectStatus,
} from "./control-projects.js";
import { listDecisionRequests } from "./decision-requests.js";
import { listWorkSessions, updateWorkSession } from "./work-sessions.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

function database() {
  const host = createFakePluginHost({ pluginId: "control-plane" });
  hosts.push(host);
  const db = host.bb.storage.database();
  initializeControlPlaneDatabase(db, host.bb.storage.migrate);
  return db;
}

describe("named persistence repositories", () => {
  it("creates and CAS-updates a control project", () => {
    const db = database();
    const created = createControlProject(db, {
      id: "cpr_1",
      bb_project_id: "proj_1",
      now: 1,
    });
    expect(getControlProjectByBbProject(db, "proj_1")).toMatchObject({
      id: "cpr_1",
      version: 1,
      status: "draft",
    });
    const active = updateControlProjectStatus(db, {
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
      archiveControlProject(db, { id: created.id, expectedVersion: 2, now: 3 }),
    ).toMatchObject({ status: "archived", version: 3 });
  });

  it("queries work sessions and decision requests with bounded project-scoped lists", () => {
    const db = database();
    db.prepare(
      "INSERT INTO control_projects (id, bb_project_id, status, created_at, updated_at) VALUES ('p', 'proj', 'active', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO work_sessions (id, project_id, status, version, plan_version, created_at, updated_at) VALUES ('w1', 'p', 'active', 1, 1, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO work_sessions (id, project_id, status, version, plan_version, created_at, updated_at) VALUES ('w2', 'p', 'idle', 1, 1, 2, 2)",
    ).run();
    expect(
      listWorkSessions(db, { projectId: "p", status: "active" }),
    ).toHaveLength(1);
    expect(
      updateWorkSession(db, {
        id: "w1",
        expectedVersion: 1,
        status: "checkpointed",
        currentCheckpoint: "cp-1",
        now: 3,
      }),
    ).toMatchObject({ version: 2, status: "checkpointed" });
    db.prepare(
      "INSERT INTO decision_requests (id, project_id, question, category, options_json, status, created_at, updated_at) VALUES ('d1', 'p', 'q', 'design', '[]', 'open', 1, 1)",
    ).run();
    expect(
      listDecisionRequests(db, { projectId: "p", status: "open", limit: 1 }),
    ).toHaveLength(1);
    expect(listDecisionRequests(db, { projectId: "other" })).toEqual([]);
  });
});
