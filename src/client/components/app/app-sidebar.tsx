import { LayoutDashboard, Mail } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@client/components/ui/sidebar";
import { NavUser } from "@client/components/app/nav-user";

const navItems = [
    { title: "Dashboard", icon: LayoutDashboard, path: "/dashboard" },
    { title: "Messages", icon: Mail, path: "/messages" },
];

export function AppSidebar() {
    const location = useLocation();
    const navigate = useNavigate();

    return (
        <Sidebar>
            <SidebarHeader>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton size="lg" asChild>
                            <a
                                href="/dashboard"
                                onClick={(event) => {
                                    event.preventDefault();
                                    navigate("/dashboard");
                                }}
                            >
                                <div className="flex aspect-square size-10 items-center justify-center bg-primary text-primary-foreground">
                                    <img src="/icon.svg" alt="App icon" className="h-10 w-10" />
                                </div>
                                <div className="grid flex-1 text-left text-sm leading-tight">
                                    <span className="truncate font-medium">Full-Stack Template</span>
                                    <span className="truncate text-xs text-muted-foreground">
                                        React + Hono
                                    </span>
                                </div>
                            </a>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupLabel>Navigation</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {navItems.map((item) => (
                                <SidebarMenuItem key={item.title}>
                                    <SidebarMenuButton
                                        isActive={location.pathname.startsWith(item.path)}
                                        onClick={() => navigate(item.path)}
                                    >
                                        <item.icon />
                                        <span>{item.title}</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
                <NavUser />
            </SidebarFooter>
        </Sidebar>
    );
}
