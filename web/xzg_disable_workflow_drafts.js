import { app } from "../../scripts/app.js";
import { installWorkflowDraftStorage } from "./lib/xzg_workflow_draft_storage.mjs";

// Keep the filename to replace the earlier disable-persistence workaround.
const ready = installWorkflowDraftStorage().catch(error => {
    console.error("[XZG] Could not initialize workflow draft storage", error);
    return false;
});
await ready;

app.registerExtension({
    name: "XZG.WorkflowDraftStorage",
    async init() {
        if (!await ready) return;
        // Repair the setting disabled by the previous workaround.
        const settings = app.ui?.settings;
        if (typeof settings?.setSettingValue === "function") {
            await settings.setSettingValue("Comfy.Workflow.Persist", true);
        } else {
            await app.extensionManager?.setting?.set?.("Comfy.Workflow.Persist", true);
        }
    },
});
