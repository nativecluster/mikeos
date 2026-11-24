import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeClusterModelOptions } from "@mike/client";
import { ModelToggle } from "./ModelToggle";
import type { ApiKeyState } from "@/app/lib/mikeApi";
import type { NativeClusterState } from "@/app/hooks/useNativeClusterModels";

const { nativeCluster } = vi.hoisted(() => ({
    nativeCluster: { models: [], inferenceOnly: false } as NativeClusterState,
}));

vi.mock("@/app/hooks/useOllamaModels", () => ({
    useOllamaModels: () => [
        { id: "ollama/llama3.2", label: "llama3.2 (local)", group: "Local" },
    ],
}));
vi.mock("@/app/hooks/useConfiguredModels", () => ({
    useConfiguredModels: () => [],
}));
vi.mock("@/app/hooks/useNativeClusterModels", () => ({
    useNativeClusterModels: () => nativeCluster,
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    PERSONAL_WORKSPACE: "personal",
    useWorkspace: () => ({ workspaceId: "personal" }),
}));

const CLAUDE_KEY = {
    claude: { configured: true, source: "user" },
} as unknown as ApiKeyState;

beforeEach(() => {
    nativeCluster.models = nativeClusterModelOptions([
        { id: "nativecluster/qwen3.8:27b" },
        { id: "nativecluster/gemma4:4b" },
    ]);
    nativeCluster.inferenceOnly = false;
});

describe("ModelToggle with NativeCluster", () => {
    it("offers NativeCluster's models beside the others, with no key", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(
            <ModelToggle
                value=""
                onChange={onChange}
                apiKeys={CLAUDE_KEY}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));
        expect(
            screen.getByRole("menuitem", { name: "Anthropic" }),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("menuitem", { name: "NativeCluster" }));
        await user.click(screen.getByRole("menuitem", { name: /Qwen3\.8/ }));
        expect(onChange).toHaveBeenCalledWith("nativecluster/qwen3.8:27b");
    });

    it("offers nothing else where every model call goes to NativeCluster", async () => {
        nativeCluster.inferenceOnly = true;
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="nativecluster/gemma4:4b"
                onChange={vi.fn()}
                apiKeys={CLAUDE_KEY}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));
        const groups = screen
            .getAllByRole("menuitem")
            .filter((row) => row.hasAttribute("aria-expanded"))
            .map((row) => row.textContent);
        expect(groups).toEqual(["NativeCluster"]);
        const rows = screen
            .getAllByRole("menuitem")
            .filter((row) => !row.hasAttribute("aria-expanded"))
            .map((row) => row.textContent ?? "");
        expect(rows).toHaveLength(2);
        expect(rows.join(" ")).toMatch(/Qwen3\.8/);
        expect(rows.join(" ")).toMatch(/Gemma4/);
        expect(rows.join(" ")).not.toMatch(/Claude|llama/i);
    });

    it("points an empty picker at NativeCluster, not at keys", async () => {
        nativeCluster.inferenceOnly = true;
        nativeCluster.models = [];
        const user = userEvent.setup();
        const onNoModelsClick = vi.fn();
        render(
            <ModelToggle
                value=""
                onChange={vi.fn()}
                apiKeys={CLAUDE_KEY}
                onNoModelsClick={onNoModelsClick}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "No models available" }),
        );
        expect(onNoModelsClick).toHaveBeenCalledWith("nativecluster");
    });
});
