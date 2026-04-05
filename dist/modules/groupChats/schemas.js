import { z } from "zod";
export const CreateGroupChatInputSchema = z.object({
    name: z.string().min(1).max(120),
    memberIds: z.array(z.string().min(1)).min(1).max(200),
});
export const GroupChatMessagesInputSchema = z.object({
    groupChatId: z.string().min(1),
    limit: z.number().int().min(1).max(500).default(50),
});
export const SendGroupChatMessageInputSchema = z.object({
    groupChatId: z.string().min(1),
    content: z.string().trim().min(1).max(4000),
    parentMessageId: z.string().min(1).optional(),
});
