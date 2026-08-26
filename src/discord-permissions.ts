/**
 * Expiring state for Discord permission prompts.
 *
 * A prompt is automatically denied after a bounded wait and its buttons are
 * removed. Manual delivery failures can restore a claimed entry without
 * extending its original deadline.
 */

import {
  ExpiringPermissions,
  type ExpiringPermissionClaim,
} from "./expiring-permissions.js";

export const DEFAULT_DISCORD_PERMISSION_TTL_MS = 5 * 60 * 1_000;

export interface DiscordPermissionPrompt {
  content: string;
  edit(options: {
    content: string;
    components: [];
  }): Promise<unknown>;
}

export interface PendingDiscordPermission {
  tool_name: string;
  description: string;
  input_preview: string;
  promptMessage?: DiscordPermissionPrompt;
}

export type PendingDiscordPermissionClaim =
  ExpiringPermissionClaim<PendingDiscordPermission>;

export interface PendingDiscordPermissionsOptions {
  ttlMs?: number;
  sendDeny: (requestId: string) => Promise<boolean>;
  onError?: (error: unknown) => void;
  now?: () => number;
}

export class PendingDiscordPermissions
  extends ExpiringPermissions<PendingDiscordPermission> {
  constructor(options: PendingDiscordPermissionsOptions) {
    super({
      ttlMs: options.ttlMs ?? DEFAULT_DISCORD_PERMISSION_TTL_MS,
      sendDeny: options.sendDeny,
      onError: options.onError,
      now: options.now,
      updateExpiredPrompt: async ({ permission }, delivered) => {
        const promptMessage = permission.promptMessage;
        if (!promptMessage) return;

        const status = delivered
          ? "⌛ 응답 시간이 지나 자동 거부되었습니다."
          : "⚠️ 권한 요청이 만료되었지만 agent에 거부 응답을 전달하지 못했습니다.";
        await promptMessage.edit({
          content: `${promptMessage.content}\n\n${status}`,
          components: [],
        });
      },
    });
  }
}
