import { describe, expect, it } from "vitest";
import { CONNECTOR_PRESETS, offeredConnectorPresets } from "./connectorPresets";

describe("the presets offered", () => {
    it("are every preset where nothing needs a client configured", () => {
        expect(offeredConnectorPresets([])).toEqual(CONNECTOR_PRESETS);
    });

    it("leave out a preset whose provider cannot link here, and only that one", () => {
        expect(offeredConnectorPresets(["google", "slack"]).map((preset) => preset.name)).toEqual([
            "Notion",
            "Airtable",
            "Linear",
            "Lawve",
            "Legal Data Hunter",
        ]);
    });

    it("name Slack by the backend's provider id, the one preset with no dynamic client registration", () => {
        expect(CONNECTOR_PRESETS.filter((preset) => preset.provider)).toEqual([
            { name: "Slack", serverUrl: "https://mcp.slack.com/mcp", provider: "slack" },
        ]);
    });
});
