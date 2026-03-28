import { z } from "zod";
export const MessagesQuerySchema = z.object({
    channelId: z.string().min(1),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).default(50),
});
export const ThreadQuerySchema = z.object({
    parentMessageId: z.string().min(1),
    limit: z.number().int().min(1).max(200).default(50),
});
export const SendMessageInputSchema = z.object({
    channelId: z.string().min(1),
    content: z.string().trim().min(1).max(4000),
    parentMessageId: z.string().min(1).optional(),
});
export const EditMessageInputSchema = z.object({
    messageId: z.string().min(1),
    content: z.string().trim().min(1).max(4000),
});
export const DeleteMessageInputSchema = z.object({
    messageId: z.string().min(1),
});
export const ToggleReactionInputSchema = z.object({
    messageId: z.string().min(1),
    emoji: z.string().min(1).max(64),
});
