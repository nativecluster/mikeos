"use client";

import { useOptionalUserProfile } from "@/app/contexts/UserProfileContext";
import type { NcConnectorPlane } from "@/app/lib/ncApp";

/**
 * The connectors NativeCluster turned off for everyone (Mike's app: a net
 * plane's off switch at 0), from the profile. `loading` holds while the
 * profile has not answered yet, so a page does not show a connector only to
 * hide it a moment later. Outside a profile provider nothing is off.
 */
export function useConnectorsOff(): {
    off: (plane: NcConnectorPlane) => boolean;
    loading: boolean;
} {
    const context = useOptionalUserProfile();
    const planes = context?.profile?.connectorsOff ?? [];
    return {
        off: (plane) => planes.includes(plane),
        loading: !!context && !context.profile && context.loading,
    };
}
