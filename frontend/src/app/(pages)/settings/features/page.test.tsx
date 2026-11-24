import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import FeaturesPage from "./page";

const state = vi.hoisted(() => ({
    updateResponseDetailsVisible: vi.fn(),
    connectorsOff: [] as string[],
}));

vi.mock("@/app/contexts/UserProfileContext", () => {
    const useUserProfile = () => ({
        profile: {
            quickActionsVisible: true,
            connectorsOff: state.connectorsOff,
        },
        loading: false,
        updateQuickActionsVisible: vi.fn(),
        updateResponseDetailsVisible: state.updateResponseDetailsVisible,
    });
    return { useUserProfile, useOptionalUserProfile: useUserProfile };
});

vi.mock("@/app/components/settings/WebSearchSection", () => ({
    WebSearchSection: () => <p>Your web search</p>,
}));

describe("FeaturesPage web search", () => {
    it("is shown, and hidden while NativeCluster has it off for everyone", () => {
        state.connectorsOff = [];
        const { unmount } = render(<FeaturesPage />);
        expect(screen.getByText("Your web search")).toBeInTheDocument();
        unmount();

        state.connectorsOff = ["websearch"];
        render(<FeaturesPage />);
        expect(screen.queryByText("Your web search")).not.toBeInTheDocument();
        expect(screen.getByRole("switch", { name: "Quick actions" })).toBeInTheDocument();
        state.connectorsOff = [];
    });
});

describe("FeaturesPage CourtListener", () => {
    it("is managed from Connectors, not here", () => {
        render(<FeaturesPage />);
        expect(screen.queryByText(/CourtListener/)).not.toBeInTheDocument();
    });
});

describe("FeaturesPage response details", () => {
    it("starts off and saves the user's choice", async () => {
        state.updateResponseDetailsVisible.mockResolvedValue(true);
        const user = userEvent.setup();
        render(<FeaturesPage />);

        const toggle = screen.getByRole("switch", { name: "Response details" });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        await user.click(toggle);
        await waitFor(() =>
            expect(state.updateResponseDetailsVisible).toHaveBeenCalledWith(true),
        );
    });
});
