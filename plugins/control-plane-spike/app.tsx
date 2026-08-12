import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  ThreadChat,
  useBbContext,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { SpikeSnapshot, TasksCapability } from "./src/contract.js";
import type { z } from "zod";
import {
  controlPlaneSpikeRpcContract,
  stewardStatusSchema,
} from "./src/contract.js";

type StewardStatus = z.infer<typeof stewardStatusSchema>;

function payloadProjectId(payload: unknown): string | null | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return undefined;
  const value = Object.entries(payload).find(
    ([key]) => key === "projectId",
  )?.[1];
  return typeof value === "string" || value === null ? value : undefined;
}

function ControlPlanePanel() {
  const { projectId } = useBbContext();
  const rpc = useRpc<typeof controlPlaneSpikeRpcContract>();
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const [snapshot, setSnapshot] = useState<SpikeSnapshot | null>(null);
  const [tasksCapability, setTasksCapability] =
    useState<TasksCapability | null>(null);
  const [steward, setSteward] = useState<StewardStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setLoading(true);
    setError(null);
    try {
      const nextSnapshot = await rpc.call("snapshot", { projectId });
      if (requestGeneration.current !== generation) return;
      setSnapshot(nextSnapshot);
      try {
        const capability = await rpc.call("tasksCapability", {});
        if (requestGeneration.current === generation)
          setTasksCapability(capability);
      } catch {
        if (requestGeneration.current === generation) setTasksCapability(null);
      }
      try {
        const nextSteward = await rpc.call("stewardStatus", { projectId });
        if (requestGeneration.current === generation) setSteward(nextSteward);
      } catch {
        if (requestGeneration.current === generation) setSteward(null);
      }
    } catch (cause) {
      if (requestGeneration.current !== generation) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestGeneration.current === generation) setLoading(false);
    }
  }, [projectId, rpc]);

  useEffect(() => {
    setSnapshot(null);
    setTasksCapability(null);
    setSteward(null);
    void load();
    return () => {
      requestGeneration.current += 1;
    };
  }, [load]);

  useRealtime(
    "control-plane-spike-changed",
    useCallback(
      (payload: unknown) => {
        if (typeof payload !== "object" || payload === null) return;
        const changedProject = payloadProjectId(payload);
        if (changedProject === projectId) void load();
      },
      [load, projectId],
    ),
  );

  useEffect(() => {
    const reconnected =
      connection === "connected" && previousConnection.current !== "connected";
    previousConnection.current = connection;
    if (reconnected) void load();
  }, [connection, load]);

  if (!projectId) {
    return (
      <section
        className="flex h-full items-center justify-center p-6"
        aria-label="Control Plane Spike"
      >
        <p className="text-muted-foreground">
          Select a project to inspect the capability spike.
        </p>
      </section>
    );
  }
  if (loading && snapshot === null) {
    return (
      <div
        className="p-6"
        role="status"
        aria-label="Loading Control Plane Spike"
      >
        Loading…
      </div>
    );
  }
  if (error && snapshot === null) {
    return (
      <section
        className="space-y-3 p-6"
        role="alert"
        aria-label="Control Plane Spike error"
      >
        <h2 className="font-medium">Control Plane Spike unavailable</h2>
        <p className="text-muted-foreground">{error}</p>
        <button
          className="rounded border px-3 py-1"
          type="button"
          onClick={() => void load()}
        >
          Retry
        </button>
      </section>
    );
  }
  if (!snapshot) return null;
  return (
    <section className="space-y-5 p-6" aria-label="Control Plane Spike">
      <header>
        <p className="text-sm text-muted-foreground">
          Disposable capability spike
        </p>
        <h1 className="text-xl font-semibold">Control Plane</h1>
      </header>
      {snapshot.error ? <p role="alert">{snapshot.error}</p> : null}
      <dl className="grid max-w-md grid-cols-2 gap-3 text-sm">
        <dt className="text-muted-foreground">Project</dt>
        <dd>{snapshot.projectId}</dd>
        <dt className="text-muted-foreground">Observations</dt>
        <dd aria-label="Observation count">{snapshot.observationCount}</dd>
        <dt className="text-muted-foreground">Revision</dt>
        <dd aria-label="Snapshot revision">{snapshot.revision}</dd>
      </dl>
      <div>
        <h2 className="font-medium">Project Steward</h2>
        {steward?.status === "ready" && steward.threadId ? (
          <div className="mt-2 h-96 min-h-0 overflow-hidden rounded border">
            <ThreadChat
              threadId={steward.threadId}
              variant="compact"
              layout="contained"
              permissionPolicy="editable"
              className="h-full"
            />
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            <p className="text-sm text-muted-foreground">
              {steward?.status === "missing"
                ? "The saved Steward thread is unavailable."
                : "Initialize a persistent Steward for this project."}
            </p>
            <button
              className="rounded border px-3 py-1 text-sm"
              type="button"
              onClick={async () => {
                if (!projectId) return;
                await rpc.call("stewardEnsure", { projectId });
                await load();
              }}
            >
              {steward?.status === "missing"
                ? "Repair Steward"
                : "Initialize Steward"}
            </button>
          </div>
        )}
      </div>
      <div>
        <h2 className="font-medium">Tasks integration</h2>
        {tasksCapability ? (
          <p className="text-sm" role="status" aria-label="Tasks capability">
            {tasksCapability.status}: {tasksCapability.reason}
          </p>
        ) : (
          <p
            className="text-sm text-muted-foreground"
            role="status"
            aria-label="Tasks capability"
          >
            Tasks capability unavailable or not yet checked.
          </p>
        )}
      </div>
      <div>
        <h2 className="font-medium">Lifecycle events</h2>
        {snapshot.lifecycleEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No lifecycle events recorded yet.
          </p>
        ) : (
          <ul className="mt-2 list-inside list-disc text-sm">
            {snapshot.lifecycleEvents.map((event, index) => (
              <li key={`${event}-${index}`}>{event}</li>
            ))}
          </ul>
        )}
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground" role="status">
          Refreshing…
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="status">
          Refresh failed: {error}
        </p>
      ) : null}
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "control-plane-spike",
    title: "Control Plane Spike",
    icon: "Workflow",
    path: "control-plane-spike",
    component: ControlPlanePanel,
  });
});
