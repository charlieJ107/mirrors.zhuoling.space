import useSWR from 'swr'
import { Card, CardDescription, CardHeader, CardTitle } from "@client/components/ui/card";
import {
    messageListResponseSchema,
    type MessageListResponseDto,
} from "@shared/dto/messages";

const fetcher = (url: string) =>
    fetch(url, { credentials: "include" })
        .then((res) => {
            if (!res.ok) throw new Error(`Request failed with ${res.status}`);
            return res.json();
        })
        .then((data) => messageListResponseSchema.parse(data));

export default function Messages() {
    const { data, isLoading, error } = useSWR<MessageListResponseDto>('/api/messages', fetcher)
    if (isLoading) return <div>Loading...</div>
    if (error) return <div>Error: {error.message}</div>
    if (!data) return <div>No data</div>

    return (
        <div className="max-w-3xl space-y-4">
            <div>
                <h1 className="text-2xl font-semibold">Messages</h1>
                <p className="text-sm text-muted-foreground">
                    Example API data parsed with a shared Zod DTO.
                </p>
            </div>
            <div className="grid gap-3">
                {data.messages.map((message) => (
                    <Card key={message.id}>
                        <CardHeader>
                            <CardTitle>{message.title}</CardTitle>
                            <CardDescription>{message.body}</CardDescription>
                        </CardHeader>
                    </Card>
                ))}
            </div>
        </div>
    )
}
