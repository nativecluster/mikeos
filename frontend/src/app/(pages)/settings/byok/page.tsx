"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { OrganizationProviderKeys } from "@/app/components/organizations/OrganizationProviderKeys";
import { ManagedByOrganization } from "@/app/components/settings/ManagedByOrganization";
import { PersonalProviderKeys } from "@/app/components/settings/PersonalProviderKeys";
import { useWorkspaceSettingsScope } from "@/app/hooks/useWorkspaceSettingsScope";
import { WorkspaceScopePending } from "@/app/components/settings/WorkspaceScopePending";
import { useNativeClusterModels } from "@/app/hooks/useNativeClusterModels";

/**
 * Settings > Bring Your Own Keys: the keys work in the active workspace runs
 * on. Personal work runs on the caller's own; work in an organization runs on
 * the organization's, which its owners and admins manage here as they can in
 * its settings.
 */
export default function ByokPage() {
    const scope = useWorkspaceSettingsScope();
    // Where every model call goes to NativeCluster there are no provider
    // keys to bring; an old link opens Model Preferences.
    const { inferenceOnly } = useNativeClusterModels();
    if (inferenceOnly) return <OpenModelPreferences />;
    if (scope.kind === "loading" || scope.kind === "unavailable")
      return <WorkspaceScopePending unavailable={scope.kind === "unavailable"} />;
    if (scope.kind === "managed")
        return (
            <ManagedByOrganization
                subject="Model provider keys"
                orgName={scope.orgName}
            />
        );
    if (scope.kind === "organization")
        return (
            <OrganizationProviderKeys
                key={scope.orgId}
                orgId={scope.orgId}
                orgName={scope.orgName}
            />
        );
    return <PersonalProviderKeys />;
}

function OpenModelPreferences() {
    const router = useRouter();
    useEffect(() => {
        router.replace("/settings/models");
    }, [router]);
    return <WorkspaceScopePending unavailable={false} />;
}
