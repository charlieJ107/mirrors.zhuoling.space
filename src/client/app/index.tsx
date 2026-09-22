import { Link } from "react-router"
import { Button } from "@client/components/ui/button"
import { Card, CardHeader, CardTitle, CardDescription } from "@client/components/ui/card"
import { ChartColumn, Users, Shield } from "lucide-react"

export default function Index() {
    return (
        <div className="min-h-screen bg-background">
            <div className="border-b bg-card">
                <div className="container mx-auto px-4 py-6">
                    <div className="flex items-center justify-between">
                        <h1 className="text-2xl font-bold">Full-Stack Template</h1>
                        <div className="flex gap-2">
                            <Button asChild>
                                <Link to="/sign-in">Sign In</Link>
                            </Button>
                        </div>
                    </div>
                </div>
            </div>

            <div className="container mx-auto px-4 py-16">
                <div className="max-w-3xl mx-auto text-center mb-16">
                    <h2 className="text-4xl font-bold mb-4 text-balance">React + Hono on Cloudflare</h2>
                    <p className="text-xl text-muted-foreground text-pretty">
                        A same-origin starter with authentication, shared DTOs, and dual Cloudflare/Node runtimes.
                    </p>
                </div>

                <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
                    <Card>
                        <CardHeader>
                            <ChartColumn className="h-10 w-10 text-primary mb-2" />
                            <CardTitle>Typed API</CardTitle>
                            <CardDescription>Hono routes with shared DTO contracts.</CardDescription>
                        </CardHeader>
                    </Card>

                    <Card>
                        <CardHeader>
                            <Users className="h-10 w-10 text-primary mb-2" />
                            <CardTitle>Authentication</CardTitle>
                            <CardDescription>OIDC sign-in via auth.zhuoling.space.</CardDescription>
                        </CardHeader>
                    </Card>

                    <Card>
                        <CardHeader>
                            <Shield className="h-10 w-10 text-primary mb-2" />
                            <CardTitle>Portable Runtime</CardTitle>
                            <CardDescription>Deploy to Cloudflare Workers or a Node server.</CardDescription>
                        </CardHeader>
                    </Card>
                </div>

                <div className="text-center mt-12">
                    <Button size="lg" asChild>
                        <Link to="/sign-in">Get Started</Link>
                    </Button>
                </div>
            </div>
        </div>
    )
}
