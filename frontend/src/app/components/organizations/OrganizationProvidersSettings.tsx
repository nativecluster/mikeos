"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { OrganizationSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { EmptyState } from "@/app/components/ui/empty-state";
import { isOrgAdmin } from "@/app/lib/permissions";
import { PillButtonUI } from "@mike/ui";
import { useNativeClusterModels } from "@/app/hooks/useNativeClusterModels";
import { OrganizationProviderKeys } from "./OrganizationProviderKeys";
import {
  organizationSettingsHref,
  useOrganizationSettings,
} from "./OrganizationSettingsShell";

/**
 * The Bring Your Own Keys section of an organization's settings: its owners'
 * and admins' alone. The section is not offered to a member, and one who
 * follows a link to it is told why rather than shown controls that the
 * server would refuse.
 */
export function OrganizationProvidersSettings() {
  const router = useRouter();
  const { orgId, org } = useOrganizationSettings();
  // Where every model call goes to NativeCluster there are no provider
  // keys; an old link opens the organization's General page.
  const { inferenceOnly } = useNativeClusterModels();
  useEffect(() => {
    if (inferenceOnly) router.replace(organizationSettingsHref(orgId));
  }, [inferenceOnly, orgId, router]);
  if (inferenceOnly) return null;

  if (org && !isOrgAdmin(org.role))
    return (
      <EmptyState
        icon={<OrganizationSkeuoIcon />}
        title="Bring Your Own Keys"
        description="Only this organization's owners and admins can manage its keys."
        action={
          <PillButtonUI
            tone="white"
            size="sm"
            onClick={() => router.push(organizationSettingsHref(orgId))}
          >
            Back to General
          </PillButtonUI>
        }
      />
    );

  // Mounted before the role is known, so its cards load alongside the
  // organization rather than after it. It reads the caller's rights itself.
  return (
    <OrganizationProviderKeys
      orgId={orgId}
      orgName={org?.name ?? "Organization"}
    />
  );
}
