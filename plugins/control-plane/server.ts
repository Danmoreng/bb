import type { BbPluginApi } from "@bb/plugin-sdk";
import { controlPlaneRpcContract } from "./src/contract.js";

const PLUGIN_VERSION = "0.0.1";
const DOMAIN_PACKAGE_VERSION = "0.0.1";

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(controlPlaneRpcContract, {
    ping: () => ({ ok: true as const, version: PLUGIN_VERSION }),
    diagnostics: ({ projectId }) => ({
      pluginVersion: PLUGIN_VERSION,
      domainPackage: DOMAIN_PACKAGE_VERSION,
      projectId,
      status: (projectId ? "ready" : "no-project") as "ready" | "no-project",
      message: projectId
        ? "Control Plane foundation is ready for this project."
        : "Select a project to initialize the Control Plane.",
    }),
  });

  bb.agents.configure(() => ({ tools: [], skills: [] }));
  bb.agents.contributeInstructions(() => null);

  bb.log.info("Control Plane foundation loaded");
}
