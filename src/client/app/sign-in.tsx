import { useState } from "react";
import { Button } from "@client/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription } from "@client/components/ui/card";
import { authClient } from "@client/lib/auth-client";

export default function SignIn() {
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSignIn = async () => {
        setError(null);
        setLoading(true);
        // Redirect-based OIDC flow against auth.zhuoling.space. On success the
        // browser navigates away, so only a pre-redirect error reaches setError.
        const { error: err } = await authClient.signIn.social({
            provider: "zhuoling",
            callbackURL: "/dashboard",
        });
        if (err) {
            setError(err.message ?? "Sign-in failed");
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle>Sign In</CardTitle>
                    <CardDescription>
                        Sign in with your Zhuoling.Space account.
                    </CardDescription>
                </CardHeader>
                <div className="p-4 pt-0 space-y-4">
                    {error && (
                        <p className="text-sm text-destructive">{error}</p>
                    )}
                    <Button className="w-full" disabled={loading} onClick={handleSignIn}>
                        {loading ? "Redirecting…" : "Sign in with Zhuoling.Space"}
                    </Button>
                    <p className="text-center text-sm text-muted-foreground">
                        Accounts are managed at auth.zhuoling.space.
                    </p>
                </div>
            </Card>
        </div>
    );
}
