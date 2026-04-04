import { RequireAdminLogin } from "@/components/app-route-guards";
import { PlatformSettings } from "@/components/platform-settings";

export default function SettingsPage() {
  return (
    <RequireAdminLogin>
      <PlatformSettings />
    </RequireAdminLogin>
  );
}
