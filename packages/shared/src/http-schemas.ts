import { z } from "zod";

import { AuthRoleSchema } from "./auth.js";

export const SetupClaimRequestSchema = z.object({
  setupToken: z.string().trim().min(1),
});

export const CreateInvitationRequestSchema = z.object({
  email: z.string().trim().min(3).includes("@"),
  role: AuthRoleSchema,
});

export type SetupClaimRequest = z.infer<typeof SetupClaimRequestSchema>;
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;
