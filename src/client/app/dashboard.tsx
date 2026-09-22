import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardDescription } from "@client/components/ui/card";
import { authClient } from "@client/lib/auth-client";

export default function Dashboard() {
    const { data: session } = authClient.useSession();
    type MeResponse = { user: { name?: string; email?: string } };
    const [me, setMe] = useState<MeResponse | null>(null);

    useEffect(() => {
        if (!session) return;
        fetch("/api/me", { credentials: "include" })
            .then((res) => (res.ok ? res.json() : Promise.resolve(null)))
            .then((data) => setMe(data as MeResponse | null))
            .catch(() => setMe(null));
    }, [session]);

    return (
        <Card className="max-w-2xl">
            <CardHeader>
                <CardTitle>Welcome, {session?.user.name ?? session?.user.email ?? "User"}</CardTitle>
                <CardDescription>
                    This page is protected by the shared app shell.
                </CardDescription>
            </CardHeader>
            <div className="p-4 pt-0 space-y-2 text-sm">
                <p>
                    <strong>Session user:</strong>{" "}
                    {session?.user.email ?? session?.user.id}
                </p>
                {me?.user && (
                    <p>
                        <strong>From /api/me:</strong>{" "}
                        {me.user.name ?? me.user.email ?? "-"}
                    </p>
                )}
            </div>
        </Card>
    );
}
