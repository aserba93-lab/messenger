import { z } from "zod";
export const DirectChatMessagesInputSchema = z.object({
    directChatId: z.string().min(1),
    limit: z.number().int().min(1).max(200).default(50),
});
export const SendDirectMessageInputSchema = z.object({
    userId: z.string().min(1),
    content: z.string().trim().min(1).max(4000),
    parentMessageId: z.string().min(1).optional(),
});
