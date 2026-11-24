import { isNcApp } from "@/app/lib/ncApp";

type OnboardingStep = "profile" | "practice" | "invitations" | "models";

const ALL_STEPS: readonly OnboardingStep[] = [
    "profile",
    "practice",
    "invitations",
    "models",
];

/**
 * The onboarding screens in order. The NativeCluster app has no organization
 * invitations (accounts are per computer, and sharing with the group is not
 * available there yet), so its onboarding leaves that screen out.
 */
function onboardingSteps(): readonly OnboardingStep[] {
    return isNcApp()
        ? ALL_STEPS.filter((step) => step !== "invitations")
        : ALL_STEPS;
}

/** "Step 2 of 4", counted over the screens this build shows. */
export function onboardingStepLabel(step: OnboardingStep): string {
    const steps = onboardingSteps();
    const index = steps.indexOf(step);
    return `Step ${index + 1} of ${steps.length}`;
}

/** Where the practice screen's Continue and Skip go. */
export function pathAfterPractice(): string {
    return isNcApp() ? "/onboarding/models" : "/onboarding/invitations";
}

/** Where the models screen's Back goes. */
export function pathBeforeModels(): string {
    return isNcApp() ? "/onboarding/practice" : "/onboarding/invitations";
}
