import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@client/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription } from "@client/components/ui/card";
import { Input } from "@client/components/ui/input";
import { authClient } from "@client/lib/auth-client";

export default function SignIn() {
    const navigate = useNavigate();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setLoading(true);
        const { error: err } = await authClient.signIn.email(
            { email, password, callbackURL: "/dashboard" },
            {
                onRequest: () => setLoading(true),
                onSuccess: () => navigate("/dashboard"),
                onError: (ctx) => {
                    setError(ctx.error.message);
                    setLoading(false);
                },
            }
        );
        if (err) setLoading(false);
    };

    return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle>Sign In</CardTitle>
                    <CardDescription>
                        Sign in with your email and password.
                    </CardDescription>
                </CardHeader>
                <form onSubmit={handleSubmit} className="p-4 pt-0 space-y-4">
                    {error && (
                        <p className="text-sm text-destructive">{error}</p>
                    )}
                    <div>
                        <label
                            htmlFor="email"
                            className="block text-sm font-medium mb-1"
                        >
                            Email
                        </label>
                        <Input
                            id="email"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            autoComplete="email"
                        />
                    </div>
                    <div>
                        <label
                            htmlFor="password"
                            className="block text-sm font-medium mb-1"
                        >
                            Password
                        </label>
                        <Input
                            id="password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            autoComplete="current-password"
                        />
                    </div>
                    <Button type="submit" className="w-full" disabled={loading}>
                        {loading ? "Signing in…" : "Sign In"}
                    </Button>
                    <p className="text-center text-sm text-muted-foreground">
                        Don&apos;t have an account?{" "}
                        <Link to="/sign-up" className="text-primary underline">
                            Sign up
                        </Link>
                    </p>
                </form>
            </Card>
        </div>
    );
}
