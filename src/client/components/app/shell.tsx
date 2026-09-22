import { Outlet, useNavigate } from "react-router";
import { useEffect } from "react";

import { SidebarInset, SidebarProvider, SidebarTrigger } from "@client/components/ui/sidebar";
import { Separator } from "@client/components/ui/separator";
import { TooltipProvider } from "@client/components/ui/tooltip";
import { AppSidebar } from "@client/components/app/app-sidebar";
import { authClient } from "@client/lib/auth-client";
import { Spinner } from "@client/components/ui/spinner";

export function AppShell() {
    const { data: session, isPending, error } = authClient.useSession();
    const navigate = useNavigate();

    useEffect(() => {
        // Only redirect to the landing page when the server has definitively
        // told us there is no authenticated session (error === null means the
        // request itself succeeded; the user is simply not logged in).
        // Also check session.user so malformed responses are never treated as a
        // valid session.
        if (!isPending && !session?.user && !error) {
            navigate("/", { replace: true });
        }
    }, [isPending, session, error, navigate]);

    if (isPending) {
        return (
            <div className="flex h-screen items-center justify-center">
                <Spinner />
            </div>
        );
    }

    if (!session || error) {
        return null;
    }

    return (
        <TooltipProvider>
            <SidebarProvider>
                <AppSidebar />
                <SidebarInset>
                    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
                        <SidebarTrigger className="-ml-1" />
                        <Separator orientation="vertical" className="mr-2 !h-4" />
                    </header>
                    <div className="flex-1 overflow-auto p-4">
                        <Outlet />
                    </div>
                </SidebarInset>
            </SidebarProvider>
        </TooltipProvider>
    );
}
