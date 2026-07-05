
import { Link } from "react-router-dom";
import { Settings } from "lucide-react";
import { useUser } from "@/contexts/user-context";
import { Button } from "@/components/ui/button";

export function AdminButton() {
  const { user } = useUser();

  if (!user?.isAdmin) return null;

  return (
    <Button asChild variant="ghost" size="icon-sm" className="rounded-full">
      <Link to="/admin" aria-label="Admin panel">
        <Settings className="size-4" />
      </Link>
    </Button>
  );
}
