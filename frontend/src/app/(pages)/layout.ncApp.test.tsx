import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MikeLayout from "./layout";

const state = vi.hoisted(() => ({
    push: vi.fn(),
    retrySession: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    usePathname: () => "/assistant",
    useRouter: () => ({ push: state.push }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        authLoading: false,
        isAuthenticated: false,
        retrySession: state.retrySession,
    }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    ChatHistoryProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/app/components/shared/AppSidebar", () => ({ AppSidebar: () => <aside>Sidebar</aside> }));
vi.mock("@/app/components/site-logo", () => ({ SiteLogo: () => <div>Mike</div> }));

beforeEach(() => {
    state.push.mockReset();
    state.retrySession.mockReset().mockResolvedValue(null);
});
afterEach(() => {
    vi.unstubAllEnvs();
});

it("sends nobody to a login page in the NativeCluster app: NativeCluster signs people in", async () => {
    vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
    render(<MikeLayout><p>Workspace</p></MikeLayout>);
    expect(screen.getByText("Sign in to NativeCluster to use Mike.")).toBeInTheDocument();
    expect(screen.queryByText("Workspace")).toBeNull();
    expect(state.push).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Check again" }));
    expect(state.retrySession).toHaveBeenCalledTimes(1);
});

it("still sends a signed-out visitor to the login page elsewhere", () => {
    render(<MikeLayout><p>Workspace</p></MikeLayout>);
    expect(state.push).toHaveBeenCalledWith("/login");
    expect(screen.queryByText("Sign in to NativeCluster to use Mike.")).toBeNull();
});
