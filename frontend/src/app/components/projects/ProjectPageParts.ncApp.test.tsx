import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPageHeader } from "./ProjectPageParts";

// Every header action, by its title, so a test can see which are offered.
vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: ({
        actionGroups,
    }: {
        actionGroups?: Array<Array<{ title?: string } | null>>;
    }) => (
        <div>
            {actionGroups?.flat().map((action, index) =>
                action?.title ? <span key={index}>{action.title}</span> : null,
            )}
        </div>
    ),
}));
vi.mock("@/app/components/shared/HeaderActionsMenu", () => ({
    HeaderActionsMenu: () => null,
}));
vi.mock("@/app/components/shared/DocumentUploadMenu", () => ({
    DocumentUploadMenu: () => null,
}));

function renderHeader() {
    render(
        <ProjectPageHeader
            project={{ id: "project-1", name: "Matter" } as never}
            search=""
            activeSection="documents"
            creatingReview={false}
            canManageProject
            roleKnown
            onBackToProjects={vi.fn()}
            onProjectRoot={vi.fn()}
            onOpenDetails={vi.fn()}
            onOpenMemory={vi.fn()}
            onDeleteProject={vi.fn()}
            onSearchChange={vi.fn()}
            onOpenAccess={vi.fn()}
            onNewChat={vi.fn()}
            onNewReview={vi.fn()}
        />,
    );
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("ProjectPageHeader access action", () => {
    it("offers project access", () => {
        renderHeader();
        expect(screen.getByText("Access")).toBeInTheDocument();
    });

    it("offers no access in the NativeCluster app, whose accounts are per computer", () => {
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
        renderHeader();
        expect(screen.queryByText("Access")).toBeNull();
    });
});
