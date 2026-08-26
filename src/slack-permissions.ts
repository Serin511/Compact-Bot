/**
 * Expiring state for Slack permission prompts.
 *
 * A prompt is automatically denied after a bounded wait and its Block Kit
 * actions are removed. Manual delivery failures can restore a claimed entry
 * without extending its original deadline.
 */

import {
  ExpiringPermissions,
  type ExpiringPermissionClaim,
} from "./expiring-permissions.js";

export const DEFAULT_SLACK_PERMISSION_TTL_MS = 5 * 60 * 1_000;

export interface PendingSlackPermission {
  tool_name: string;
  description: string;
  input_preview: string;
  channelId?: string;
  promptTs?: string;
  promptText?: string;
}

export type PendingSlackPermissionClaim =
  ExpiringPermissionClaim<PendingSlackPermission>;

export interface SlackPermissionPromptUpdate {
  channel: string;
  ts: string;
  text: string;
  blocks: [];
}

export interface PendingSlackPermissionsOptions {
  ttlMs?: number;
  sendDeny: (requestId: string) => Promise<boolean>;
  updatePrompt: (update: SlackPermissionPromptUpdate) => Promise<unknown>;
  onError?: (error: unknown) => void;
  now?: () => number;
}

export class PendingSlackPermissions
  extends ExpiringPermissions<PendingSlackPermission> {
  constructor(options: PendingSlackPermissionsOptions) {
    super({
      ttlMs: options.ttlMs ?? DEFAULT_SLACK_PERMISSION_TTL_MS,
      sendDeny: options.sendDeny,
      onError: options.onError,
      now: options.now,
      updateExpiredPrompt: async ({ permission }, delivered) => {
        if (
          !permission.channelId ||
          !permission.promptTs ||
          !permission.promptText
        ) {
          return;
        }

        const status = delivered
          ? ":hourglass_flowing_sand: 응답 시간이 지나 자동 거부되었습니다."
          : ":warning: 권한 요청이 만료되었지만 agent에 거부 응답을 전달하지 못했습니다.";
        await options.updatePrompt({
          channel: permission.channelId,
          ts: permission.promptTs,
          text: `${permission.promptText}\n\n${status}`,
          blocks: [],
        });
      },
    });
  }
}
