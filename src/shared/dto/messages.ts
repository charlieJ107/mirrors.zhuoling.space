import { z } from "zod";

export const messageSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
});

export const messageListResponseSchema = z.object({
  messages: z.array(messageSchema),
});

export type MessageDto = z.infer<typeof messageSchema>;
export type MessageListResponseDto = z.infer<typeof messageListResponseSchema>;
