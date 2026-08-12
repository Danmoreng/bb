import { useEffect, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useRpc,
} from "@bb/plugin-sdk/app";
import { controlPlaneRpcContract } from "./src/contract.js";

function DiagnosticsPanel() {
  const { projectId } = useBbContext();
  const rpc = useRpc<typeof controlPlaneRpcContract>();
  const [message, setMessage] = useState("Loading Control Plane…");

  useEffect(() => {
    let active = true;
    void rpc.call("diagnostics", { projectId }).then((result) => {
      if (active) setMessage(result.message);
    }).catch((error: unknown) => {
      if (active) setMessage(error instanceof Error ? error.message : "Control Plane unavailable");
    });
    return () => { active = false; };
  }, [projectId, rpc]);

  return (
    <section className="space-y-3 p-6" aria-label="Control Plane diagnostics">
      <p className="text-sm text-muted-foreground">Production Control Plane foundation</p>
      <h1 className="text-xl font-semibold">Control Plane</h1>
      <p role="status">{message}</p>
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "control-plane",
    title: "Control Plane",
    icon: "Workflow",
    path: "control-plane",
    component: DiagnosticsPanel,
  });
});
