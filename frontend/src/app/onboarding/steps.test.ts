import { afterEach, describe, expect, it, vi } from "vitest";
import {
    onboardingStepLabel,
    pathAfterPractice,
    pathBeforeModels,
} from "./steps";

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("onboarding steps", () => {
    it("count four screens, invitations third, everywhere but the NativeCluster app", () => {
        expect(onboardingStepLabel("profile")).toBe("Step 1 of 4");
        expect(onboardingStepLabel("practice")).toBe("Step 2 of 4");
        expect(onboardingStepLabel("invitations")).toBe("Step 3 of 4");
        expect(onboardingStepLabel("models")).toBe("Step 4 of 4");
        expect(pathAfterPractice()).toBe("/onboarding/invitations");
        expect(pathBeforeModels()).toBe("/onboarding/invitations");
    });

    it("leave out organization invitations in the NativeCluster app, whose accounts are per computer", () => {
        vi.stubEnv("NEXT_PUBLIC_MIKE_NC_APP", "1");
        expect(onboardingStepLabel("profile")).toBe("Step 1 of 3");
        expect(onboardingStepLabel("practice")).toBe("Step 2 of 3");
        expect(onboardingStepLabel("models")).toBe("Step 3 of 3");
        expect(pathAfterPractice()).toBe("/onboarding/models");
        expect(pathBeforeModels()).toBe("/onboarding/practice");
    });
});
