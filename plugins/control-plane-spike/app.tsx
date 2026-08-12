import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  ThreadChat,
  useBbContext,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type {
  ProjectContext,
  SpikeSnapshot,
  TasksCapability,
} from "./src/contract.js";
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
  const { projectId: routeProjectId } = useBbContext();
  const rpc = useRpc<typeof controlPlaneSpikeRpcContract>();
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const requestGeneration = useRef(0);
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(
    null,
  );
  const [projectContextLoading, setProjectContextLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<SpikeSnapshot | null>(null);
  const [tasksCapability, setTasksCapability] =
    useState<TasksCapability | null>(null);
  const [steward, setSteward] = useState<StewardStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stewardActionError, setStewardActionError] = useState<string | null>(
    null,
  );
  const [stewardActionPending, setStewardActionPending] = useState(false);
  const loadInFlight = useRef<Promise<void> | null>(null);
  const loadQueued = useRef(false);
  const latestRunLoad = useRef<(() => Promise<void>) | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);

  const activeProjectId =
    projectContext?.status === "ready"
      ? projectContext.configuredProject.id
      : null;
  activeProjectIdRef.current = activeProjectId;
  const routeScopeError =
    activeProjectId && routeProjectId && routeProjectId !== activeProjectId
      ? `This panel is configured for ${activeProjectId}, not ${routeProjectId}.`
      : null;

  const runLoad = useCallback(async () => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setProjectContextLoading(true);
    setProjectContext(null);
    setSnapshot(null);
    setTasksCapability(null);
    setSteward(null);
    setLoading(true);
    setError(null);
    setStewardActionError(null);
    setStewardActionPending(false);

    try {
      const nextContext = await rpc.call("projectContext", {});
      if (requestGeneration.current !== generation) return;
      setProjectContext(nextContext);
      setProjectContextLoading(false);

      if (nextContext.status !== "ready") {
        setLoading(false);
        return;
      }
      const effectiveProjectId = nextContext.configuredProject.id;
      if (routeProjectId && routeProjectId !== effectiveProjectId) {
        setError(
          `This panel is configured for ${effectiveProjectId}, not ${routeProjectId}.`,
        );
        setLoading(false);
        return;
      }

      const nextSnapshot = await rpc.call("snapshot", {
        projectId: effectiveProjectId,
      });
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
        const nextSteward = await rpc.call("stewardStatus", {
          projectId: effectiveProjectId,
        });
        if (requestGeneration.current === generation) setSteward(nextSteward);
      } catch {
        if (requestGeneration.current === generation) setSteward(null);
      }
    } catch (cause: unknown) {
      if (requestGeneration.current !== generation) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setProjectContextLoading(false);
    } finally {
      if (requestGeneration.current === generation) setLoading(false);
    }
  }, [routeProjectId, rpc]);

  latestRunLoad.current = runLoad;

  const load = useCallback((): Promise<void> => {
    if (loadInFlight.current) {
      loadQueued.current = true;
      return loadInFlight.current;
    }
    const promise = latestRunLoad.current?.() ?? Promise.resolve();
    loadInFlight.current = promise;
    void promise.then(
      () => {
        if (loadInFlight.current !== promise) return;
        loadInFlight.current = null;
        if (loadQueued.current) {
          loadQueued.current = false;
          void load();
        }
      },
      () => {
        if (loadInFlight.current !== promise) return;
        loadInFlight.current = null;
        if (loadQueued.current) {
          loadQueued.current = false;
          void load();
        }
      },
    );
    return promise;
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestGeneration.current += 1;
    };
  }, [load, routeProjectId]);

  useRealtime(
    "control-plane-spike-context-changed",
    useCallback(() => {
      void load();
    }, [load]),
  );

  useRealtime(
    "control-plane-spike-changed",
    useCallback(
      (payload: unknown) => {
        const changedProject = payloadProjectId(payload);
        if (changedProject === activeProjectId) void load();
      },
      [activeProjectId, load],
    ),
  );

  useEffect(() => {
    const reconnected =
      connection === "connected" && previousConnection.current !== "connected";
    previousConnection.current = connection;
    if (reconnected) void load();
  }, [connection, load]);

  if (projectContextLoading) {
    return (
      <div
        className="p-6"
        role="status"
        aria-label="Loading Control Plane project"
      >
        Loading configured project…
      </div>
    );
  }
  if (projectContext?.status === "unconfigured") {
    return (
      <section
        className="flex h-full items-center justify-center p-6"
        aria-label="Control Plane Spike"
      >
        <div className="space-y-3 text-center">
          <h2 className="font-medium">No Control Plane project configured</h2>
          <p className="text-muted-foreground">
            {projectContext.error ??
              "Configure a project in plugin settings first."}
          </p>
          <button
            className="rounded border px-3 py-1"
            type="button"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }
  if (
    projectContext?.status === "missing" ||
    projectContext?.status === "error"
  ) {
    return (
      <section
        className="space-y-3 p-6"
        role="alert"
        aria-label="Control Plane project error"
      >
        <h2 className="font-medium">Control Plane project unavailable</h2>
        <p className="text-muted-foreground">{projectContext.error}</p>
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
  if (routeScopeError) {
    return (
      <section
        className="space-y-3 p-6"
        role="alert"
        aria-label="Control Plane project scope error"
      >
        <h2 className="font-medium">Wrong project route</h2>
        <p className="text-muted-foreground">{routeScopeError}</p>
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
  if (!snapshot || !activeProjectId || !projectContext?.configuredProject)
    return null;

  return (
    <section className="space-y-5 p-6" aria-label="Control Plane Spike">
      <header>
        <p className="text-sm text-muted-foreground">
          Disposable capability spike
        </p>
        <h1 className="text-xl font-semibold">Control Plane</h1>
      </header>
      {snapshot.error ? <p role="alert">{snapshot.error}</p> : null}
      <div
        className="rounded border px-3 py-2 text-sm"
        aria-label="Active Control Plane project"
      >
        <span className="text-muted-foreground">Project: </span>
        <strong>{projectContext.configuredProject.name}</strong>
        {routeProjectId === null ? (
          <span className="ml-2 text-muted-foreground">(configured)</span>
        ) : null}
      </div>
      <dl className="grid max-w-md grid-cols-2 gap-3 text-sm">
        <dt className="text-muted-foreground">Project ID</dt>
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
              {steward?.status === "error"
                ? steward.error
                : steward?.status === "missing"
                  ? "The saved Steward thread is unavailable."
                  : "Initialize a persistent Steward for this project."}
            </p>
            {steward?.status === "error" ? (
              <button
                className="rounded border px-3 py-1 text-sm"
                type="button"
                onClick={() => void load()}
              >
                Retry Steward status
              </button>
            ) : (
              <button
                className="rounded border px-3 py-1 text-sm"
                type="button"
                disabled={stewardActionPending}
                onClick={async () => {
                  const requestedProjectId = activeProjectId;
                  const requestedGeneration = requestGeneration.current;
                  setStewardActionError(null);
                  setStewardActionPending(true);
                  try {
                    const result = await rpc.call("stewardEnsure", {
                      projectId: requestedProjectId,
                    });
                    if (
                      requestGeneration.current !== requestedGeneration ||
                      activeProjectIdRef.current !== requestedProjectId
                    )
                      return;
                    if (result.status !== "ready") {
                      setSteward(result);
                      setStewardActionError(result.error);
                      return;
                    }
                    await load();
                  } catch (cause: unknown) {
                    if (
                      requestGeneration.current !== requestedGeneration ||
                      activeProjectIdRef.current !== requestedProjectId
                    )
                      return;
                    setStewardActionError(
                      cause instanceof Error
                        ? cause.message
                        : "Steward could not be initialized.",
                    );
                  } finally {
                    if (
                      requestGeneration.current === requestedGeneration &&
                      activeProjectIdRef.current === requestedProjectId
                    ) {
                      setStewardActionPending(false);
                    }
                  }
                }}
              >
                {stewardActionPending
                  ? "Checking Steward…"
                  : steward?.status === "missing"
                    ? "Repair Steward"
                    : "Initialize Steward"}
              </button>
            )}
            {stewardActionError ? (
              <p role="alert" className="text-sm text-destructive">
                {stewardActionError}
              </p>
            ) : null}
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
