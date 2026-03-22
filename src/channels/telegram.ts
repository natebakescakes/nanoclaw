import { copyFile, mkdir, readFile, unlink } from 'fs/promises';
import path from 'path';
import https from 'https';

import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { migrateGroupJid, removeReaction, storeReaction } from '../db.js';
import { logger } from '../logger.js';
import { downloadTelegramFile, transcribeAudio } from '../whisper.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  ImageAttachment,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onGroupMigrated?: (oldJid: string, newJid: string) => void;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: {
    message_thread_id?: number;
    reply_parameters?: { message_id: number };
  } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    logger.warn('No pool bots available, falling back to main bot');
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
        );
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // If the user is replying to another message, prepend the quoted context
      // so the agent understands what the reply is about.
      if (ctx.message.reply_to_message) {
        const quoted = ctx.message.reply_to_message as any;
        const quotedSender =
          quoted.from?.first_name || quoted.from?.username || 'Unknown';
        const quotedText =
          quoted.text || quoted.caption || '[non-text message]';
        content = `[In reply to ${quotedSender}: "${quotedText}"]\n${content}`;
      }

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      // Prepend reply context if available
      let replyPrefix = '';
      if (ctx.message.reply_to_message) {
        const quoted = ctx.message.reply_to_message;
        const quotedSender =
          quoted.from?.first_name || quoted.from?.username || 'Unknown';
        const quotedText =
          quoted.text || quoted.caption || '[non-text message]';
        replyPrefix = `[In reply to ${quotedSender}: "${quotedText}"]\n`;
      }

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${replyPrefix}${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);

      let replyPrefix = '';
      if (ctx.message.reply_to_message) {
        const quoted = ctx.message.reply_to_message as any;
        const quotedSender =
          quoted.from?.first_name || quoted.from?.username || 'Unknown';
        const quotedText =
          quoted.text || quoted.caption || '[non-text message]';
        replyPrefix = `[In reply to ${quotedSender}: "${quotedText}"]\n`;
      }

      // Pick the largest photo ≤ 1280px wide, or the largest available
      const photos = ctx.message.photo;
      const photo =
        photos.find((p) => p.width <= 1280) ?? photos[photos.length - 1];

      let content = `${replyPrefix}[Photo]${caption}`;
      let images: ImageAttachment[] | undefined;

      try {
        const fileInfo = await ctx.api.getFile(photo.file_id);
        if (fileInfo.file_path) {
          const tmpFile = await downloadTelegramFile(
            this.botToken,
            fileInfo.file_path,
          );
          if (tmpFile) {
            try {
              // Save to attachments/ for later reference
              const groupDir = resolveGroupFolderPath(group.folder);
              const attachmentsDir = path.join(groupDir, 'attachments');
              await mkdir(attachmentsDir, { recursive: true });
              const ext = path.extname(fileInfo.file_path) || '.jpg';
              const fileName = `photo-${ctx.message.message_id}${ext}`;
              const destPath = path.join(attachmentsDir, fileName);
              await copyFile(tmpFile, destPath);

              // Encode as base64 for immediate vision
              const buf = await readFile(destPath);
              images = [{ base64: buf.toString('base64'), mimeType: 'image/jpeg' }];
              content = `${replyPrefix}[Photo: saved to attachments/${fileName}]${caption}`;
              logger.info({ chatJid, fileName }, 'Photo attachment saved');
            } finally {
              await unlink(tmpFile).catch(() => {});
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Photo download failed, using placeholder');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        images,
      });
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      // Prepend reply context if available
      let replyPrefix = '';
      if ((ctx.message as any).reply_to_message) {
        const quoted = (ctx.message as any).reply_to_message;
        const quotedSender =
          quoted.from?.first_name || quoted.from?.username || 'Unknown';
        const quotedText =
          quoted.text || quoted.caption || '[non-text message]';
        replyPrefix = `[In reply to ${quotedSender}: "${quotedText}"]\n`;
      }

      // Attempt transcription; fall back to placeholder on any error
      let content = `${replyPrefix}[Voice message]${caption}`;
      try {
        const fileInfo = await ctx.api.getFile(ctx.message.voice.file_id);
        if (fileInfo.file_path) {
          const tmpFile = await downloadTelegramFile(
            this.botToken,
            fileInfo.file_path,
          );
          if (tmpFile) {
            try {
              const transcription = await transcribeAudio(tmpFile);
              if (transcription) {
                content = `${replyPrefix}[Voice message]: ${transcription}${caption}`;
                logger.info(
                  { chatJid, chars: transcription.length },
                  'Voice message transcribed',
                );
              }
            } finally {
              await unlink(tmpFile).catch(() => {});
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Voice transcription failed, using placeholder');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const fileName = doc?.file_name || 'document';
      const mimeType = doc?.mime_type || '';
      const lowerName = fileName.toLowerCase();
      const isPdf =
        mimeType === 'application/pdf' || lowerName.endsWith('.pdf');
      const isCsv =
        mimeType === 'text/csv' ||
        mimeType === 'application/csv' ||
        lowerName.endsWith('.csv');

      if (!isPdf && !isCsv) {
        storeNonText(ctx, `[Document: ${fileName}]`);
        return;
      }

      // PDF: download to group attachments so the agent can read it
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let replyPrefix = '';
      if (ctx.message.reply_to_message) {
        const quoted = ctx.message.reply_to_message as any;
        const quotedSender =
          quoted.from?.first_name || quoted.from?.username || 'Unknown';
        const quotedText =
          quoted.text || quoted.caption || '[non-text message]';
        replyPrefix = `[In reply to ${quotedSender}: "${quotedText}"]\n`;
      }

      const fileType = isPdf ? 'PDF' : 'CSV';
      let content = `${replyPrefix}[${fileType}: ${fileName}]${caption}`;

      try {
        const fileInfo = await ctx.api.getFile(doc!.file_id);
        if (fileInfo.file_path) {
          const tmpFile = await downloadTelegramFile(
            this.botToken,
            fileInfo.file_path,
          );
          if (tmpFile) {
            try {
              const groupDir = resolveGroupFolderPath(group.folder);
              const attachmentsDir = path.join(groupDir, 'attachments');
              await mkdir(attachmentsDir, { recursive: true });
              const destPath = path.join(attachmentsDir, fileName);
              await copyFile(tmpFile, destPath);
              if (isPdf) {
                content = `${replyPrefix}[PDF: ${fileName} — saved to attachments/${fileName}, use pdf-reader to extract text]${caption}`;
              } else {
                content = `${replyPrefix}[CSV: ${fileName} — saved to attachments/${fileName}, read with: cat attachments/${fileName}]${caption}`;
              }
              logger.info({ chatJid, fileName, fileType }, 'Attachment saved');
            } finally {
              await unlink(tmpFile).catch(() => {});
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, 'PDF download failed, using placeholder');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Detect basic group → supergroup migration
    this.bot.on('message:migrate_to_chat_id', (ctx) => {
      const oldJid = `tg:${ctx.chat.id}`;
      const newJid = `tg:${ctx.message.migrate_to_chat_id}`;
      logger.info({ oldJid, newJid }, 'Telegram group migrated to supergroup');
      try {
        migrateGroupJid(oldJid, newJid);
        this.opts.onGroupMigrated?.(oldJid, newJid);
        logger.info({ oldJid, newJid }, 'Group migration complete');
      } catch (err) {
        logger.error({ oldJid, newJid, err }, 'Group migration failed');
      }
    });

    // Handle emoji reactions (Bot API 7.0+)
    this.bot.on('message_reaction', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const messageId = ctx.messageReaction.message_id.toString();
      const newReactions = ctx.messageReaction.new_reaction;
      const oldReactions = ctx.messageReaction.old_reaction;
      const user = ctx.messageReaction.user;
      const actorChat = (ctx.messageReaction as any).actor_chat;
      const sender =
        user?.id?.toString() || actorChat?.id?.toString() || 'anonymous';
      const senderName = user?.first_name || actorChat?.title || 'Anonymous';
      const timestamp = new Date(ctx.messageReaction.date * 1000).toISOString();

      // Persist new reactions
      for (const r of newReactions) {
        if (r.type === 'emoji') {
          storeReaction({
            message_id: messageId,
            chat_jid: chatJid,
            sender,
            emoji: r.emoji,
            timestamp,
          });
        }
      }

      // Remove reactions that are no longer present
      const newEmojis = new Set(
        newReactions
          .filter((r) => r.type === 'emoji')
          .map((r) => (r as any).emoji as string),
      );
      for (const r of oldReactions) {
        if (r.type === 'emoji' && !newEmojis.has((r as any).emoji)) {
          removeReaction(messageId, chatJid, sender, (r as any).emoji);
        }
      }

      // Deliver reaction to agent as a message so it's visible in context
      const emojis = newReactions
        .filter((r) => r.type === 'emoji')
        .map((r) => (r as any).emoji as string)
        .join('');
      if (emojis) {
        this.opts.onMessage(chatJid, {
          id: `reaction-${messageId}-${sender}-${Date.now()}`,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content: `[Reaction: ${emojis} to message ${messageId}]`,
          timestamp,
          is_from_me: false,
        });
        logger.info(
          { chatJid, messageId, sender: senderName, emojis },
          'Telegram reaction received',
        );
      } else {
        logger.debug(
          { chatJid, messageId, sender: senderName },
          'Telegram reaction removed',
        );
      }
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        allowed_updates: ['message', 'message_reaction'] as any,
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const sendChunked = async (chatId: string | number) => {
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot!.api, chatId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot!.api,
            chatId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
    };

    try {
      const numericId = jid.replace(/^tg:/, '');
      await sendChunked(numericId);
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err: any) {
      // Group was upgraded to supergroup mid-flight — retry with the new chat ID
      // that Telegram returns in the error parameters.
      const newChatId: number | undefined = err?.parameters?.migrate_to_chat_id;
      if (err?.error_code === 400 && newChatId) {
        const newJid = `tg:${newChatId}`;
        logger.info(
          { jid, newJid },
          'Group migrated, retrying with new chat ID',
        );
        try {
          await sendChunked(newChatId);
          logger.info(
            { newJid, length: text.length },
            'Telegram message sent after migration',
          );
          // Trigger migration handler in case the event wasn't received yet
          this.opts.onGroupMigrated?.(jid, newJid);
          return;
        } catch (retryErr) {
          logger.error(
            { newJid, err: retryErr },
            'Failed to send Telegram message after migration',
          );
          return;
        }
      }
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendReply(jid: string, messageId: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = jid.replace(/^tg:/, '');
    const numericMsgId = parseInt(messageId, 10);
    if (isNaN(numericMsgId)) {
      logger.warn(
        { jid, messageId },
        'Invalid message ID for reply, falling back to plain send',
      );
      return this.sendMessage(jid, text);
    }

    const replyOpts = { reply_parameters: { message_id: numericMsgId } };
    const MAX_LENGTH = 4096;

    try {
      // Only the first chunk carries the reply reference; subsequent chunks are follow-ups
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, replyOpts);
      } else {
        await sendTelegramMessage(
          this.bot.api,
          numericId,
          text.slice(0, MAX_LENGTH),
          replyOpts,
        );
        for (let i = MAX_LENGTH; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info(
        { jid, messageId, length: text.length },
        'Telegram reply sent',
      );
    } catch (err) {
      // If the original message was deleted or the reply fails, fall back to a plain message
      logger.warn(
        { jid, messageId, err },
        'Telegram reply failed, falling back to plain send',
      );
      await this.sendMessage(jid, text);
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async sendReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    try {
      const numericId = parseInt(jid.replace(/^tg:/, ''), 10);
      const numericMsgId = parseInt(messageId, 10);
      if (isNaN(numericId) || isNaN(numericMsgId)) {
        logger.warn(
          { jid, messageId },
          'Invalid chat or message ID for reaction',
        );
        return;
      }
      await (this.bot.api as any).setMessageReaction(numericId, numericMsgId, [
        { type: 'emoji', emoji },
      ]);
      logger.info({ jid, messageId, emoji }, 'Telegram reaction sent');
    } catch (err) {
      logger.error(
        { jid, messageId, emoji, err },
        'Failed to send Telegram reaction',
      );
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
