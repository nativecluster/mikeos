// MikeOSS 2.1.0.1 in NativeCluster's Store: a person's first message in a
// fresh install was refused ("Select a model: choose a model before sending
// your message"), since upstream has no default model and nobody had picked
// one. In the NativeCluster app a chat with no saved model starts with the
// first model NativeCluster offers for the assistant.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getNativeClusterModels } from "@/app/lib/mikeApi";
import { resetNativeClusterModels } from "@/app/hooks/useNativeClusterModels";
import { ChatInput } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", () => ({
    listWorkflows: vi.fn(async () => []),
    uploadProjectDocument: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
    getNativeClusterModels: vi.fn(),
}));
vi.mock("@/app/hooks/useConfiguredModels", () => ({
    useConfiguredModels: () => [],
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            openRouterModels: [],
            vercelModels: [],
            openCodeGoModels: [],
            lastSelectedChatModel: null,
            lastSelectedReasoningLevel: null,
            apiKeys: undefined,
        },
        loading: false,
        apiKeysDegraded: false,
        persistChatModelSelection: vi.fn(async () => true),
        persistChatReasoningSelection: vi.fn(async () => true),
    }),
}));
vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(),
    isModelAvailable: vi.fn(() => true),
}));
vi.mock("./AddDocButton", () => ({ AddDocButton: () => null }));
vi.mock("./UploadOverlay", () => ({ UploadOverlay: () => null }));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: () => null,
}));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: () => null,
}));
vi.mock("./ModelToggle", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./ModelToggle")>()),
    ModelToggle: () => null,
}));

class ResizeObserverMock {
    observe() {}
    disconnect() {}
}

describe("ChatInput in the NativeCluster app, nothing picked yet", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetNativeClusterModels();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    });

    it("sends the first message with the first model NativeCluster offers", async () => {
        vi.mocked(getNativeClusterModels).mockResolvedValue({
            inferenceOnly: true,
            models: [
                { id: "nativecluster/qwen3.8:27b", label: "qwen3.8:27b", group: "NativeCluster" },
                { id: "nativecluster/gemma4:26b-a4b", label: "gemma4:26b-a4b", group: "NativeCluster" },
            ],
        });
        const onSubmit = vi.fn();
        const user = userEvent.setup();
        render(<ChatInput onSubmit={onSubmit} onCancel={vi.fn()} isLoading={false} />);

        await waitFor(() => expect(getNativeClusterModels).toHaveBeenCalled());
        await user.type(screen.getByRole("combobox"), "hello who are you what can you do");
        await user.keyboard("{Enter}");

        await waitFor(() =>
            expect(onSubmit).toHaveBeenCalledWith(
                expect.objectContaining({ model: "nativecluster/qwen3.8:27b" }),
            ),
        );
        expect(screen.queryByText("Choose a model before sending your message.")).toBeNull();
    });

    it("outside the app, still asks for a model as upstream does", async () => {
        vi.mocked(getNativeClusterModels).mockResolvedValue({ inferenceOnly: false, models: [] });
        const onSubmit = vi.fn();
        const user = userEvent.setup();
        render(<ChatInput onSubmit={onSubmit} onCancel={vi.fn()} isLoading={false} />);

        await user.type(screen.getByRole("combobox"), "hello");
        await user.keyboard("{Enter}");

        expect(onSubmit).not.toHaveBeenCalled();
        expect(await screen.findByText("Choose a model before sending your message.")).toBeInTheDocument();
    });
});
